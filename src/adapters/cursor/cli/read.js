import { readFile } from 'node:fs/promises';
import { asText, tableColumns } from '../db.js';

/**
 * cursor-agent's `store.db` — a content-addressed store with MIXED encoding,
 * and the structure is what makes it tractable:
 *
 *   meta['0']          hex-encoded JSON: {agentId, latestRootBlobId, name, mode,
 *                      isRunEverything, createdAt, blobEncryptionKey}
 *   message blobs      plain JSON, begin `{"role"`
 *   root snapshot      protobuf: top-level repeated field 1 = message blob ids,
 *                      IN CONVERSATION ORDER; field 8 = one id into a per-step
 *                      sub-DAG; the rest is state
 *   other spine blobs  nested protobuf — not walked
 *
 * Measured on both calibration sessions: the root's field-1 list was exactly
 * the conversation, and every earlier root persists as a blob (one new root
 * per model step). Rev 2 of the spec walked every LEN-32 field of every
 * spine blob; that happened to work because a miss is a skip, but it could
 * not express order and double-walked superseded roots. Only the root's
 * field 1 is consulted now.
 *
 * `node:sqlite` returns blob columns as `Uint8Array`; everything here wraps
 * with `Buffer.from` before any string or byte work.
 *
 * Nothing in this file names `blobEncryptionKey` past the one line that
 * DROPS it: `readMeta0()` returns every other field and never that one, so
 * the key cannot reach the IR by accident (spec §11, first line of defence).
 */

/** `meta.json` beside the store: `{schemaVersion, createdAtMs, updatedAtMs, hasConversation, cwd}`. */
export async function readMetaJson(path) {
  try {
    const json = JSON.parse(await readFile(path, 'utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

/** Is this database a cursor-agent store at all? */
export function hasStoreTables(db) {
  return tableColumns(db, 'blobs').has('id') && tableColumns(db, 'meta').has('key');
}

/**
 * `meta['0']`, hex-decoded and parsed — MINUS `blobEncryptionKey`, which is
 * a live secret and is never copied anywhere. Returns null when the row is
 * missing, not hex, or not JSON: the parser turns that into
 * `records: 0, sourcesUnread: 1` with the run still listed.
 */
export function readMeta0(db) {
  let raw;
  try {
    raw = db.prepare('SELECT value FROM meta WHERE key = ?').get('0')?.value;
  } catch {
    return null;
  }
  const hex = asText(raw);
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  let json;
  try {
    json = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  // eslint-disable-next-line no-unused-vars
  const { blobEncryptionKey: _dropped, ...rest } = json;
  return rest;
}

/** One blob by id, as a Buffer, or undefined. */
export function readBlob(db, id) {
  if (typeof id !== 'string' || !id) return undefined;
  let raw;
  try {
    raw = db.prepare('SELECT data FROM blobs WHERE id = ?').get(id)?.data;
  } catch {
    return undefined;
  }
  if (raw == null) return undefined;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  return undefined;
}

/** `COUNT(*)` over `blobs` — the fingerprint half that moves. */
export function blobCount(db) {
  try {
    const c = db.prepare('SELECT COUNT(*) AS c FROM blobs').get()?.c;
    return Number.isFinite(c) ? c : 0;
  } catch {
    return 0;
  }
}

/**
 * The root snapshot's top-level repeated field 1, in order, as hex ids.
 *
 * A thirty-line tag/varint/LEN walker over ONE message: no `.proto`, no
 * recursion into nested messages, no field other than 1 consulted. Returns
 * null when the bytes do not parse as a protobuf message at all (a wire type
 * that does not exist, a length past the end) — the parser reports that as
 * an unreadable root rather than guessing.
 *
 * A field-1 entry that is not 32 bytes is not an id and is skipped; the
 * spec's measurement saw only 32-byte entries, and a future shape that puts
 * something else in field 1 must not become a phantom message.
 *
 * @param {Buffer} buf
 * @returns {string[]|null}
 */
export function rootMessageIds(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const ids = [];
  let i = 0;
  while (i < buf.length) {
    const tag = varint(buf, i);
    if (!tag) return null;
    i = tag.next;
    const wireType = Number(tag.value & 7n);
    const field = Number(tag.value >> 3n);
    if (wireType === 0) {
      const v = varint(buf, i);
      if (!v) return null;
      i = v.next;
    } else if (wireType === 2) {
      const len = varint(buf, i);
      if (!len) return null;
      const n = Number(len.value);
      i = len.next;
      if (n < 0 || i + n > buf.length) return null;
      if (field === 1 && n === 32) ids.push(buf.subarray(i, i + n).toString('hex'));
      i += n;
    } else if (wireType === 1) {
      i += 8;
    } else if (wireType === 5) {
      i += 4;
    } else {
      return null; // groups (3/4) and undefined types (6/7)
    }
    if (i > buf.length) return null;
  }
  return ids;
}

/** A base-128 varint at `at`: `{ value: bigint, next }`, or null past the end. */
function varint(buf, at) {
  let value = 0n;
  let shift = 0n;
  let i = at;
  while (i < buf.length) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

/**
 * A blob that begins with `{` is a message — parsed with the same tolerance
 * as every other Cursor payload. Anything else is an unrecognized record.
 *
 * @returns {{ json?: object, miss?: 'invalid' | 'binary' }}
 */
export function decodeMessageBlob(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf[0] !== 0x7b) return { miss: 'binary' };
  try {
    const json = JSON.parse(buf.toString('utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? { json } : { miss: 'invalid' };
  } catch {
    return { miss: 'invalid' };
  }
}
