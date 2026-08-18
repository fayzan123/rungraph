import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { statOrNull, shellQuote } from '../../util.js';
import { snippet } from '../../ir.js';
import { loadSqlite, unavailableReason, openDb, tableColumns, selectList, iso } from './db.js';

/**
 * Hermes Agent adapter — detection. All Hermes-specific format knowledge
 * lives in this directory; nothing downstream may reference it.
 *
 * Ground truth (probed live 2026-08-18, Hermes Agent v0.20.1, schema v26):
 * one SQLite database per profile — `<root>/state.db` for the default
 * profile, `<root>/profiles/<name>/state.db` for the rest — holding a
 * `sessions` table (with cwd, git_repo_root, per-session token/cost columns,
 * `last_activity_at`) and a `messages` table with explicit `tool_call_id`
 * pairing. There is NO JSONL transcript fallback: the DB is the only source.
 * Timestamps are REAL epoch seconds. Subagent sessions carry
 * `source='subagent'` and `parent_session_id` — they are never top-level
 * runs; they render as agent lanes inside their parent.
 */

export const ADAPTER_NAME = 'hermes';

export const HERMES_BUCKET = '✦ Hermes tasks';

/**
 * Adapter-level degradations from the last COMPLETED detect() call, for the
 * scan index. Each detect() collects into its own local array and swaps it in
 * at the end, so two concurrent scans (the server handles requests in
 * parallel) cannot clobber each other's warnings mid-run.
 */
let lastWarnings = [];

export function scanWarnings() {
  return lastWarnings;
}

const SESSION_COLS = [
  'id',
  'source',
  'title',
  'model',
  'cwd',
  'git_branch',
  'git_repo_root',
  'started_at',
  'ended_at',
  'end_reason',
  'last_activity_at',
  'message_count',
  'tool_call_count',
  'input_tokens',
  'output_tokens',
  'estimated_cost_usd',
  'archived',
  'hidden',
  'profile_name',
  'rewind_count',
];

/**
 * @typedef {Object} HermesRunRef
 * @property {string} runId        `hermes:<session id>`
 * @property {'hermes'} adapter
 * @property {'session'} kind      Always — Hermes has no workflow concept.
 * @property {string} title
 * @property {string} project      git repo root, a deliberate cwd, or the bucket.
 * @property {boolean} projectFromCwd  false for `✦ Hermes tasks` bucket runs.
 * @property {boolean} projectExists  Whether the recorded cwd is a directory right now.
 * @property {string} dbPath       Absolute path of the owning state.db.
 * @property {string} sessionId
 * @property {string} profile      Profile name ('default' for <root>/state.db).
 * @property {string|null} cwd
 * @property {string} source       'cli' | 'telegram' | … — gates resume.
 * @property {number} messageCount
 * @property {string} lastActivityAt
 * @property {string} [startedAt]
 * @property {string} modifiedAt
 * @property {number} sizeBytes    message_count, a display/fallback proxy.
 */

/**
 * Every non-subagent, non-hidden Hermes session under the given roots.
 * Archived sessions are included (archiving is list-tidying, not deletion,
 * and rungraph is the history tool) and marked in `ext.hermes` by parse().
 */
