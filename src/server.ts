// The HTTP server: routing, auth, body reading and JSON replies. One process
// serving git smart HTTP, REST v3, GraphQL and MCP from the same store.
//
// Auth: the trial token lives in MAKEFUN_SHOP_TOKEN; every API call must
// present it as `Authorization: Bearer <token>`, and a request without it is
// 401. (Without the variable — local development — any non-empty bearer is
// accepted, so the local runner can pick its own token.) Git smart HTTP takes
// no auth: the suite's git client may or may not present the token, and no
// check tests unauthenticated git access.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';
import type { ApiResponse } from './util.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const DEV_MODE = EXPECTED_TOKEN === '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Whether this request carries the trial token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (DEV_MODE) return true;
  return token === EXPECTED_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendApi(res: ServerResponse, response: ApiResponse, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(response.headers ?? {}) };
  if (response.status === 204) {
    res.writeHead(204, { 'content-type': JSON_TYPE, ...headers });
    res.end();
    return;
  }
  sendJson(res, response.status, response.body, headers);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      // Every reply carries the request id, including 401s and 404s.
      res.setHeader('x-github-request-id', requestId);
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);
      const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
      try {
        // ---- health probe (no auth) ---------------------------------------
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- git smart HTTP (no auth) --------------------------------------
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
          const endpoint = gitMatch[3] as string;
          const gitProtocol = req.headers['git-protocol'];
          const version = typeof gitProtocol === 'string' ? gitProtocol : undefined;
          if (endpoint === 'info/refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            const answer = handleInfoRefs(store, owner, repoName, service, version);
            res.writeHead(answer.status, {
              'content-type': answer.contentType,
              'content-length': answer.body.length,
            });
            res.end(answer.body);
            return;
          }
          if (endpoint === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const answer = handleUploadPack(store, owner, repoName, raw, version);
            res.writeHead(answer.status, {
              'content-type': answer.contentType,
              'content-length': answer.body.length,
            });
            res.end(answer.body);
            return;
          }
          if (endpoint === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const answer = handleReceivePack(store, owner, repoName, raw);
            res.writeHead(answer.status, {
              'content-type': answer.contentType,
              'content-length': answer.body.length,
            });
            res.end(answer.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // ---- the API surfaces need the token ------------------------------
        if (path === '/api/graphql' || path === '/mcp' || path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            if (path === '/mcp') {
              sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
            } else {
              sendJson(res, 401, { message: 'Unauthorized' });
            }
            return;
          }
        }

        // ---- REST v3 -------------------------------------------------------
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map(decodeSegment);
          const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let body: unknown = {};
          if (raw.length > 0) {
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendApi(res, { status: 400, body: { message: `malformed JSON body: ${parsed.error}` } }, requestId);
              return;
            }
            body = parsed.value;
          }
          const answer = handleRest(store, method, segments, query, body, baseUrl);
          sendApi(res, answer, requestId);
          return;
        }

        // ---- GraphQL -------------------------------------------------------
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendApi(res, { status: 404, body: { message: 'Not Found' } }, requestId);
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendApi(res, { status: 400, body: { errors: [{ message: `malformed JSON body: ${parsed.error}` }] } }, requestId);
            return;
          }
          const answer = handleGraphql(store, parsed.value);
          sendApi(res, answer, requestId);
          return;
        }

        // ---- MCP -----------------------------------------------------------
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'content-type': JSON_TYPE });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
            return;
          }
          const raw = await readBody(req);
          const answer = handleMcp(store, raw.toString('utf8'), baseUrl);
          if (answer.status === 202) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash on a request, and never answer HTML.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do.
          }
        }
      }
    })();
  });
}
