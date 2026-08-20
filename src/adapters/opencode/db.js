import { openDb as openSqlite, unavailableReason as sqliteUnavailable } from '../../sqlite.js';

/**
 * The opencode adapter's database seam.
 *
 * Generic SQLite plumbing lives in `src/sqlite.js` (shared with Hermes, one
 * implementation). What is opencode's own is here: the file name, the display
 * name in the Node-gate warning, the scratch prefix, the column lists, and
 * the JSON-payload readers — opencode keeps everything interesting inside
 * `message.data` / `part.data` blobs, where `selectList` gives no protection
 * at all.
 */

export {
  loadSqlite,
  resetForTests,
  tableColumns,
  selectList,
  isoMillis as iso,
} from '../../sqlite.js';

export const ADAPTER_NAME = 'opencode';

/** One global database per data dir — `~/.local/share/opencode/opencode.db`. */
export const DB_FILE = 'opencode.db';

/** The Node ≥22.13 gate's warning, named for opencode. */
export function unavailableReason() {
  return sqliteUnavailable('opencode');
}

/** Open an opencode.db strictly readonly — see `src/sqlite.js`. */
export function openDb(path) {
  return openSqlite(path, { scratchPrefix: 'rungraph-opencode-' });
}

/**
 * The `session` columns this adapter reads. Deliberately NOT `account` or
 * `control_account`, which hold live access and refresh tokens: those are
 * excluded permanently, on privacy grounds, and no code path here names them.
 *
 * Every one of these is fed through `selectList`, because the corpus already
 * spans 1.15.6 → 1.18.19 and `session` gained `workspace_id`, `path`, `agent`,
 * `model`, `cost`, five `tokens_*` columns and `metadata` inside that range.
 */
export const SESSION_COLS = [
  'id',
  'project_id',
  'parent_id',
  'slug',
  'directory',
  'title',
  'version',
  'revert',
  'time_created',
  'time_updated',
  'time_archived',
  'agent',
  'model',
  'cost',
  'tokens_input',
  'tokens_output',
  'tokens_reasoning',
  'tokens_cache_read',
  'tokens_cache_write',
];

export const PROJECT_COLS = ['id', 'worktree', 'vcs', 'name'];
export const MESSAGE_COLS = ['id', 'session_id', 'time_created', 'time_updated', 'data'];
export const PART_COLS = ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'];

/**
 * The `part.data.type` values this grammar understands. Verified stable
 * across a three-minor-version jump (1.15.6 → 1.18.19): a 177-part capture on
 * the newer version produced zero types outside this set. Anything else is
 * skipped, counted against coverage, and named in `ext.opencode.unknownTypes`.
 *
 * A Set, not an object literal, and that is load-bearing: `data.type` is
 * written by opencode and unvalidated by definition, so a plain-object lookup
 * would walk the prototype chain and `{"type":"constructor"}` would read as a
 * type this parser knows.
 */
export const KNOWN_PART_TYPES = new Set([
  'tool',
  'step-start',
  'step-finish',
  'reasoning',
  'text',
  'patch',
  'compaction',
]);

/** opencode's own string for a tool call a person refused. Matched verbatim. */
export const DENIAL_ERROR = 'The user rejected permission to use this specific tool call.';

/**
 * `JSON.parse` that returns undefined rather than throwing, for the `data`
 * blobs. A row whose payload will not parse is an unrecognized record, not a
 * crash — the never-blank-screen rule reaching into the JSON layer.
 */
export function parseData(text) {
  if (typeof text !== 'string') return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * opencode's model reference, which is a plain string on 1.15.x and a
 * `{id, providerID, variant}` object on 1.18.x — measured, not guessed, on a
 * corpus holding both. Returns a display string, or undefined.
 */
export function modelName(value) {
  const v = typeof value === 'string' ? (parseData(value) ?? value) : value;
  if (typeof v === 'string') return v.trim() || undefined;
  if (!v || typeof v !== 'object') return undefined;
  const id = typeof v.id === 'string' ? v.id : typeof v.modelID === 'string' ? v.modelID : '';
  if (!id) return undefined;
  const provider = typeof v.providerID === 'string' && v.providerID ? `${v.providerID}/` : '';
  return `${provider}${id}`;
}

/** A finite number, or 0 — opencode's token fields are nullable everywhere. */
export function num(v) {
  return Number.isFinite(v) ? v : 0;
}
