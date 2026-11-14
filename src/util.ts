// Shared helpers: hashing, base64, pkt-line framing, deterministic logical clock.
//
// Everything the forge returns that a client can observe must be deterministic
// across two runs of the same trial (the final replays every contender trial and
// compares the state export byte for byte). That is why timestamps come from a
// logical clock here, never from the wall clock: every mutation ticks it once,
// so creation order is total and replay-stable.

import { createHash } from 'node:crypto';

/** SHA-1 of `data`, hex. Git object ids are SHA-1. */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** One REST/GraphQL/MCP reply: status, JSON body and extra headers. */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The git object id of `type` + `data` (`<type> <len>\0<data>` hashed). */
export function gitObjectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

/** Standard base64 (no newlines), as the contents API returns file bodies. */
export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

/** Decode base64, tolerating the line wrapping GitHub's API uses. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** An opaque, stable global id: base64url of `<Kind>:<key>`, never a bare number. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** A monotonic logical clock: seconds since a fixed base, one tick per mutation. */
export class LogicalClock {
  private current: number;

  constructor(baseSeconds = 1735689600) {
    this.current = baseSeconds;
  }

  /** The next timestamp, in seconds. */
  tick(): number {
    this.current += 1;
    return this.current;
  }

  /** The current timestamp without ticking. */
  now(): number {
    return this.current;
  }

  /** An ISO-8601 UTC string for a timestamp in seconds. */
  static iso(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }
}

// -------------------------------------------------------------------------------- pkt-line

/** A pkt-line flush packet. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** A pkt-line delim packet (protocol v2 section separator). */
export const PKT_DELIM = Buffer.from('0001', 'ascii');
/** A pkt-line response-end packet (protocol v2). */
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode one line (with its trailing newline already in `text`) as a pkt-line. */
export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds the 65520-byte limit`);
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** Encode raw bytes as one pkt-line (the length prefix counts the bytes). */
export function pktBytes(data: Buffer): Buffer {
  const length = data.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds the 65520-byte limit`);
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** Encode several lines, plus a flush when `flush` is true. */
export function pktLines(lines: readonly string[], flush = true): Buffer {
  const parts: Buffer[] = lines.map((line) => pktLine(line));
  if (flush) parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

/** One parsed pkt-line. */
export interface Pkt {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/**
 * Parse a whole buffer of pkt-lines. Throws on a malformed length prefix or a
 * truncated packet, so a malformed client body can be answered 400, never crash.
 */
export function parsePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length prefix');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('malformed pkt-line length prefix');
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** The data payloads of a pkt-line stream, in order, as text lines. */
export function pktDataLines(buffer: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of parsePktLines(buffer)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Split one sideband payload into pkt-lines of at most `maxData` payload bytes. */
export function sidebandChunks(band: number, data: Buffer, maxData = 65515): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxData) {
    const slice = data.subarray(offset, Math.min(data.length, offset + maxData));
    chunks.push(pktBytes(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) chunks.push(pktBytes(Buffer.from([band])));
  return chunks;
}
