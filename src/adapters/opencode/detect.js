import { dirname, join } from 'node:path';
import { statOrNull, shellQuote } from '../../util.js';
import { snippet } from '../../ir.js';
import {
  ADAPTER_NAME,
  DB_FILE,
  MESSAGE_COLS,
  PROJECT_COLS,
  SESSION_COLS,
  iso,
  loadSqlite,
  modelName,
  num,
  openDb,
  parseData,
  selectList,
  tableColumns,
  unavailableReason,
} from './db.js';

/**
 * opencode adapter — detection. All opencode-specific format knowledge lives
 * in this directory; nothing downstream may reference it.
 *
 * Ground truth (probed live 2026-08-20 against opencode 1.15.6 → 1.18.19):
 * ONE global SQLite database, `~/.local/share/opencode/opencode.db`, holding
 * `project` / `session` / `message` / `part` tables. Timestamps are epoch
 * MILLISECONDS. Everything interesting about a message or a part lives in a
 * JSON `data` blob. Root sessions (`parent_id IS NULL`) are runs; subagent
 * sessions are lanes inside their parent and never list independently.
 *
 * Three traps this file is shaped by:
 *
 * 1. **Session ids sort DESCENDING with time** (`ses_1b80…` is OLDER than
 *    `ses_19ac…`) while message and part ids sort ascending. Every ordering
 *    here is by `time_created`, never by id.
 * 2. **File mtime is not a liveness source.** Merely opening the DB bumps it,
 *    and one global DB means a file-mtime fingerprint would mark every
 *    opencode session live whenever any one of them was active. Liveness is
 *    `session.time_updated`, which lands 3–61s after the session's last
 *    message on every row measured.
 * 3. **opencode's per-session UI-state table is transient.** It held 18 rows
 *    all afternoon and read 0 immediately after one opencode launch, with
 *    `message`/`part` untouched — so a signal derived from it would vanish
 *    between two viewings of one finished run. Nothing in this directory
 *    reads it, and a grep of this directory for its name must return
 *    NOTHING — which is why the name itself appears only in the test that
 *    enforces that ("never queries" in tests/opencode.test.js).
 */

export { ADAPTER_NAME };

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

/**
 * @typedef {Object} OpencodeRunRef
 * @property {string} runId        `opencode:<session id>`
 * @property {'opencode'} adapter
 * @property {'session'} kind      Always — opencode has no workflow concept.
 * @property {string} title
 * @property {string} project      `project.worktree` — always a real path.
 * @property {true} projectFromCwd
 * @property {boolean} projectExists  Whether the worktree is a directory right now.
 * @property {string} dbPath       Absolute path of the owning opencode.db.
 * @property {string} sessionId
 * @property {string|null} directory  The session's own cwd, when recorded.
 * @property {string|undefined} agent  Resolved agent name, never 'compaction'.
 * @property {string|undefined} model
 * @property {string|undefined} version  `session.version` — the opencode that wrote it.
 * @property {boolean} archived
 * @property {number} messageCount  Whole subagent tree — the fingerprint half that moves.
 * @property {string} [startedAt]
 * @property {string} modifiedAt
 * @property {number} sizeBytes    Own message count, a display proxy (Hermes precedent).
 */

/**
 * Every ROOT opencode session under the given roots, newest first.
 *
 * Archived sessions are included and flagged — rungraph is the history tool,
 * and archiving is list-tidying, not deletion.
 */
