// Git objects and packfiles, implemented on the standard library only.
//
// The trial pod has no git binary, so the forge is its own git: objects are
// stored verbatim by SHA-1 and returned byte-exactly, packs are written
// undelted (the suite resolves them either way) and read with full delta
// support (OFS_DELTA and REF_DELTA) so any pack a client sends parses.

import { deflateSync, inflateSync } from 'node:zlib';
import { gitObjectId, sha1 } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One git object: its type and its exact bytes. */
export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** The object id of `type` + `data`. */
export function objectId(type: ObjectType, data: Buffer): string {
  return gitObjectId(type, data);
}

/** Build a blob object from bytes. */
export function makeBlob(data: Buffer): GitObject {
  return { type: 'blob', data };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode terminator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no name terminator');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (already in git sort order) into a tree object. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort: entries sort by name, directories as if named `name/`. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTime: number;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerTime: number;
  readonly message: string;
}

const HEADER_LINE = /^([a-z]+) (.*)$/;

/** Parse a commit object: headers, then the message after the blank line. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let authorTime = 0;
  let committerName = '';
  let committerEmail = '';
  let committerTime = 0;
  for (const line of head.split('\n')) {
    const match = HEADER_LINE.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = match[2] ?? '';
    if (key === 'tree') tree = value.trim();
    else if (key === 'parent') parents.push(value.trim());
    else if (key === 'author' || key === 'committer') {
      const parsed = parseIdent(value);
      if (key === 'author') {
        authorName = parsed.name;
        authorEmail = parsed.email;
        authorTime = parsed.time;
      } else {
        committerName = parsed.name;
        committerEmail = parsed.email;
        committerTime = parsed.time;
      }
    }
  }
  return { tree, parents, authorName, authorEmail, authorTime, committerName, committerEmail, committerTime, message };
}

function parseIdent(value: string): { name: string; email: string; time: number } {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(value.trim());
  if (match === null) return { name: value.trim(), email: '', time: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', time: Number(match[3] ?? 0) };
}

/** Serialize a commit object. `parents` in order; message without trailing newline. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.authorName} <${input.authorEmail}> ${input.authorTime} +0000`);
  lines.push(`committer ${input.committerName} <${input.committerEmail}> ${input.committerTime} +0000`);
  lines.push('');
  lines.push(input.message);
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly taggerName: string;
  readonly taggerEmail: string;
  readonly taggerTime: number;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2).replace(/\n$/, '');
  let object = '';
  let type = '';
  let tag = '';
  let taggerName = '';
  let taggerEmail = '';
  let taggerTime = 0;
  for (const line of head.split('\n')) {
    const match = HEADER_LINE.exec(line);
    if (match === null) continue;
    const key = match[1];
    const value = match[2] ?? '';
    if (key === 'object') object = value.trim();
    else if (key === 'type') type = value.trim();
    else if (key === 'tag') tag = value.trim();
    else if (key === 'tagger') {
      const parsed = parseIdent(value);
      taggerName = parsed.name;
      taggerEmail = parsed.email;
      taggerTime = parsed.time;
    }
  }
  return { object, type, tag, taggerName, taggerEmail, taggerTime, message };
}

/** Serialize an annotated tag object. */
export function buildTag(input: {
  object: string;
  type: string;
  tag: string;
  taggerName: string;
  taggerEmail: string;
  taggerTime: number;
  message: string;
}): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.taggerName} <${input.taggerEmail}> ${input.taggerTime} +0000`,
    '',
    input.message,
  ];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// -------------------------------------------------------------------------------- packfiles

const PACK_MAGIC = 'PACK';
const TYPE_CODES: Readonly<Record<ObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});
const CODE_TYPES: Readonly<Record<number, ObjectType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  bytes.push(((remaining & 0x0f) | (code << 4) | (remaining > 15 ? 0x80 : 0)) & 0xff);
  remaining >>>= 4;
  while (remaining > 0) {
    bytes.push((remaining & 0x7f) | (remaining > 0x7f ? 0x80 : 0));
    remaining >>>= 7;
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, undelted objects) for `objects` in given order. */
export function writePack(objects: readonly { oid: string; object: GitObject }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write(PACK_MAGIC, 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const entry of objects) {
    parts.push(writePackObjectHeader(entry.object.type, entry.object.data.length));
    parts.push(deflateSync(entry.object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** Read a varint from `buffer` at `offset`: returns [value, bytes consumed]. */
export function readVarint(buffer: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let consumed = 0;
  for (;;) {
    if (offset + consumed >= buffer.length) throw new Error('truncated varint');
    const byte = buffer[offset + consumed] ?? 0;
    consumed += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (consumed > 10) throw new Error('varint too long');
  }
  return [value, consumed];
}

/** Apply a git delta to `base`, returning the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const resultSize = readDeltaVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy offset');
          copyOffset |= (delta[offset] ?? 0) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy size');
          copySize |= (delta[offset] ?? 0) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base object');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('truncated delta insert');
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== resultSize) throw new Error(`delta produced ${produced} bytes, expected ${resultSize}`);
  return Buffer.concat(parts);
}

/**
 * Read a packfile. Returns every object by its recomputed id. Deltas resolve
 * against objects in the same pack, or, for REF_DELTA, against `resolveBase`
 * (the store's objects: a thin pack's bases). Throws on a bad magic, a bad
 * count, a bad checksum or an unresolvable delta.
 *
 * A deflate stream's end is found by binary search: inflateSync ignores
 * trailing bytes, so the smallest prefix that inflates to the header's size
 * is the stream's exact end.
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== PACK_MAGIC) {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = sha1(pack.subarray(0, pack.length - 20));
  const actualTrailer = pack.subarray(pack.length - 20).toString('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack checksum mismatch');

  /** Inflate the stream at `start` whose inflated size is `size`; returns [data, end]. */
  function inflateAt(start: number, size: number): [Buffer, number] {
    let low = start + 1;
    let high = pack.length - 20;
    let found: Buffer | null = null;
    let foundEnd = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      try {
        const out = inflateSync(pack.subarray(start, mid));
        if (out.length === size) {
          found = out;
          foundEnd = mid;
          high = mid - 1;
        } else {
          throw new Error('inflated size does not match the pack header');
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'inflated size does not match the pack header') throw err;
        low = mid + 1;
      }
    }
    if (found === null || foundEnd < 0) throw new Error('deflate stream did not terminate');
    return [found, foundEnd];
  }

  interface RawEntry {
    readonly typeCode: number;
    readonly data: Buffer;
    readonly ofsBase?: number;
    readonly refBase?: string;
    readonly offset: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: an offset varint, counted back from this entry's start.
      byte = pack[offset] ?? 0;
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] ?? 0;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      ofsBase = entryOffset - value;
    } else if (typeCode === 7) {
      refBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const [data, end] = inflateAt(offset, size);
    offset = end;
    const entry: RawEntry = { typeCode, data, ofsBase, refBase, offset: entryOffset };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  // Second pass: resolve deltas (a delta's base may itself be a delta).
  const resolved = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const resolveEntry = (entry: RawEntry, seen: Set<number>): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.ofsBase ?? -1);
        if (baseEntry !== undefined) base = resolveEntry(baseEntry, seen);
      } else {
        base = byOid.get(entry.refBase ?? '');
        if (base === undefined && resolveBase !== undefined) base = resolveBase(entry.refBase ?? '');
      }
      if (base === undefined) throw new Error(`delta base ${entry.refBase ?? entry.ofsBase} is not in the pack or the store`);
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      const type = CODE_TYPES[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      object = { type, data: entry.data };
    }
    resolved.set(entry.offset, object);
    const oid = objectId(object.type, object.data);
    byOid.set(oid, object);
    return object;
  };
  for (const entry of raw) {
    const object = resolveEntry(entry, new Set<number>());
    byOid.set(objectId(object.type, object.data), object);
  }
  return byOid;
}