export async function detect(rootDirs) {
  const warnings = [];
  if (!(await loadSqlite())) {
    // Deliberate deviation from the spec's unconditional wording: the warning
    // (stderr and index) fires only when a Hermes DB actually exists to be
    // skipped. A Node-20 user with no Hermes install has nothing to be warned
    // about, and a standing false alarm is exactly the trust cost the
    // precision-over-recall rule exists to avoid.
    if (await anyDbExists(rootDirs)) {
      warnings.push({ adapter: ADAPTER_NAME, reason: unavailableReason() });
    }
    lastWarnings = warnings;
    return [];
  }

  // runId → ref, so the same session id in two profile DBs (realistically a
  // copied profile, i.e. the same session) keeps one entry: most recently
  // active wins, and the dedupe is reported rather than silent.
  const byId = new Map();
  const dirExists = new Map();
  for (const root of rootDirs) {
    for (const { dbPath, profile } of await candidateDbs(root)) {
      let refs;
      try {
        refs = await refsFromDb(dbPath, profile, dirExists);
      } catch (err) {
        warnings.push({
          adapter: ADAPTER_NAME,
          reason: `${dbPath}: ${String(err?.message ?? err)}`,
        });
        continue;
      }
      for (const ref of refs) {
        const prev = byId.get(ref.runId);
        if (!prev) {
          byId.set(ref.runId, ref);
          continue;
        }
        const winner = prev.modifiedAt >= ref.modifiedAt ? prev : ref;
        byId.set(ref.runId, winner);
        warnings.push({
          adapter: ADAPTER_NAME,
          reason: `session ${ref.sessionId} exists in both ${prev.dbPath} and ${ref.dbPath}; showing the most recently active copy`,
        });
      }
    }
  }

  const refs = [...byId.values()];
  refs.sort((a, b) =>
    a.modifiedAt !== b.modifiedAt
      ? a.modifiedAt < b.modifiedAt
        ? 1
        : -1
      : a.runId < b.runId
        ? -1
        : a.runId > b.runId
          ? 1
          : 0,
  );
  lastWarnings = warnings;
  return refs;
}

/** `<root>/state.db` (the default profile) plus each `<root>/profiles/<name>/state.db`. */
async function candidateDbs(root) {
  const out = [];
  if (await statOrNull(join(root, 'state.db'))) {
    out.push({ dbPath: join(root, 'state.db'), profile: 'default' });
  }
  let names = [];
  try {
    names = await readdir(join(root, 'profiles'), { withFileTypes: true });
  } catch {
    /* no profiles dir */
  }
  for (const ent of names) {
    // No isDirectory() gate: a symlinked profile dir reports as a symlink,
    // and statOrNull (which follows links) on the state.db is the real test.
    const dbPath = join(root, 'profiles', ent.name, 'state.db');
    if (await statOrNull(dbPath)) out.push({ dbPath, profile: ent.name });
  }
  return out;
}

async function anyDbExists(rootDirs) {
  for (const root of rootDirs) {
    if ((await candidateDbs(root)).length > 0) return true;
  }
  return false;
}

async function refsFromDb(dbPath, profile, dirExists) {
  const { db, close } = await openDb(dbPath);
  try {
    const have = tableColumns(db, 'sessions');
    if (!have.has('id')) throw new Error('no sessions table — not a Hermes state.db');
    const where = [
      have.has('source') ? "source != 'subagent'" : null,
      have.has('hidden') ? 'hidden = 0' : null,
    ]
      .filter(Boolean)
      .join(' AND ');
    const rows = db
      .prepare(
        `SELECT ${selectList(have, SESSION_COLS)} FROM sessions` +
          (where ? ` WHERE ${where}` : '') +
          (have.has('started_at') ? ' ORDER BY started_at DESC' : ''),
      )
      .all();

    const mHave = tableColumns(db, 'messages');
    const activeFilter = mHave.has('active') ? ' AND active = 1' : '';
    const activity = activityProbe(db, have, mHave);
    const refs = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) continue;
      refs.push(await refFromRow(db, row, dbPath, profile, dirExists, activeFilter, activity));
    }
    return refs;
  } finally {
    await close();
  }
}

/**
 * The freshest-activity probe behind `modifiedAt` and `fingerprint`. Two
 * Hermes truths make the session row alone insufficient (measured on the real
 * corpus): `last_activity_at` is stamped at turn boundaries, lagging the
 * newest message by 20–50s (the live badge would flicker off mid-turn), and a
 * delegated child writes under its OWN session id without touching the
 * parent's row at all (the parse cache would serve a frozen graph for the
 * whole delegation). So activity is the max over the session's and its
 * descendants' newest message timestamps, and the message total sums the
 * whole tree — one recursive-CTE lookup per session on indexed columns.
 */
