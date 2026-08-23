import { IDE_TABLE, VALUE_SIZE_GUARD, asText, tableColumns, valueSize } from '../db.js';

/**
 * `cursorDiskKV` access — three operations and nothing else.
 *
 * The table is `(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)`, and every
 * record rungraph reads is a JSON document under a prefixed key:
 *
 *   composerData:<composerId>              the conversation = a run
 *   bubbleId:<composerId>:<bubbleId>       the messages
 *   checkpointId:<composerId>:<checkpointId>
 *
 * Two things are load-bearing here:
 *
 * 1. **Range scans, never per-key lookups.** `key >= 'bubbleId:<cid>:' AND
 *    key < 'bubbleId:<cid>;'` is the indexed prefix scan Cursor's own indexer
 *    uses (`;` is the byte after `:`), and it was measured 15× faster than
 *    per-key reads for 80 bubbles — a gap that widens with conversation
 *    length.
 * 2. **Values are size-guarded at 2 MB** (`Xt = 2e6`, Cursor's own constant).
 *    An oversized value is a typed miss, not a load.
 *
 * Every miss is TYPED rather than thrown — `null` (tombstoned), `oversized`,
 * `invalid` (JSON that will not parse) — so the parser can count each into
 * coverage as the spec's table says, and never blank-screen.
 *
 * **Never queried, by design: the 3.16 `composerHeaders` table and
 * `conversation-search.db`.** Both are caches Cursor rebuilds (the first held
 * 10 of 49 composers when probed). tests/cursor.test.js greps this directory
 * for their names, the way the opencode adapter guards `session_message`.
 */

const COMPOSER_PREFIX = 'composerData:';
const BUBBLE_PREFIX = 'bubbleId:';
const CHECKPOINT_PREFIX = 'checkpointId:';

/** Is this database a Cursor IDE store at all? */
export function hasKvTable(db) {
  const cols = tableColumns(db, IDE_TABLE);
  return cols.has('key') && cols.has('value');
}

/**
 * Decode one `value` column: `{ json }` on success, `{ miss }` otherwise.
 * @returns {{ json?: object, miss?: 'null'|'oversized'|'invalid' }}
 */
export function decodeValue(value) {
  if (value == null) return { miss: 'null' };
  if (valueSize(value) > VALUE_SIZE_GUARD) return { miss: 'oversized' };
  const text = asText(value);
  if (typeof text !== 'string') return { miss: 'invalid' };
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? { json } : { miss: 'invalid' };
  } catch {
    return { miss: 'invalid' };
  }
}

/**
 * Every composer record, in key order: one indexed prefix scan, values
 * decoded with the guard. A record that misses is still RETURNED (with its
 * id and the miss kind) so `detect()` can warn about it rather than let a
 * conversation vanish silently.
 *
 * @returns {Array<{ composerId: string, json?: object, miss?: string }>}
 */
export function composerRecords(db) {
  const rows = db
    .prepare(`SELECT key, value FROM ${IDE_TABLE} WHERE key >= ? AND key < ? ORDER BY key`)
    .all(COMPOSER_PREFIX, prefixEnd(COMPOSER_PREFIX));
  const out = [];
  for (const row of rows) {
    const composerId = String(row.key).slice(COMPOSER_PREFIX.length);
    if (!composerId) continue;
    out.push({ composerId, ...decodeValue(row.value) });
  }
  return out;
}

/** One composer record by key — a primary-key point lookup, for `parse()` and child lanes. */
export function composerRecord(db, composerId) {
  if (typeof composerId !== 'string' || !composerId) return undefined;
  const row = db
    .prepare(`SELECT value FROM ${IDE_TABLE} WHERE key = ?`)
    .get(`${COMPOSER_PREFIX}${composerId}`);
  return row ? { composerId, ...decodeValue(row.value) } : undefined;
}

/**
 * One range scan for a composer's bubbles → `Map<bubbleId, {json}|{miss}>`.
 * Rows the headers do not reference are in the map too (the parser reports
 * them as orphans); headers the map lacks are `sourcesUnread`.
 *
 * @returns {Map<string, { json?: object, miss?: string }>}
 */
export function bubbleRows(db, composerId) {
  const prefix = `${BUBBLE_PREFIX}${composerId}:`;
  const rows = db
    .prepare(`SELECT key, value FROM ${IDE_TABLE} WHERE key >= ? AND key < ?`)
    .all(prefix, prefixEnd(prefix));
  const out = new Map();
  for (const row of rows) {
    const bubbleId = String(row.key).slice(prefix.length);
    if (!bubbleId) continue;
    out.set(bubbleId, decodeValue(row.value));
  }
  return out;
}

/**
 * One bubble by key — the ONLY per-key read in the adapter, used by
 * `detect()` for a title fallback (the first human bubble of a composer
 * with no `name`). A point lookup on the primary key, so 10 000 of them stay
 * inside the §4 budget where 10 000 range scans would not.
 */
export function bubbleRow(db, composerId, bubbleId) {
  const row = db
    .prepare(`SELECT value FROM ${IDE_TABLE} WHERE key = ?`)
    .get(`${BUBBLE_PREFIX}${composerId}:${bubbleId}`);
  return row ? decodeValue(row.value) : { miss: 'absent' };
}

/**
 * Children by `subagentInfo.parentComposerId` — the second discovery route,
 * resolved at PARSE time so it is live: a watched run whose subagent Cursor
 * just spawned must show the lane on the next tick, not after a reload, and a
 * grandchild linked only by this route must be found below depth 1.
 *
 * One prefix scan over `composerData:` (the same scan `detect()` runs), with
 * a substring check BEFORE any JSON.parse so the cost at Cursor's
 * 10 000-conversation cap stays a read of ~0.6 MB plus a handful of parses,
 * not 10 000 parses.
 *
 * @returns {Map<string, string[]>} parent composer id → child ids, in key order
 */
export function childrenByParent(db) {
  const out = new Map();
  const rows = db
    .prepare(`SELECT key, value FROM ${IDE_TABLE} WHERE key >= ? AND key < ? ORDER BY key`)
    .all(COMPOSER_PREFIX, prefixEnd(COMPOSER_PREFIX));
  for (const row of rows) {
    const text = asText(row.value);
    if (typeof text !== 'string' || !text.includes('"parentComposerId"')) continue;
    const { json } = decodeValue(row.value);
    const parent = json?.subagentInfo?.parentComposerId;
    if (typeof parent !== 'string' || !parent) continue;
    const child = typeof json.composerId === 'string' && json.composerId ? json.composerId : String(row.key).slice(COMPOSER_PREFIX.length);
    if (!child || child === parent) continue;
    if (!out.has(parent)) out.set(parent, []);
    if (!out.get(parent).includes(child)) out.get(parent).push(child);
  }
  return out;
}

/**
 * A checkpoint record — `{files, nonExistentFiles, newlyCreatedFolders,
 * activeInlineDiffs, …}` with file URIs — for attribution. Absent → undefined.
 */
export function checkpoint(db, composerId, checkpointId) {
  if (typeof checkpointId !== 'string' || !checkpointId) return undefined;
  const row = db
    .prepare(`SELECT value FROM ${IDE_TABLE} WHERE key = ?`)
    .get(`${CHECKPOINT_PREFIX}${composerId}:${checkpointId}`);
  return row ? decodeValue(row.value).json : undefined;
}

/** The exclusive upper bound of a `:`-terminated key prefix. */
function prefixEnd(prefix) {
  return prefix.slice(0, -1) + ';';
}
