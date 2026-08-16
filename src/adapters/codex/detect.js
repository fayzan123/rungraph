import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { headLines, safeParseJson, statOrNull } from '../../util.js';
import { snippet } from '../../ir.js';

/**
 * Codex CLI adapter — detection. All Codex-specific format knowledge lives in
 * this directory; nothing downstream may reference it.
 *
 * Ground truth (74-file corpus discovery, 2026-08-15, cli 0.78.0–0.144.4):
 * rollout files live at `<root>/YYYY/MM/DD/rollout-<local-ts>-<uuidv7>.jsonl`,
 * one file per thread; the FIRST line is always a `session_meta` whose
 * `payload.id` equals the filename uuid and carries cwd, git and — for
 * subagent threads — spawn lineage (`thread_source: "subagent"`,
 * `parent_thread_id`, nickname, path, depth). `session_index.jsonl` is stale
 * and partial (26/74 at discovery), so rollout files are the only source of
 * truth. Subagent rollouts are NOT independent runs: they materialize as
 * agent nodes inside their parent's graph, resolved across files.
 */

export const ADAPTER_NAME = 'codex';

const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{8,})\.jsonl$/;

/**
 * @typedef {Object} CodexRunRef
 * @property {string} runId        `codex:<thread-uuid>`
 * @property {'codex'} adapter
 * @property {'session'} kind
 * @property {string} title
 * @property {string} project      The session cwd (authoritative, from meta).
 * @property {boolean} projectFromCwd
 * @property {string} root         The sessions root — parse() resolves child
 *                                 rollouts across date dirs from here.
 * @property {string} sessionId    The thread uuid.
 * @property {string} sessionFile  Absolute rollout path.
 * @property {string} [startedAt]
 * @property {string} modifiedAt
 * @property {number} sizeBytes
 */

/** Every non-subagent Codex thread under the given roots. */
export async function detect(rootDirs) {
  const refs = [];
  for (const root of rootDirs) {
    for (const file of await rolloutFiles(root)) {
      const ref = await refFromRollout(root, file);
      if (ref) refs.push(ref);
    }
  }
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
  return refs;
}

