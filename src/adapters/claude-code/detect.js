import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { headLines, tailLines, safeParseJson, statOrNull } from '../../util.js';
import { snippet } from '../../ir.js';

export const ADAPTER_NAME = 'claude-code';

const SESSION_FILE_RE = /^[0-9a-f-]{8,}\.jsonl$/;

/**
 * RunRef — the lightweight handle detect() produces and parse() consumes.
 * Built from stat + bounded head/tail chunk reads only; never a full parse.
 *
 * @typedef {Object} RunRef
 * @property {string} runId
 * @property {string} adapter
 * @property {'session'|'workflow'} kind
 * @property {string} title
 * @property {string} project      Display path of the project (cwd when known).
 * @property {string} projectDir   Absolute path of the provider's project dir.
 * @property {string} sessionId
 * @property {string} sessionFile  Absolute path of the main session .jsonl.
 * @property {string} [wfId]       Workflow runs only.
 * @property {string} [wfDir]
 * @property {string} [journalFile]
 * @property {string} [startedAt]
 * @property {string} modifiedAt
 * @property {number} sizeBytes
 */

/**
 * Find every Claude Code run under the given root dirs.
 * @param {string[]} rootDirs e.g. ['~/.claude/projects' resolved]
 * @returns {Promise<RunRef[]>}
 */
export async function detect(rootDirs) {
  const refs = [];
  for (const root of rootDirs) {
    const entries = await readdirOrEmpty(root, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const projectDir = join(root, ent.name);
      refs.push(...(await detectProject(projectDir)));
    }
  }
  // runId tiebreak: same-mtime runs (a pinned fixture tree, a restore) must
  // still come back in one deterministic order.
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

async function detectProject(projectDir) {
  const refs = [];
  const entries = await readdirOrEmpty(projectDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((e) => e.isFile() && SESSION_FILE_RE.test(e.name))
    .map((e) => e.name);
  const dirs = new Set(
    entries.filter((e) => e.isDirectory()).map((e) => e.name),
  );

  for (const file of sessionFiles) {
    const sessionId = basename(file, '.jsonl');
    const sessionFile = join(projectDir, file);
    const st = await statOrNull(sessionFile);
    if (!st) continue;

    const peek = await peekSession(sessionFile, st.size);
    const ref = {
      runId: `${ADAPTER_NAME}:${basename(projectDir)}:${sessionId}`,
      adapter: ADAPTER_NAME,
      kind: 'session',
      title: peek.title || '(untitled session)',
      project: peek.cwd || decodeProjectDirName(basename(projectDir)),
      projectFromCwd: Boolean(peek.cwd),
      projectDir,
      sessionId,
      sessionFile,
      startedAt: peek.startedAt,
      modifiedAt: st.mtime.toISOString(),
      sizeBytes: st.size,
    };
    if (dirs.has(sessionId)) {
      // Fold satellite files (agent transcripts, journals) into the run's
      // mtime/size so the live badge and cache keys see all activity.
      const agg = await runStats(ref);
      if (agg.maxMtimeMs > 0) {
        ref.modifiedAt = new Date(agg.maxMtimeMs).toISOString();
        ref.sizeBytes = agg.totalSize;
      }
    }
    refs.push(ref);

    // Workflow runs live under <projectDir>/<sessionId>/subagents/workflows/wf_*/
    if (dirs.has(sessionId)) {
      refs.push(...(await detectWorkflows(ref)));
    }
  }
  return refs;
}

async function detectWorkflows(sessionRef) {
  const refs = [];
  const wfRoot = join(sessionRef.projectDir, sessionRef.sessionId, 'subagents', 'workflows');
  const entries = await readdirOrEmpty(wfRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.startsWith('wf_')) continue;
    const wfDir = join(wfRoot, ent.name);
    const journalFile = join(wfDir, 'journal.jsonl');
    const jst = await statOrNull(journalFile);
    if (!jst) continue;
    const ref = {
      runId: `${sessionRef.runId}:${ent.name}`,
      adapter: ADAPTER_NAME,
      kind: 'workflow',
      title: (await workflowTitle(sessionRef, ent.name)) || ent.name,
      project: sessionRef.project,
      projectFromCwd: sessionRef.projectFromCwd,
      projectDir: sessionRef.projectDir,
      sessionId: sessionRef.sessionId,
      sessionFile: sessionRef.sessionFile,
      wfId: ent.name,
      wfDir,
      journalFile,
      modifiedAt: jst.mtime.toISOString(),
      sizeBytes: jst.size,
    };
    const agg = await runStats(ref);
    if (agg.maxMtimeMs > 0) {
      ref.modifiedAt = new Date(agg.maxMtimeMs).toISOString();
      ref.sizeBytes = agg.totalSize;
    }
    refs.push(ref);
  }
  return refs;
}

/**
 * Workflow scripts are persisted at <sessionId>/workflows/scripts/<name>-<wfId>.js,
 * which gives us the workflow's meta.name without parsing anything.
 */
async function workflowTitle(sessionRef, wfId) {
  const scriptsDir = join(sessionRef.projectDir, sessionRef.sessionId, 'workflows', 'scripts');
  const names = await readdirOrEmpty(scriptsDir);
  const hit = names.find((n) => n.endsWith(`-${wfId}.js`));
  return hit ? hit.slice(0, -(`-${wfId}.js`.length)) : undefined;
}

/**
 * Bounded look at a session file: title (ai-title > last-prompt > first user
 * prompt), cwd, and first timestamp. Reads at most one head + one tail chunk.
 */
async function peekSession(sessionFile, sizeBytes) {
  const head = (await headLines(sessionFile)).map(safeParseJson).filter(Boolean);
  const tail =
    sizeBytes > 65536
      ? (await tailLines(sessionFile)).map(safeParseJson).filter(Boolean)
      : head;

  const out = { title: '', cwd: undefined, startedAt: undefined };
  for (const obj of head) {
    if (!out.cwd && typeof obj.cwd === 'string') out.cwd = obj.cwd;
    if (!out.startedAt && typeof obj.timestamp === 'string') out.startedAt = obj.timestamp;
    if (out.cwd && out.startedAt) break;
  }

  const pick = (lines, type, field) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const o = lines[i];
      if (o.type === type && typeof o[field] === 'string' && o[field]) return o[field];
    }
    return undefined;
  };

  out.title =
    pick(tail, 'ai-title', 'aiTitle') ??
    pick(head, 'ai-title', 'aiTitle') ??
    pick(tail, 'last-prompt', 'lastPrompt') ??
    firstUserSnippet(head) ??
    '';
  out.title = snippet(out.title, 100);
  return out;
}

