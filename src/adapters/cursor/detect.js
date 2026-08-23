import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { statOrNull, shellQuote } from '../../util.js';
import { snippet } from '../../ir.js';
import {
  ADAPTER_NAME,
  CLI_CHATS_DIR,
  CLI_META_FILE,
  CLI_STORE_FILE,
  CURSOR_BUCKET,
  IDE_DB_FILE,
  VALUE_SIZE_GUARD,
  instant,
  iso,
  isoAny,
  loadSqlite,
  num,
  openDb,
  str,
  unavailableReason,
} from './db.js';
import { bubbleRow, composerRecords, hasKvTable } from './ide/read.js';
import {
  composerStartedAt,
  composerUpdatedAt,
  headersOf,
  isCloudComposer,
  isSubagentComposer,
  isSupportedVersion,
  isValidComposer,
} from './ide/parse.js';
import { blobCount, decodeMessageBlob, hasStoreTables, readBlob, readMeta0, readMetaJson, rootMessageIds } from './cli/read.js';
import { unwrapUserQuery } from './cli/parse.js';

/**
 * Cursor adapter — detection over TWO surfaces that share one vendor, one
 * rail entry, one `matchesProject`, one bucket label and one client entry:
 *
 *   ide  `<userData>/User/globalStorage/state.vscdb`, table `cursorDiskKV`,
 *        every project's conversations in one shared database.
 *   cli  `<data>/chats/<md5(cwd)>/<agentId>/{meta.json, store.db}`, one
 *        store per chat.
 *
 * Roots are classified BY SHAPE, not by position in the array: a root that
 * contains `state.vscdb` is an IDE root, one that contains `chats/` is a CLI
 * root, and one that is neither is skipped silently — an uninstalled surface
 * is not a warning. `defaultRootDirs()` in scanner.js composes both roots
 * into one array, each env-overridable, each disabled alone by `''`.
 *
 * Everything Cursor-specific lives in this directory; nothing downstream may
 * reference it. Pure: no server imports, no I/O beyond the stores themselves
 * (plus the one stat-only probe of each run's recorded project, which feeds
 * `resumeInfo`'s cwd rule and the index's `loose` flag).
 *
 * Refs carry `surface: 'ide' | 'cli'`; `parse`, `watchTargets` and
 * `resumeInfo` dispatch on it.
 */

export { ADAPTER_NAME };

let lastWarnings = [];

/** Adapter-level degradations from the last COMPLETED detect() call. */
export function scanWarnings() {
  return lastWarnings;
}

/**
 * @typedef {Object} CursorRunRef
 * @property {string} runId          `cursor:<composerId>` | `cursor:<agentId>`
 * @property {'cursor'} adapter
 * @property {'session'} kind        Always — Cursor has no workflow concept.
 * @property {'ide'|'cli'} surface
 * @property {string} title
 * @property {string} project        A path, or the `✦ Cursor chats` bucket label.
 * @property {boolean} projectFromCwd  false only for bucket runs.
 * @property {boolean} projectExists
 * @property {string} dbPath         `state.vscdb` (ide) or `store.db` (cli).
 * @property {string} [startedAt]
 * @property {string} modifiedAt
 * @property {number} sizeBytes      Header count (ide) / message count (cli) — a display proxy.
 * @property {boolean} [archived]    ide: `isArchived === true`.
 * — ide —
 * @property {string} [composerId]
 * @property {number} [version]      `_v`
 * @property {boolean} [supported]   `_v >= 9`
 * @property {number} [treeUpdatedAt]  max `modifiedAt` (ms) over parent + children (both routes).
 * @property {number} [treeHeaders]    sum of header counts over the same set.
 * — cli —
 * @property {string} [agentId]
 * @property {string} [chatDir]
 * @property {number} [createdAtMs]
 * @property {number} [updatedAtMs]
 * @property {number} [blobCount]
 * @property {number} [schemaVersion]
 */