/** Walk `<root>/YYYY/MM/DD/rollout-*.jsonl` (three fixed levels, no parsing). */
async function rolloutFiles(root) {
  const out = [];
  for (const year of await readdirOrEmpty(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await readdirOrEmpty(join(root, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await readdirOrEmpty(join(root, year, month))) {
        if (!/^\d{2}$/.test(day)) continue;
        for (const name of await readdirOrEmpty(join(root, year, month, day))) {
          if (ROLLOUT_RE.test(name)) out.push(join(root, year, month, day, name));
        }
      }
    }
  }
  return out;
}

async function refFromRollout(root, file) {
  const st = await statOrNull(file);
  if (!st) return null;
  const peek = await peekRollout(file);
  if (!peek) return null; // unreadable or headless — not a run we can name
  if (peek.subagent) return null; // rendered inside its parent's graph instead
  const threadId = peek.id ?? basename(file).match(ROLLOUT_RE)?.[1] ?? basename(file, '.jsonl');
  return {
    runId: `${ADAPTER_NAME}:${threadId}`,
    adapter: ADAPTER_NAME,
    kind: 'session',
    title: peek.title || '(codex session)',
    project: peek.cwd || '(unknown project)',
    projectFromCwd: Boolean(peek.cwd),
    root,
    sessionId: threadId,
    sessionFile: file,
    startedAt: peek.startedAt,
    modifiedAt: st.mtime.toISOString(),
    sizeBytes: st.size,
  };
}

/**
 * Bounded look at a rollout: the session_meta (line 1 — can be 3–22KB, which
 * headLines' growing chunk tolerates) plus a title from the first real user
 * prompt in the head.
 */
async function peekRollout(file) {
  let lines;
  try {
    lines = (await headLines(file)).map(safeParseJson).filter(Boolean);
  } catch {
    return null;
  }
  const meta = lines.find((l) => l?.type === 'session_meta')?.payload;
  if (!meta || typeof meta !== 'object') return null;

  let title = '';
  for (const l of lines) {
    if (l?.type === 'event_msg' && l.payload?.type === 'user_message') {
      title = promptText(l.payload.message);
      if (title) break;
    }
  }
  return {
    id: typeof meta.id === 'string' ? meta.id : undefined,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
    startedAt: firstTimestamp(lines),
    // `source` is polymorphic: a string in old files, an object for subagent
    // spawns. Type-guard both roads to "is this a subagent thread".
    subagent:
      meta.thread_source === 'subagent' ||
      (meta.source && typeof meta.source === 'object' && 'subagent' in meta.source),
    title: snippet(title, 100),
  };
}

function firstTimestamp(lines) {
  for (const l of lines) {
    if (typeof l?.timestamp === 'string') return l.timestamp;
  }
  return undefined;
}

/**
 * The user's actual words. VS Code wraps prompts in an IDE-context preamble
 * (`# Context from my IDE setup:` … `## <sections>`); the typed text is the
 * final section's body.
 */
export function promptText(message) {
  if (typeof message !== 'string') return '';
  if (!message.startsWith('# Context from my IDE setup:')) return message;
  const sections = message.split(/^## .*$/m);
  const last = sections[sections.length - 1]?.trim();
  return last || message;
}

async function readdirOrEmpty(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// File-layout knowledge exposed to the vendor-neutral layers.
// ---------------------------------------------------------------------------

/**
 * Find the rollout file for a thread id, anywhere under the root — children
 * are filed under their OWN start date, not their parent's, so lineage
 * resolution must scan across date directories.
 */
export async function rolloutFileForThread(root, threadId) {
  if (typeof threadId !== 'string' || !threadId) return null;
  for (const file of await rolloutFiles(root)) {
    if (basename(file, '.jsonl').endsWith(`-${threadId}`)) return file;
  }
  return null;
}

/**
 * Child rollout files by runId, recorded by parse(). Module-level rather
 * than ref-level because callers (the server's parse cache in particular)
 * build FRESH refs on every request — a fingerprint computed on a fresh ref
 * would otherwise cover the parent file alone and go stale while a subagent
 * writes.
 */
const childFilesByRun = new Map();

export function recordChildFiles(runId, files) {
  childFilesByRun.set(runId, files);
  // Bounded: this process only ever parses a handful of runs, but a very
  // long-lived server should not grow it without limit.
  if (childFilesByRun.size > 64) {
    childFilesByRun.delete(childFilesByRun.keys().next().value);
  }
}

/**
 * A run's file set: the parent rollout plus any child rollouts a parse has
 * discovered. Before the first parse only the parent is covered — which is
 * enough, because spawning or messaging a child always writes activity
 * events into the parent file too.
 */
async function runFilePaths(ref) {
  return [ref.sessionFile, ...(ref.childFiles ?? childFilesByRun.get(ref.runId) ?? [])];
}

/** Aggregate {maxMtimeMs, totalSize} over the run's file set — CURRENT, not cached. */
export async function runStats(ref) {
  let maxMtimeMs = 0;
  let totalSize = 0;
  for (const p of await runFilePaths(ref)) {
    const st = await statOrNull(p);
    if (!st) continue;
    maxMtimeMs = Math.max(maxMtimeMs, st.mtimeMs);
    totalSize += st.size;
  }
  return { maxMtimeMs, totalSize };
}

export async function fingerprint(ref) {
  const { maxMtimeMs, totalSize } = await runStats(ref);
  return `${maxMtimeMs}:${totalSize}`;
}

/**
 * Live tail: the parent file, plus the whole sessions root (recursive) so
 * child rollouts growing in their own date dirs — and new ones appearing —
 * re-trigger the parse.
 */
export function watchTargets(ref) {
  return [
    { path: ref.sessionFile, recursive: false },
    { path: ref.root, recursive: true },
  ];
}

/**
 * Fallback --project matcher. Codex metas carry a real cwd, so refs with one
 * are matched upstream by the scanner; a run whose meta never revealed a cwd
 * has nothing to match on.
 */
export function matchesProject() {
  return false;
}
