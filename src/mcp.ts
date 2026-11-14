// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable
// HTTP, answering plain JSON. It speaks the current revision (2026-07-28)
// through server/discover, and the handshake revisions (2025-11-25 and
// earlier) through initialize + notifications/initialized. The tools act on
// the same store as REST, so a repository or issue created here reads back
// over /api/v3 as the same object.

import {
  issueView,
  pullView,
  repoView,
  VIEWER_LOGIN,
  type Repo,
  type Store,
} from './store.ts';
import type { ApiResponse } from './util.ts';

export const MCP_SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: readonly string[];
  };
  readonly run: (store: Store, args: Record<string, unknown>, baseUrl: string) => unknown;
}

/** Split owner/repo out of the arguments, accepting full_name as a fallback. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (typeof args.repository === 'string' && repo === '') repo = args.repository;
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  if ((owner === '' || repo === '') && fullName.includes('/')) {
    const [head, ...tail] = fullName.split('/');
    if (owner === '') owner = head ?? '';
    if (repo === '') repo = tail.join('/');
  }
  return { owner, repo };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function toolError(message: string): { isError: true; content: { type: 'text'; text: string }[] } {
  return { isError: true as const, content: [{ type: 'text', text: message }] };
}

function toolText(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const { owner, repo } = ownerRepo(args);
  if (owner === '' || repo === '') return null;
  return store.getRepo(owner, repo) ?? null;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run(store: Store, args: Record<string, unknown>, baseUrl: string): unknown {
      const name = stringArg(args, 'name');
      if (name === '') throw new Error('name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) throw new Error('Repository already exists');
      const repo = store.createRepo(
        name,
        args.private === true,
        stringArg(args, 'description'),
      );
      return toolText(repoView(repo, baseUrl));
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run(store: Store, args: Record<string, unknown>, baseUrl: string): unknown {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      return toolText(repoView(repo, baseUrl));
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run(store: Store, args: Record<string, unknown>, baseUrl: string): unknown {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const title = stringArg(args, 'title');
      if (title === '') return toolError('title is required');
      const issue = store.createIssue(repo, title, stringArg(args, 'body'), []);
      return toolText(issueView(repo, issue, baseUrl));
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
    run(store: Store, args: Record<string, unknown>, baseUrl: string): unknown {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const state = stringArg(args, 'state') || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueView(repo, issue, baseUrl));
      return toolText(issues);
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run(store: Store, args: Record<string, unknown>, baseUrl: string): unknown {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`base branch ${base} does not exist`);
      const pull = store.createPull(repo, stringArg(args, 'title'), stringArg(args, 'body'), head, base);
      return toolText(pullView(store, repo, pull, baseUrl));
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run(store: Store, args: Record<string, unknown>, baseUrl: string): unknown {
      const repo = findRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const raw = args.pull_number ?? args.number ?? args.pull_request_number;
      const number = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(number) || number < 1) return toolError('pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('pull request not found');
      if (pull.merged) return toolError('pull request is already merged');
      if (!store.pullMergeable(repo, pull)) return toolError('merge conflict');
      const commitOid = store.mergePull(repo, pull, `${pull.title} (#${pull.number})`);
      if (commitOid === null) return toolError('merge conflict');
      void baseUrl;
      return toolText({ sha: commitOid, merged: true, message: 'Pull request successfully merged' });
    },
  }),
]);

/** The tools/list answer, byte-identical on every call. */
const TOOLS_LIST = Object.freeze({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): ApiResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): ApiResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Handle one POST /mcp request (already authenticated by the server). */
export function handleMcp(store: Store, rawBody: string, baseUrl: string): ApiResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id: JsonRpcId =
    typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: MCP_SUPPORTED_VERSIONS[0],
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(offered)
      ? offered
      : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, TOOLS_LIST);
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return rpcError(id, -32601, `unknown tool ${JSON.stringify(name)}`);
    }
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
    }
    try {
      const result = tool.run(store, args, baseUrl);
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }
  return rpcError(id, -32601, `unknown method ${JSON.stringify(method)}`);
}
