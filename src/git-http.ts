// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and
// v0) and receive-pack (v0). The wire shapes here are the client's own
// (sdk/conformance/git-client.ts): what it sends, what it parses, and what
// the checks assert about it.

import {
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  parsePktLines,
  pktBytes,
  pktLine,
  pktLines,
  sidebandChunks,
} from './util.ts';
import { ZERO_OID, type Repo, type Store } from './store.ts';

export const AGENT = 'forge/1.0.0';
export const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
export const RECEIVE_PACK_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
export const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n', 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`, 'utf8') };
}

/** All refs of a repo, sorted by name (HEAD excluded; it rides the symref). */
export function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled commit of a ref (itself for a commit, the target for a tag). */
function peeledOid(store: Store, repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return null;
  if (object.type !== 'tag') return null;
  return store.peelToCommit(repo, oid);
}

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** A v0 ref advertisement: service preamble, flush, ref lines, flush. */
function v0Advertisement(
  service: string,
  repo: Repo,
  store: Store,
  caps: string,
): Buffer {
  const refs = sortedRefs(repo);
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peeledOid(store, repo, ref.oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    });
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** A protocol v2 capability advertisement: `version 2`, capabilities, flush. */
function v2Advertisement(): Buffer {
  return pktLines(
    ['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', `object-format=sha1\n`, `agent=${AGENT}\n`],
    true,
  );
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=... — the advertisement, or 404
 * for a missing repository (the server stays up).
 */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolVersion: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocolVersion === 'version=2') return ok(UPLOAD_PACK_ADVERTISEMENT, v2Advertisement());
    return ok(UPLOAD_PACK_ADVERTISEMENT, v0Advertisement('git-upload-pack', repo, store, UPLOAD_V0_CAPS));
  }
  if (service === 'git-receive-pack') {
    return ok(RECEIVE_PACK_ADVERTISEMENT, v0Advertisement('git-receive-pack', repo, store, RECEIVE_V0_CAPS));
  }
  return notFound();
}

