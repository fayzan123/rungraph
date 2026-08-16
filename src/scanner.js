import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as claudeCode from './adapters/claude-code/index.js';
import * as codex from './adapters/codex/index.js';

/** Registered adapters. */
export const ADAPTERS = [claudeCode, codex];

/** How recently a run's files must have changed to be badged "live". */
const ACTIVE_WINDOW_MS = 45_000;

export function defaultRootDirs() {
  // Env vars override each adapter's scan root (tests, unusual setups). An
  // override set to the EMPTY string disables that adapter's scan entirely —
  // how tests keep a suite from wandering into the developer's real corpus.
  const roots = (envVar, fallback) => {
    const override = process.env[envVar];
    if (override === '') return [];
    return [override ?? fallback];
  };
  return {
    'claude-code': roots('RUNGRAPH_CLAUDE_PROJECTS', join(homedir(), '.claude', 'projects')),
    codex: roots('RUNGRAPH_CODEX_SESSIONS', join(homedir(), '.codex', 'sessions')),
  };
}

/**
 * Build the run index: every adapter's detect(), newest first.
 *
 * @param {{ rootDirs?: Record<string, string[]>, project?: string }} [opts]
 *   `project` filters to runs whose cwd is (inside) the given path.
 * @returns {Promise<{ runs: import('./adapters/claude-code/detect.js').RunRef[] }>}
 */
export async function scan(opts = {}) {
  const roots = opts.rootDirs ?? defaultRootDirs();
  const all = [];
  for (const adapter of ADAPTERS) {
    const dirs = roots[adapter.name] ?? [];
    if (dirs.length === 0) continue;
    all.push(...(await adapter.detect(dirs)));
  }

  let runs = all;
  if (opts.project) {
    const p = resolve(opts.project);
    runs = runs.filter((r) => {
      // A real cwd from the transcript is authoritative; the adapter's
      // dir-name fallback only applies when no cwd was ever recorded.
      if (r.projectFromCwd) return r.project === p || r.project.startsWith(p + '/');
      const adapter = ADAPTERS.find((a) => a.name === r.adapter);
      return adapter?.matchesProject?.(r, p) ?? false;
    });
  }
  runs.sort(byRecency);
  return { runs };
}

/**
 * Newest first, runId as the tiebreak. The tiebreak matters: runs that were
 * written in the same second (or restored from a backup) would otherwise land
 * in whatever order the sort happened to produce, making the index — and the
 * fixture snapshots — non-deterministic.
 */
function byRecency(a, b) {
  if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/** Serializable picker/index entry derived from a RunRef. */
export function toIndexEntry(ref, now = Date.now()) {
  return {
    runId: ref.runId,
    adapter: ref.adapter,
    kind: ref.kind,
    title: ref.title,
    project: ref.project,
    startedAt: ref.startedAt ?? null,
    modifiedAt: ref.modifiedAt,
    sizeBytes: ref.sizeBytes,
    active: now - Date.parse(ref.modifiedAt) < ACTIVE_WINDOW_MS,
  };
}

/** Resolve a runId back to its RunRef (fresh detect; runIds are stable). */
export async function findRun(runId, opts = {}) {
  const { runs } = await scan(opts);
  return runs.find((r) => r.runId === runId);
}