function activityProbe(db, sHave, mHave) {
  const canMsgs = mHave.has('session_id') && mHave.has('timestamp');
  const kids = sHave.has('parent_session_id');
  const tree = kids
    ? `WITH RECURSIVE fam(id) AS (
         SELECT ? UNION
         SELECT s.id FROM sessions s JOIN fam f ON s.parent_session_id = f.id
       )`
    : '';
  const famIds = kids ? 'SELECT id FROM fam' : 'SELECT ?';
  const tsStmt = canMsgs
    ? db.prepare(`${tree} SELECT MAX(timestamp) AS ts FROM messages WHERE session_id IN (${famIds})`)
    : null;
  const countCol = sHave.has('message_count') ? 'COALESCE(SUM(message_count), 0)' : '0';
  const countStmt = kids
    ? db.prepare(`${tree} SELECT ${countCol} AS msgs FROM sessions WHERE id IN (${famIds})`)
    : null;
  return (sessionId, ownCount) => {
    let maxTs;
    let msgs = ownCount;
    try {
      const ts = tsStmt?.get(sessionId)?.ts;
      if (Number.isFinite(ts)) maxTs = ts;
      const total = countStmt?.get(sessionId)?.msgs;
      if (Number.isFinite(total) && total > 0) msgs = total;
    } catch {
      /* degraded schema — the session row alone still works */
    }
    return { maxTs, msgs };
  };
}

async function refFromRow(db, row, dbPath, profile, dirExists, activeFilter, activity) {
  const cwd = typeof row.cwd === 'string' && row.cwd ? row.cwd : null;
  if (cwd && !dirExists.has(cwd)) {
    // The detect-only existence probe (same rule as the other adapters): it
    // feeds resumeInfo's cwd decision and the project tier below.
    dirExists.set(cwd, (await statOrNull(cwd))?.isDirectory() ?? false);
  }
  const cwdExists = cwd ? dirExists.get(cwd) : false;
  const { project, projectFromCwd } = projectFor(row, cwd, cwdExists);

  const ownCount = Number.isFinite(row.message_count) ? row.message_count : 0;
  const { maxTs, msgs } = activity(row.id, ownCount);
  const startedAt = iso(row.started_at);
  const modifiedAt =
    latest(iso(row.last_activity_at), iso(row.ended_at), iso(maxTs)) ??
    startedAt ??
    new Date(0).toISOString();

  return {
    runId: `${ADAPTER_NAME}:${row.id}`,
    adapter: ADAPTER_NAME,
    kind: 'session',
    title: titleFor(db, row, activeFilter),
    project,
    projectFromCwd,
    projectExists: cwdExists,
    dbPath,
    sessionId: row.id,
    profile: typeof row.profile_name === 'string' && row.profile_name ? row.profile_name : profile,
    cwd,
    source: typeof row.source === 'string' ? row.source : '',
    // The whole delegation tree's message total — the fingerprint half that
    // moves while subagents write. Display size stays the session's own.
    messageCount: msgs,
    lastActivityAt: modifiedAt,
    startedAt,
    modifiedAt,
    sizeBytes: ownCount,
  };
}

/** The latest of several ISO timestamps (lexicographic — same format). */
function latest(...times) {
  let out;
  for (const t of times) {
    if (typeof t === 'string' && (!out || t > out)) out = t;
  }
  return out;
}

/**
 * The three-tier project rule — the answer to "Hermes runs aren't tied to a
 * project":
 *
 * 1. `git_repo_root` set → use it: a Hermes run inside a repo groups in the
 *    sidebar next to Claude Code and Codex runs of the same repo.
 * 2. else a cwd that is set, exists, and is not the home directory → use it:
 *    running `hermes --in <dir>` is deliberate intent.
 * 3. else the literal group label `✦ Hermes tasks`, projectFromCwd false —
 *    the sidebar already groups by arbitrary project strings, so this needs
 *    zero frontend work, and `--project` filtering can never match it.
 */