// -------------------------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** POST git-upload-pack with a v2 ls-refs command. */
function handleLsRefs(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = 'refs/heads/main';
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:${headTarget}\n`);
  } else {
    if (args.symrefs && keep('HEAD')) {
      const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
      lines.push(`${headOid} HEAD symref-target:${headTarget}\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const peeled = peeledOid(store, repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  return pktLines(lines, true);
}

// -------------------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

interface FetchPlan {
  /** Objects to send, in pack order. */
  readonly objects: { oid: string; object: GitObject }[];
  /** Commits that stay shallow boundaries after this fetch. */
  readonly shallow: string[];
  /** Old boundaries whose parents are now included. */
  readonly unshallow: string[];
}

/**
 * Plan a fetch: which commits, trees and blobs to send.
 *
 * - A want's history is walked to `depth` generations (none when depth is
 *   null); a commit at the depth edge, or whose parent is held, stays a
 *   shallow boundary.
 * - A `have` the client holds excludes that commit and its history, unless
 *   the client also lists it as a shallow boundary it wants deepened: then
 *   the walk continues through it (a deepen) and it becomes `unshallow`
 *   once its parent is included.
 * - Trees and blobs reachable from a held object are never re-sent: the
 *   pack holds only what the client cannot already build.
 */
function planFetch(store: Store, repo: Repo, args: FetchArgs): FetchPlan {
  const boundarySet = new Set(args.shallowBoundaries);
  const haveSet = new Set(args.haves);

  // Commits to include, with their distance from a want.
  const included = new Map<string, number>();
  const queue: { oid: string; distance: number }[] = [];
  for (const want of args.wants) queue.push({ oid: want, distance: 0 });
  const queued = new Set<string>(args.wants);
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; distance: number };
    if (included.has(current.oid)) continue;
    if (args.depth !== null && current.distance >= args.depth) continue;
    const object = repo.objects.get(current.oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      // A wanted tag: send the tag, then walk its target as a commit.
      included.set(current.oid, current.distance);
      const tag = parseTag(object.data);
      if (!queued.has(tag.object)) {
        queued.add(tag.object);
        queue.push({ oid: tag.object, distance: current.distance });
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    const held = haveSet.has(current.oid) && !boundarySet.has(current.oid);
    if (held) continue;
    included.set(current.oid, current.distance);
    const commit = store.parseCommitCached(repo, current.oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (!queued.has(parent)) {
        queued.add(parent);
        queue.push({ oid: parent, distance: current.distance + 1 });
      }
    }
  }

  // Shallow boundaries: included commits with a parent that was not included.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included.keys()) {
    const commit = store.parseCommitCached(repo, oid);
    if (commit === null) continue;
    const cut = commit.parents.some((parent) => !included.has(parent));
    if (commit.parents.length > 0 && cut) shallow.push(oid);
    if (boundarySet.has(oid) && commit.parents.length > 0 && commit.parents.every((parent) => included.has(parent))) {
      unshallow.push(oid);
    }
  }

  // Everything reachable from a held object, so it is never re-sent. The walk
  // stops at a shallow boundary the client listed: the client holds that
  // commit but not its parents (that is what a deepen is for), so the
  // parents are not held either.
  const heldReachable = new Set<string>();
  {
    const queue: string[] = [...args.haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined) continue;
      if (object.type === 'tree') {
        for (const oid of store.treeReachable(repo, current)) heldReachable.add(oid);
      } else if (object.type === 'blob') {
        heldReachable.add(current);
      } else if (object.type === 'tag') {
        heldReachable.add(current);
        queue.push(parseTag(object.data).object);
      } else {
        heldReachable.add(current);
        const commit = store.parseCommitCached(repo, current);
        if (commit === null) continue;
        for (const oid of store.treeReachable(repo, commit.tree)) heldReachable.add(oid);
        if (!boundarySet.has(current)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      }
    }
  }

  // The pack: each included commit (or tag) with its own tree and blobs, minus
  // anything the client already holds. Ancestors are never pulled in here:
  // only the commits the walk included contribute their trees.
  const pack = new Map<string, GitObject>();
  const addCommitObjects = (oid: string): void => {
    const commit = store.parseCommitCached(repo, oid);
    if (commit === null) return;
    for (const reachable of store.treeReachable(repo, commit.tree)) {
      if (heldReachable.has(reachable)) continue;
      const object = repo.objects.get(reachable);
      if (object !== undefined) pack.set(reachable, object);
    }
  };
  for (const oid of included.keys()) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (heldReachable.has(oid)) continue;
    pack.set(oid, object);
    if (object.type === 'commit') addCommitObjects(oid);
    else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      const target = repo.objects.get(tag.object);
      if (target !== undefined && !heldReachable.has(tag.object)) {
        pack.set(tag.object, target);
        if (target.type === 'commit') addCommitObjects(tag.object);
      }
    }
  }

  // Pack order: commits first (in inclusion order), then the rest.
  const ordered: { oid: string; object: GitObject }[] = [];
  const seen = new Set<string>();
  for (const oid of included.keys()) {
    if (pack.has(oid) && !seen.has(oid)) {
      seen.add(oid);
      ordered.push({ oid, object: pack.get(oid) as GitObject });
    }
  }
  for (const [oid, object] of pack) {
    if (!seen.has(oid)) {
      seen.add(oid);
      ordered.push({ oid, object });
    }
  }
  return { objects: ordered, shallow, unshallow };
}