function firstUserSnippet(lines) {
  for (const o of lines) {
    if (o.type !== 'user' || o.isMeta) continue;
    const c = o.message?.content;
    if (typeof c === 'string' && c.trim() && !c.startsWith('<')) return c;
    if (Array.isArray(c)) {
      const t = c.find((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim());
      if (t && !t.text.startsWith('<')) return t.text;
    }
  }
  return undefined;
}

/**
 * Claude Code encodes the project cwd by replacing path separators (and dots)
 * with '-'. The mapping is lossy, so we only use it as a display fallback when
 * no session line gave us a real cwd.
 */
function decodeProjectDirName(name) {
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

async function readdirOrEmpty(dir, opts) {
  try {
    return await readdir(dir, opts);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// File-layout knowledge exposed to the vendor-neutral layers. The scanner,
// server, and watcher call these instead of knowing the layout themselves.
// ---------------------------------------------------------------------------

/** Every file belonging to a run (bounded readdir walk, no parsing). */
async function runFilePaths(ref) {
  if (ref.kind === 'workflow') {
    // Only the workflow's own files — the parent session file is a separate
    // run and would mark every workflow of a live session as live.
    const paths = [];
    for (const n of await readdirOrEmpty(ref.wfDir)) paths.push(join(ref.wfDir, n));
    paths.push(join(ref.projectDir, ref.sessionId, 'workflows', `${ref.wfId}.json`));
    return paths;
  }
  const paths = [ref.sessionFile];
  const sub = join(ref.projectDir, ref.sessionId, 'subagents');
  for (const ent of await readdirOrEmpty(sub, { withFileTypes: true })) {
    if (ent.isFile()) paths.push(join(sub, ent.name));
  }
  const wfRoot = join(sub, 'workflows');
  for (const ent of await readdirOrEmpty(wfRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    for (const n of await readdirOrEmpty(join(wfRoot, ent.name))) {
      paths.push(join(wfRoot, ent.name, n));
    }
  }
  const wfMeta = join(ref.projectDir, ref.sessionId, 'workflows');
  for (const ent of await readdirOrEmpty(wfMeta, { withFileTypes: true })) {
    if (ent.isFile()) paths.push(join(wfMeta, ent.name));
  }
  return paths;
}

/** Aggregate {maxMtimeMs, totalSize} over a run's whole file set — CURRENT, not cached. */
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

/**
 * Cheap cache key covering every file of the run (satellite agent
 * transcripts grow without touching the main file).
 */
export async function fingerprint(ref) {
  const { maxMtimeMs, totalSize } = await runStats(ref);
  return `${maxMtimeMs}:${totalSize}`;
}

/** What the live-tail watcher should watch for this run. */
export function watchTargets(ref) {
  const targets = [{ path: ref.sessionFile, recursive: false }];
  if (ref.kind === 'workflow') {
    targets.push({ path: ref.wfDir, recursive: true });
  } else {
    targets.push({ path: join(ref.projectDir, ref.sessionId), recursive: true });
    // The session dir may not exist yet — watching the project dir lets the
    // watcher re-arm when it appears.
    targets.push({ path: ref.projectDir, recursive: false });
  }
  return targets;
}

/**
 * Fallback --project matcher for runs whose transcript never revealed a cwd:
 * Claude Code encodes the cwd into the project dir name by replacing
 * path separators and dots with '-'.
 */
export function matchesProject(ref, resolvedPath) {
  return basename(ref.projectDir) === resolvedPath.replace(/[/.]/g, '-');
}