function projectFor(row, cwd, cwdExists) {
  if (typeof row.git_repo_root === 'string' && row.git_repo_root) {
    return { project: row.git_repo_root, projectFromCwd: true };
  }
  if (cwd && cwdExists && resolve(cwd) !== homedir()) {
    return { project: cwd, projectFromCwd: true };
  }
  return { project: HERMES_BUCKET, projectFromCwd: false };
}

/**
 * `title` column; for untitled sessions, the first user prompt via one
 * single-row indexed query on the already-open handle (cheaper than the
 * head-reads the JSONL adapters do per run); the raw session id only when
 * the session has no user message at all.
 */
function titleFor(db, row, activeFilter) {
  if (typeof row.title === 'string' && row.title.trim()) return snippet(row.title, 100);
  try {
    const first = db
      .prepare(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'user'${activeFilter} ORDER BY id LIMIT 1`,
      )
      .get(row.id);
    const text = typeof first?.content === 'string' ? first.content : '';
    if (text.trim()) return snippet(text, 100);
  } catch {
    /* messages table degraded — fall through to the id */
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// File-layout knowledge exposed to the vendor-neutral layers.
// ---------------------------------------------------------------------------

/**
 * The server rebuilds refs via fresh detect() per request, so both values are
 * current — and both cover the whole delegation tree (see activityProbe):
 * a subagent writing under its own session id must invalidate the parent's
 * cached graph, because the parent's IR embeds the child's lane. This
 * replaces the file-shaped mtime+size fallback, which is wrong for a
 * database.
 */
export function fingerprint(ref) {
  return `${ref.lastActivityAt}:${ref.messageCount}`;
}

/**
 * Live tail: every Hermes commit appends frames to `state.db-wal`, fs.watch
 * fires on the append, and the existing debounce + re-parse + diff pipeline
 * works unchanged.
 *
 * The DB's DIRECTORY is the load-bearing target, not a nicety: SQLite deletes
 * the `-wal` when the last connection closes and recreates it (new inode) on
 * the next write, and the core watcher arms a path once and never re-arms a
 * recreated file — so a `-wal`-only watch goes deaf the moment Hermes
 * restarts, until a checkpoint finally touches the main file. A non-recursive
 * watch on the directory reports its children's writes on both macOS
 * (fsevents) and Linux (inotify IN_MODIFY), surviving any number of `-wal`
 * lifecycles. The file targets stay as belt and braces.
 */
export function watchTargets(ref) {
  return [
    { path: dirname(ref.dbPath), recursive: false },
    { path: ref.dbPath, recursive: false },
    { path: ref.dbPath + '-wal', recursive: false },
  ];
}

/** Bucket runs never match a `--project` path filter. */
export function matchesProject() {
  return false;
}

/**
 * How to continue this session in a real terminal. Pure string construction
 * from the RunRef — the existence probe behind `projectExists` already ran in
 * detect(), where the I/O lives.
 *
 * `hermes --resume <session id>` is confirmed in hermes_cli/_parser.py. Only
 * `cli`-source sessions resume: a Telegram/WhatsApp gateway session cannot be
 * resumed into a terminal (precision over recall). Hermes has no fork flag,
 * so no forkArgv — the dashboard's fork checkbox simply doesn't render.
 *
 * @param {HermesRunRef} ref
 * @returns {{ argv: string[], cwd: string|null, copyCommand: string }|null}
 */
export function resumeInfo(ref) {
  if (ref.kind !== 'session' || ref.source !== 'cli') return null;
  const argv = ['hermes', '--resume', ref.sessionId];
  const cwd = ref.projectExists ? ref.cwd : null;
  const command = argv.map(shellQuote).join(' ');
  return {
    argv,
    cwd,
    copyCommand: cwd ? `cd ${shellQuote(cwd)} && ${command}` : command,
  };
}