export async function detect(rootDirs) {
  const warnings = [];
  if (!(await loadSqlite())) {
    // Conditional, as for Hermes and opencode: the warning fires only when a
    // Cursor store actually exists to be skipped.
    if (await anyStoreExists(rootDirs)) warnings.push({ adapter: ADAPTER_NAME, reason: unavailableReason() });
    lastWarnings = warnings;
    return [];
  }

  const byId = new Map();
  const dirExists = new Map();
  const add = (ref) => {
    const prev = byId.get(ref.runId);
    if (!prev) {
      byId.set(ref.runId, ref);
      return;
    }
    byId.set(ref.runId, prev.modifiedAt >= ref.modifiedAt ? prev : ref);
    warnings.push({
      adapter: ADAPTER_NAME,
      reason: `run ${ref.runId} exists in both ${prev.dbPath} and ${ref.dbPath}; showing the most recently active copy`,
    });
  };

  for (const root of rootDirs) {
    const idePath = join(root, IDE_DB_FILE);
    if (await statOrNull(idePath)) {
      try {
        for (const ref of await ideRefs(idePath, dirExists, warnings)) add(ref);
      } catch (err) {
        warnings.push({ adapter: ADAPTER_NAME, reason: `${idePath}: ${String(err?.message ?? err)}` });
      }
    }
    const chats = join(root, CLI_CHATS_DIR);
    if ((await statOrNull(chats))?.isDirectory()) {
      for (const ref of await cliRefs(chats, dirExists, warnings)) add(ref);
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

async function anyStoreExists(rootDirs) {
  for (const root of rootDirs) {
    if (await statOrNull(join(root, IDE_DB_FILE))) return true;
    if (await statOrNull(join(root, CLI_CHATS_DIR))) return true;
  }
  return false;
}

async function dirProbe(dirExists, path) {
  if (!dirExists.has(path)) dirExists.set(path, (await statOrNull(path))?.isDirectory() ?? false);
  return dirExists.get(path);
}

// ------------------------------------------------------------------ IDE

/**
 * One prefix scan of `composerData:`, then per-composer filtering:
 *
 * 1. Cursor's own validity predicate.
 * 2. At least one header — drops the empty "new chat" placeholders (36 of
 *    49 on the probe machine). A conversation with no messages is not a run.
 * 3. Not a subagent (Cursor's `evg`); subagents are re-parented in parse().
 * 4. Not a cloud/background agent.
 * 5. `_v >= 9` → parseable; below → listed with `supported: false`, so the
 *    run is visibly there and visibly unread rather than silently missing.
 */
async function ideRefs(dbPath, dirExists, warnings) {
  const { db, close } = await openDb(dbPath);
  try {
    if (!hasKvTable(db)) throw new Error(`no cursorDiskKV table — not a Cursor ${IDE_DB_FILE}`);
    const records = composerRecords(db);
    const all = new Map();
    const unread = { oversized: 0, invalid: 0 };
    for (const r of records) {
      if (!r.json) {
        // Never-blank-screen: a conversation the adapter could not read is
        // skipped AND counted AND surfaced. A NULL record is different — it
        // is Cursor's own deletion marker (2 of 49 on the probe machine) and
        // would be a standing false alarm, so it is skipped silently.
        if (r.miss === 'oversized' || r.miss === 'invalid') unread[r.miss]++;
        continue;
      }
      const c = r.json;
      if (!isValidComposer(c)) continue;
      const id = typeof c.composerId === 'string' && c.composerId ? c.composerId : r.composerId;
      all.set(id, c);
    }
    // Children by BOTH routes: a parent's `subComposerIds`, and a child's
    // `subagentInfo.parentComposerId` — for the TREE fingerprint. parse()
    // resolves the same two routes itself, live, at parse time.
    const children = new Map();
    const link = (parent, child) => {
      if (typeof parent !== 'string' || typeof child !== 'string' || !parent || !child || parent === child) return;
      if (!children.has(parent)) children.set(parent, []);
      if (!children.get(parent).includes(child)) children.get(parent).push(child);
    };
    for (const [id, c] of all) {
      for (const kid of Array.isArray(c.subComposerIds) ? c.subComposerIds : []) link(id, kid);
      const parent = c.subagentInfo?.parentComposerId;
      if (typeof parent === 'string') link(parent, id);
    }

    if (unread.oversized + unread.invalid > 0) {
      const parts = [];
      if (unread.oversized) parts.push(`${unread.oversized} over the ${VALUE_SIZE_GUARD / 1e6} MB value guard`);
      if (unread.invalid) parts.push(`${unread.invalid} not valid JSON`);
      warnings.push({
        adapter: ADAPTER_NAME,
        reason: `${dbPath}: ${unread.oversized + unread.invalid} conversation record${unread.oversized + unread.invalid === 1 ? '' : 's'} could not be read (${parts.join(', ')}) and ${unread.oversized + unread.invalid === 1 ? 'is' : 'are'} not listed`,
      });
    }
    const refs = [];
    for (const [id, c] of all) {
      if (headersOf(c).length === 0) continue;
      if (isSubagentComposer(c)) continue;
      if (isCloudComposer(c)) continue;
      refs.push(await ideRef(db, dbPath, id, c, all, children, dirExists));
    }
    return refs;
  } finally {
    await close();
  }
}

async function ideRef(db, dbPath, id, c, all, children, dirExists) {
  const tree = treeStats(id, all, children);
  const { project, projectFromCwd } = ideProject(c);
  const projectExists = projectFromCwd ? await dirProbe(dirExists, project) : false;
  const startedAt = isoAny(composerStartedAt(c));
  const modifiedAt = iso(tree.updatedAt) ?? startedAt ?? new Date(0).toISOString();
  return {
    runId: `${ADAPTER_NAME}:${id}`,
    adapter: ADAPTER_NAME,
    kind: 'session',
    surface: 'ide',
    title: ideTitle(db, id, c),
    project,
    projectFromCwd,
    projectExists,
    dbPath,
    composerId: id,
    version: c._v,
    supported: isSupportedVersion(c),
    archived: c.isArchived === true,
    treeUpdatedAt: tree.updatedAt,
    treeHeaders: tree.headers,
    ...(startedAt ? { startedAt } : {}),
    modifiedAt,
    sizeBytes: headersOf(c).length,
  };
}

/**
 * Liveness and size over the subagent TREE. A child composer writes under
 * its own key while the parent's IR embeds its lane; whether the parent
 * record also moves when a child writes is unverified (spec §16 item 1), and
 * the tree form is correct either way. Visited-set guarded: Cursor's own
 * parent walk carries one, so cycles are possible in principle.
 */
function treeStats(rootId, all, children) {
  let updatedAt = 0;
  let headers = 0;
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || seen.size > 500) continue;
    seen.add(id);
    const c = all.get(id);
    if (!c) continue;
    const t = composerUpdatedAt(c);
    if (t !== undefined && t > updatedAt) updatedAt = t;
    headers += headersOf(c).length;
    for (const kid of children.get(id) ?? []) stack.push(kid);
  }
  return { updatedAt: updatedAt > 0 ? updatedAt : undefined, headers };
}

/**
 * `trackedGitRepos[0].repoPath` → `workspaceIdentifier.uri.fsPath` → bucket.
 * Both direct sources are on the composer record (verified); the
 * `workspaceStorage/<hash>/workspace.json` join is NOT consulted — the 3.x
 * agent window does not create a workspaceStorage folder at all.
 */
export function ideProject(c) {
  const repo = Array.isArray(c?.trackedGitRepos) ? str(c.trackedGitRepos[0]?.repoPath) : undefined;
  if (repo) return { project: repo, projectFromCwd: true };
  const ws = str(c?.workspaceIdentifier?.uri?.fsPath);
  if (ws) return { project: ws, projectFromCwd: true };
  return { project: CURSOR_BUCKET, projectFromCwd: false };
}

/**
 * `name` → first human bubble `text` (snippet 100) → composerId. The fallback
 * is ONE primary-key point lookup (the first `type:1` header's bubble), never
 * a range scan, so 10 000 unnamed composers stay inside the §4 budget.
 */
function ideTitle(db, id, c) {
  const name = str(c.name);
  if (name) return snippet(name, 100);
  const first = headersOf(c).find((h) => h?.type === 1 && typeof h.bubbleId === 'string');
  if (first) {
    try {
      const text = str(bubbleRow(db, id, first.bubbleId).json?.text);
      if (text) return snippet(text, 100);
    } catch {
      /* degraded — fall through to the id */
    }
  }
  return id;
}

// ------------------------------------------------------------------ CLI

/**
 * Walk `<data>/chats/<workspaceHash>/<agentId>/`. A chat needs `store.db`;
 * one with `meta.json` alone never reached its first model step and is
 * skipped, not warned. `hasConversation === false` is skipped too.
 */
async function cliRefs(chats, dirExists, warnings) {
  const refs = [];
  let workspaces;
  try {
    workspaces = await readdir(chats, { withFileTypes: true });
  } catch {
    return refs;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    let agents;
    try {
      agents = await readdir(join(chats, ws.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const chatDir = join(chats, ws.name, a.name);
      const dbPath = join(chatDir, CLI_STORE_FILE);
      if (!(await statOrNull(dbPath))) continue;
      const meta = await readMetaJson(join(chatDir, CLI_META_FILE));
      if (meta?.hasConversation === false) continue;
      try {
        refs.push(await cliRef(chatDir, dbPath, a.name, meta ?? {}, dirExists));
      } catch (err) {
        warnings.push({ adapter: ADAPTER_NAME, reason: `${dbPath}: ${String(err?.message ?? err)}` });
      }
    }
  }
  return refs;
}

async function cliRef(chatDir, dbPath, agentId, meta, dirExists) {
  const { db, close } = await openDb(dbPath);
  let store;
  try {
    if (!hasStoreTables(db)) throw new Error(`no blobs/meta tables — not a cursor-agent ${CLI_STORE_FILE}`);
    store = storeProbe(db);
  } finally {
    await close();
  }
  const cwd = str(meta.cwd);
  const project = cwd ?? CURSOR_BUCKET;
  const projectFromCwd = Boolean(cwd);
  const projectExists = projectFromCwd ? await dirProbe(dirExists, project) : false;
  const createdAtMs = num(meta.createdAtMs) ?? num(store.meta0?.createdAt);
  const updatedAtMs = num(meta.updatedAtMs) ?? createdAtMs;
  const startedAt = iso(createdAtMs);
  const modifiedAt = iso(updatedAtMs) ?? startedAt ?? new Date(0).toISOString();
  const name = str(store.meta0?.name);
  return {
    runId: `${ADAPTER_NAME}:${agentId}`,
    adapter: ADAPTER_NAME,
    kind: 'session',
    surface: 'cli',
    title: (name && name !== 'New Agent' ? snippet(name, 100) : '') || snippet(store.firstPrompt, 100) || agentId,
    project,
    projectFromCwd,
    projectExists,
    dbPath,
    chatDir,
    agentId,
    createdAtMs,
    updatedAtMs,
    blobCount: store.blobs,
    schemaVersion: num(meta.schemaVersion),
    ...(startedAt ? { startedAt } : {}),
    modifiedAt,
    sizeBytes: store.messages,
  };
}

/** What detect() needs from an open store: meta['0'] (minus the key), counts, the first prompt. */
function storeProbe(db) {
  const meta0 = readMeta0(db);
  const rootId = str(meta0?.latestRootBlobId);
  const root = rootId ? readBlob(db, rootId) : undefined;
  const ids = root ? rootMessageIds(root) : null;
  let firstPrompt = '';
  for (const id of ids ?? []) {
    const { json } = decodeMessageBlob(readBlob(db, id));
    if (json?.role !== 'user' || typeof json.content === 'string') continue;
    if (json.providerOptions?.cursor?.requestContextCompleteness) continue;
    const text = (Array.isArray(json.content) ? json.content : [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    firstPrompt = unwrapUserQuery(text).prompt;
    if (firstPrompt) break;
  }
  return { meta0, blobs: blobCount(db), messages: ids?.length ?? 0, firstPrompt };
}

// ---------------------------------------------------------------------------
// File-layout knowledge exposed to the vendor-neutral layers.
// ---------------------------------------------------------------------------

/**
 * Per RUN, never the DB file: the IDE store is one global file and merely
 * opening it bumps its mtime. IDE: the subagent tree's latest `modifiedAt`
 * and its summed header count. CLI: `updatedAtMs:blobCount` — meta.json is
 * rewritten on every flush and the blob count grows with every step.
 */
export function fingerprint(ref) {
  if (ref.surface === 'cli') return `${ref.updatedAtMs ?? 0}:${ref.blobCount ?? 0}`;
  return `${ref.treeUpdatedAt ?? instant(ref.modifiedAt) ?? 0}:${ref.treeHeaders ?? ref.sizeBytes ?? 0}`;
}

/**
 * Live tail. Both stores are WAL. The DIRECTORY watch is load-bearing and
 * was watched happening: the CLI deletes `store.db-wal` and `-shm` at
 * session end and recreates them (new inode) on the next `--resume`, so a
 * file watch armed once goes deaf. The file targets stay as belt and braces.
 * The IDE's `state.vscdb` is one global file, so any Cursor write wakes
 * every watched Cursor run for a fingerprint check — one prefix scan; the
 * debounce absorbs the rest.
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
 * CLI only: `cursor-agent --resume <agentId>`. The agentId (the chat
 * directory name) matches the CLI's own `--resume` validation regex, so the
 * command is verified end to end. `cursor-agent` rather than the `agent`
 * symlink the installer also creates: `agent` is a generic name likely to
 * collide on a user's PATH, and a resume that runs the wrong binary is worse
 * than a longer one. No fork flag exists, so no `forkArgv`.
 *
 * IDE runs return null — no external route into the local opener exists
 * (`/agent?id=` dispatches to the cloud opener only). The resume button is
 * simply absent.
 */
export function resumeInfo(ref) {
  if (ref.surface !== 'cli' || typeof ref.agentId !== 'string' || !ref.agentId) return null;
  const argv = ['cursor-agent', '--resume', ref.agentId];
  const cwd = ref.projectExists ? ref.project : null;
  const command = argv.map(shellQuote).join(' ');
  return {
    argv,
    cwd,
    copyCommand: cwd ? `cd ${shellQuote(cwd)} && ${command}` : command,
  };
}