/** A v2 fetch response: acknowledgments, shallow-info, packfile sections. */
function v2FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(plan.objects);
    parts.push(...sidebandChunks(1, pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch response: NAK, shallow lines, then the sideband packfile. */
function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    parts.push(...sidebandChunks(1, writePack(plan.objects)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST git-upload-pack: a v2 command (ls-refs / fetch) or a v0 fetch. */
export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocolVersion: string | undefined,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  try {
    if (gitProtocolVersion === 'version=2') {
      const packets = parsePktLines(body);
      const lines: string[] = [];
      let command: string | null = null;
      let inArguments = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          inArguments = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8');
        if (!inArguments) {
          if (text.startsWith('command=')) command = text.slice('command='.length).trim();
          continue;
        }
        lines.push(text);
      }
      if (command === 'ls-refs') {
        const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        for (const raw of lines) {
          const line = raw.replace(/\n$/, '');
          if (line === 'peel') args.peel = true;
          else if (line === 'symrefs') args.symrefs = true;
          else if (line === 'unborn') args.unborn = true;
          else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
        }
        return ok(UPLOAD_PACK_RESULT, handleLsRefs(store, repo, args));
      }
      if (command === 'fetch') {
        const plan = planFetch(store, repo, parseFetchArgs(lines));
        return ok(UPLOAD_PACK_RESULT, v2FetchResponse(plan));
      }
      return badRequest(`unknown upload-pack command ${JSON.stringify(command)}`);
    }
    // Protocol v0: wants (with shallow/deepen) to the first flush, then
    // haves and done to the second.
    const packets = parsePktLines(body);
    const firstSection: string[] = [];
    const secondSection: string[] = [];
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      if (section === 0) firstSection.push(packet.payload.toString('utf8'));
      else secondSection.push(packet.payload.toString('utf8'));
    }
    const plan = planFetch(store, repo, parseFetchArgs([...firstSection, ...secondSection]));
    return ok(UPLOAD_PACK_RESULT, v0FetchResponse(plan));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

// -------------------------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** POST git-receive-pack: apply a command list and its pack, report per ref. */
export function handleReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  try {
    const commands: PushCommand[] = [];
    let packStart = -1;
    let offset = 0;
    // Walk the raw buffer: pkt-lines until the flush, then the pack bytes.
    // (The pack is binary, so the whole body is not a pkt-line stream.)
    while (offset < body.length) {
      if (offset + 4 > body.length) return badRequest('truncated pkt-line');
      const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(length)) return badRequest('malformed pkt-line');
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) return badRequest('truncated pkt-line');
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul < 0 ? payload : payload.slice(0, nul)).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({
          oldOid: parts[0] as string,
          newOid: parts[1] as string,
          ref: parts[2] as string,
        });
      }
      offset += length;
    }
    if (packStart < 0) packStart = body.length;

    // Ingest the pack, if the push carries one.
    let unpackOk = true;
    let unpackDetail = 'ok';
    const packBytes = body.subarray(packStart);
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) repo.objects.set(oid, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }

    // Apply each command in order; a refused ref never moves.
    const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let reason: string | null = null;
      if (!unpackOk) {
        reason = 'unpacker error';
      } else if (command.newOid === ZERO_OID) {
        if (current === undefined) reason = 'remote ref does not exist';
      } else {
        const target = repo.objects.get(command.newOid);
        if (target === undefined) reason = 'object not found';
        else if (command.oldOid === ZERO_OID) {
          if (current !== undefined) reason = 'already exists';
        } else {
          if (current === undefined) reason = 'remote ref does not exist';
          else if (current !== command.oldOid) reason = 'non-fast-forward';
          else if (!store.isAncestor(repo, command.oldOid, command.newOid)) reason = 'non-fast-forward';
        }
      }
      if (reason === null) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
      } else {
        report.push(`ng ${command.ref} ${reason}\n`);
      }
    }

    // report-status inside sideband band 1 (the report stream is pkt-lined).
    const inner = pktLines(report, true);
    const outer: Buffer[] = [...sidebandChunks(1, inner), PKT_FLUSH];
    return ok(RECEIVE_PACK_RESULT, Buffer.concat(outer));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}
