import { openDb as openSqlite, unavailableReason as sqliteUnavailable } from '../../sqlite.js';

/**
 * The Cursor adapter's database seam — `src/adapters/opencode/db.js`'s shape,
 * applied to a vendor with TWO stores.
 *
 * Generic SQLite plumbing lives in `src/sqlite.js` (the one `node:sqlite`
 * touchpoint, shared with Hermes and opencode). What is Cursor's own is here:
 * the file names of both surfaces, the display name in the Node-gate
 * warning, the scratch prefix, the size guard, the version floor, the
 * tool-status vocabularies, and the tolerant JSON reader that every
 * Cursor payload goes through — because Cursor keeps everything interesting
 * inside JSON (and, on the IDE, JSON *strings* inside JSON).
 *
 * No file outside `src/adapters/cursor/` names a Cursor field.
 */

export {
  loadSqlite,
  resetForTests,
  tableColumns,
  selectList,
  isoMillis as iso,
} from '../../sqlite.js';

export const ADAPTER_NAME = 'cursor';

/** Surface A: `<userData>/User/globalStorage/state.vscdb`, table `cursorDiskKV`. */
export const IDE_DB_FILE = 'state.vscdb';
export const IDE_TABLE = 'cursorDiskKV';

/** Surface B: `<data>/chats/<md5(cwd)>/<agentId>/{meta.json, store.db}`. */
export const CLI_CHATS_DIR = 'chats';
export const CLI_STORE_FILE = 'store.db';
export const CLI_META_FILE = 'meta.json';

/**
 * Cursor's own size guard for a `cursorDiskKV` value — `Xt = 2e6` in its
 * shipping conversation indexer (`conversationSearchMain.js`), re-verified on
 * 3.16.29. A value over it is `sourcesUnread`, never loaded.
 */
export const VALUE_SIZE_GUARD = 2_000_000;

/**
 * The modern floor. `_v:17` is the only version verified populated; `_v:9`
 * and `_v:10` are the oldest this machine has ever written (empty
 * placeholders). Below the floor a composer is LISTED and reported fully
 * unread, never parsed — see the spec's decisions record, item 2.
 */
export const MIN_COMPOSER_VERSION = 9;

/**
 * `toolFormerData.status`, the full vocabulary from the 3.16.29 bundle. Nine
 * values, not four: rev 2 of the spec returned `ok` for anything it did not
 * name, so an in-flight call on live tail rendered as clean.
 *
 * Sets, not object literals — these are vendor-written strings and a plain-
 * object lookup would walk the prototype chain.
 */
export const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled', 'rejected', 'skipped']);
export const IN_FLIGHT_STATUSES = new Set(['pending', 'loading', 'running', 'in_progress']);

/** Group label for runs with no usable project path — the Hermes bucket pattern. */
export const CURSOR_BUCKET = '✦ Cursor chats';

/** The Node ≥22.13 gate's warning, named for Cursor. */
export function unavailableReason() {
  return sqliteUnavailable('Cursor');
}

/** Open a Cursor store strictly readonly — see `src/sqlite.js`. */
export function openDb(path) {
  return openSqlite(path, { scratchPrefix: 'rungraph-cursor-' });
}

/**
 * `JSON.parse` that returns undefined rather than throwing. Accepts a string
 * or the `Uint8Array` `node:sqlite` hands back for a BLOB column: Cursor
 * declares `cursorDiskKV.value` as BLOB and writes text into it, so which one
 * arrives depends on how the row was written. A payload that will not parse
 * is an unrecognized record, not a crash — the never-blank-screen rule
 * reaching into the JSON layer.
 */
export function parseJson(text) {
  const s = asText(text);
  if (typeof s !== 'string') return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A string for a TEXT or BLOB column value, or undefined. */
export function asText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return undefined;
}

/** Byte length of a column value without decoding it — the size guard's input. */
export function valueSize(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return 0;
}

/** A finite number, or undefined — Cursor's numeric fields are sparse everywhere. */
export function num(v) {
  return Number.isFinite(v) ? v : undefined;
}

/** A non-empty string, or undefined. */
export function str(v) {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Composer-level timestamps are epoch MILLISECONDS; header- and bubble-level
 * `createdAt` is an ISO 8601 STRING. Two units in one format, and mixing them
 * silently produces 1970 or 58000 AD. `instant()` accepts either and returns
 * epoch ms, so every comparison in this adapter happens on one clock.
 */
export function instant(v) {
  if (Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** Either unit → ISO 8601, or undefined. */
export function isoAny(v) {
  const ms = instant(v);
  if (ms === undefined) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