export async function detect(rootDirs) {
  const warnings = [];
  if (!(await loadSqlite())) {
    // Deliberately conditional, matching Hermes: the warning fires only when
    // an opencode DB actually exists to be skipped. A Node-20 user with no
    // opencode install has nothing to be warned about, and a standing false
    // alarm is exactly the trust cost the precision rule exists to avoid.
    if (await anyDbExists(rootDirs)) {
      warnings.push({ adapter: ADAPTER_NAME, reason: unavailableReason() });
    }
    lastWarnings = warnings;
    return [];
  }

  // runId → ref. The default resolves to exactly one DB, but defaultRootDirs()
  // returns an ARRAY per adapter, so a copied data dir or an XDG_DATA_HOME
  // override can present the same session twice. Most recently active wins,
  // and the dedupe is REPORTED rather than resolved silently.
  const byId = new Map();
  const dirExists = new Map();
  for (const root of rootDirs) {
    const dbPath = join(root, DB_FILE);
    if (!(await statOrNull(dbPath))) {
      const legacy = await legacyStoreWarning(root);
      if (legacy) warnings.push({ adapter: ADAPTER_NAME, reason: legacy });
      continue;
    }
    let result;
    try {
      result = await refsFromDb(dbPath, dirExists);
    } catch (err) {
      warnings.push({ adapter: ADAPTER_NAME, reason: `${dbPath}: ${String(err?.message ?? err)}` });
      continue;
    }
    if (result.refs.length === 0) {
      // A DB with no sessions AND a legacy JSON tree beside it is the
      // un-migrated install: opencode migrates on launch, so the fix is one
      // launch, not a second parser for a format the vendor is abandoning.
      const legacy = await legacyStoreWarning(root);
      if (legacy) warnings.push({ adapter: ADAPTER_NAME, reason: legacy });
    }
    for (const ref of result.refs) {
      const prev = byId.get(ref.runId);
      if (!prev) {
        byId.set(ref.runId, ref);
        continue;
      }
      byId.set(ref.runId, prev.modifiedAt >= ref.modifiedAt ? prev : ref);
      warnings.push({
        adapter: ADAPTER_NAME,
        reason: `session ${ref.sessionId} exists in both ${prev.dbPath} and ${ref.dbPath}; showing the most recently active copy`,
      });
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

async function anyDbExists(rootDirs) {
  for (const root of rootDirs) {
    if (await statOrNull(join(root, DB_FILE))) return true;
  }
  return false;
}

/**
 * The pre-SQLite JSON store, which opencode migrates on launch. rungraph does
 * not read it (a second parser for a format the vendor is actively abandoning
 * is dead code on day one) — it says so, once, and names the fix.
 */
async function legacyStoreWarning(root) {
  for (const kind of ['session', 'message', 'part']) {
    if (await statOrNull(join(root, 'storage', kind))) {
      return `${join(root, 'storage')} holds a pre-SQLite opencode store, which rungraph does not read; launch opencode once to migrate it into ${DB_FILE}`;
    }
  }
  return null;
}

async function refsFromDb(dbPath, dirExists) {
  const { db, close } = await openDb(dbPath);
  try {
    const sHave = tableColumns(db, 'session');
    if (!sHave.has('id')) throw new Error(`no session table — not an ${DB_FILE}`);
    const pHave = tableColumns(db, 'project');
    const mHave = tableColumns(db, 'message');

    const worktrees = projectIndex(db, pHave);
    const activity = activityProbe(db, sHave, mHave);
    const rows = db
      .prepare(
        `SELECT ${selectList(sHave, SESSION_COLS)} FROM session` +
          (sHave.has('parent_id') ? ' WHERE parent_id IS NULL' : ''),
      )
      .all();

    const refs = [];
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id) continue;
      refs.push(await refFromRow(db, row, dbPath, worktrees, dirExists, activity, mHave));
    }
    return { refs };
  } finally {
    await close();
  }
}

/** project id → worktree path. One small table; read once per open. */
function projectIndex(db, pHave) {
  const out = new Map();
  if (!pHave.has('id')) return out;
  try {
    for (const p of db.prepare(`SELECT ${selectList(pHave, PROJECT_COLS)} FROM project`).all()) {
      if (typeof p.id === 'string' && typeof p.worktree === 'string' && p.worktree) {
        out.set(p.id, p.worktree);
      }
    }
  } catch {
    /* no project table — projectFor falls back to the session's directory */
  }
  return out;
}

/**
 * Liveness and size over the whole subagent TREE, not the session row alone.
 *
 * A subagent writes under its OWN session id and never touches its parent's
 * row, while the parent's IR embeds the child's lane — so a parent-row-only
 * fingerprint would serve a frozen graph for the whole duration of a task.
 * `session.time_updated` is still the source (fact 10: it lands 3–61s after
 * the last message, wider than the 45s live window, so `max(message)` alone
 * would flicker the badge off mid-turn); the tree is what makes it move.
 *
 * One recursive CTE per session, on the indexed `session(parent_id)` and
 * `message(session_id, …)` columns.
 */
function activityProbe(db, sHave, mHave) {
  const kids = sHave.has('parent_id');
  const tree = kids
    ? `WITH RECURSIVE fam(id) AS (
         SELECT ? UNION
         SELECT s.id FROM session s JOIN fam f ON s.parent_id = f.id
       )`
    : '';
  const famIds = kids ? 'SELECT id FROM fam' : 'SELECT ?';
  const updatedStmt = sHave.has('time_updated')
    ? db.prepare(`${tree} SELECT MAX(time_updated) AS ts FROM session WHERE id IN (${famIds})`)
    : null;
  const countStmt = mHave.has('session_id')
    ? db.prepare(`${tree} SELECT COUNT(*) AS c FROM message WHERE session_id IN (${famIds})`)
    : null;
  const ownStmt = mHave.has('session_id')
    ? db.prepare('SELECT COUNT(*) AS c FROM message WHERE session_id = ?')
    : null;
  return (sessionId) => {
    let updated;
    let messages = 0;
    let own = 0;
    try {
      const ts = updatedStmt?.get(sessionId)?.ts;
      if (Number.isFinite(ts)) updated = ts;
      messages = num(countStmt?.get(sessionId)?.c);
      own = num(ownStmt?.get(sessionId)?.c);
    } catch {
      /* degraded schema — the session row alone still works */
    }
    return { updated, messages, own };
  };
}

async function refFromRow(db, row, dbPath, worktrees, dirExists, activity, mHave) {
  const directory = typeof row.directory === 'string' && row.directory ? row.directory : null;
  const project = worktrees.get(row.project_id) ?? directory ?? '(unknown project)';
  if (!dirExists.has(project)) {
    // The one detect-only existence probe (same rule as every other adapter):
    // it feeds resumeInfo's cwd decision and toIndexEntry's `loose` flag.
    dirExists.set(project, (await statOrNull(project))?.isDirectory() ?? false);
  }

  const { updated, messages, own } = activity(row.id);
  const startedAt = iso(row.time_created);
  const modifiedAt = iso(updated) ?? startedAt ?? new Date(0).toISOString();

  return {
    runId: `${ADAPTER_NAME}:${row.id}`,
    adapter: ADAPTER_NAME,
    // opencode has no workflow concept: every run is a session.
    kind: 'session',
    title: titleFor(db, row, mHave),
    project,
    // Always a real path (a git worktree, or the session's own directory), so
    // opencode needs no vendor bucket label: a deleted worktree falls through
    // projectExists into the generic '✦ loose runs' bucket toIndexEntry
    // already derives. That is why this adapter exports no matchesProject —
    // scan() short-circuits on projectFromCwd and never consults the hook.
    projectFromCwd: true,
    projectExists: dirExists.get(project),
    dbPath,
    sessionId: row.id,
    directory,
    agent: agentFor(db, row, mHave),
    model: modelName(row.model),
    version: typeof row.version === 'string' && row.version ? row.version : undefined,
    archived: Number.isFinite(row.time_archived) && row.time_archived > 0,
    messageCount: messages,
    startedAt,
    modifiedAt,
    sizeBytes: own,
  };
}

/**
 * `session.title`; for untitled sessions, the first user prompt that a HUMAN
 * typed. Compaction fabricates a `role=user` message carrying exactly one
 * `compaction` part and no `text` part — a prompt nobody wrote — so the title
 * search reads parts and takes the first real text, never the synthetic turn.
 */
function titleFor(db, row, mHave) {
  if (typeof row.title === 'string' && row.title.trim()) return snippet(row.title, 100);
  try {
    if (!mHave.has('session_id')) return row.id;
    const messages = db
      .prepare(
        `SELECT ${selectList(mHave, MESSAGE_COLS)} FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 20`,
      )
      .all(row.id);
    const partsStmt = db.prepare(
      'SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id',
    );
    for (const m of messages) {
      if (parseData(m.data)?.role !== 'user') continue;
      for (const p of partsStmt.all(m.id)) {
        const d = parseData(p.data);
        if (d?.type !== 'text') continue;
        const text = typeof d.text === 'string' ? d.text : '';
        if (text.trim()) return snippet(text, 100);
      }
    }
  } catch {
    /* degraded schema — fall through to the id */
  }
  return row.id;
}

/**
 * The run's agent. `session.agent` is nullable (observed NULL on a fork), so
 * the fallback is the modal `message.data.agent` — EXCLUDING `compaction`, a
 * pseudo-agent opencode stamps on the messages a compaction writes. It is not
 * an agent anybody chose and must never be presented as one.
 */
function agentFor(db, row, mHave) {
  const own = typeof row.agent === 'string' && row.agent.trim() ? row.agent.trim() : '';
  if (own && own !== 'compaction') return own;
  try {
    if (!mHave.has('session_id')) return undefined;
    const tally = new Map();
    for (const m of db
      .prepare(`SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 200`)
      .all(row.id)) {
      const agent = parseData(m.data)?.agent;
      if (typeof agent !== 'string' || !agent || agent === 'compaction') continue;
      tally.set(agent, (tally.get(agent) ?? 0) + 1);
    }
    let best;
    let bestN = 0;
    for (const [agent, n] of tally) {
      if (n > bestN) [best, bestN] = [agent, n];
    }
    return best;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// File-layout knowledge exposed to the vendor-neutral layers.
// ---------------------------------------------------------------------------

/**
 * Per SESSION, never the DB file. One global database means a file-mtime
 * fingerprint would mark every opencode run live whenever any one of them was
 * written — and merely OPENING the DB bumps that mtime, so it is not even a
 * valid signal for the run that did move. `modifiedAt` and `messageCount`
 * both cover the subagent tree (see activityProbe).
 */
export function fingerprint(ref) {
  return `${ref.modifiedAt}:${ref.messageCount}`;
}

/**
 * Live tail: opencode commits append frames to `opencode.db-wal`, fs.watch
 * fires, and the existing debounce + re-parse + diff pipeline works unchanged.
 *
 * The DB's DIRECTORY is the load-bearing target, not a nicety: SQLite deletes
 * the `-wal` when the last connection closes and recreates it (new inode) on
 * the next write, and the core watcher arms a path once and never re-arms a
 * recreated file — so a `-wal`-only watch goes deaf the moment opencode
 * restarts. The file targets stay as belt and braces.
 *
 * KNOWN PROPERTY, not a defect: every opencode run returns the same three
 * targets, so any opencode write wakes every watched opencode run for a
 * fingerprint check. That check is one indexed SELECT; the debounce and the
 * diff pipeline absorb the rest.
 */
export function watchTargets(ref) {
  return [
    { path: dirname(ref.dbPath), recursive: false },
    { path: ref.dbPath, recursive: false },
    { path: ref.dbPath + '-wal', recursive: false },
  ];
}

/**
 * How to continue this session in a real terminal — pure string construction
 * from the RunRef; the existence probe behind `projectExists` already ran in
 * detect(), where the I/O lives.
 *
 * `opencode --session <id>` continues, `--fork` forks instead. That makes
 * opencode the second adapter after Claude Code to render the dashboard's
 * fork checkbox. Every root session resumes: opencode has no non-terminal
 * session kind (Hermes's Telegram gateway) to gate out.
 *
 * @param {OpencodeRunRef} ref
 */
export function resumeInfo(ref) {
  if (ref.kind !== 'session') return null;
  const argv = ['opencode', '--session', ref.sessionId];
  const forkArgv = [...argv, '--fork'];
  const cwd = ref.projectExists ? ref.project : null;
  const line = (parts) => {
    const command = parts.map(shellQuote).join(' ');
    return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
  };
  return {
    argv,
    forkArgv,
    cwd,
    copyCommand: line(argv),
    forkCopyCommand: line(forkArgv),
  };
}
