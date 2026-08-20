import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as claudeCode from './adapters/claude-code/index.js';
import * as codex from './adapters/codex/index.js';
import * as hermes from './adapters/hermes/index.js';
import * as opencode from './adapters/opencode/index.js';

/** Registered adapters. */
export const ADAPTERS = [claudeCode, codex, hermes, opencode];

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
    hermes: roots('RUNGRAPH_HERMES_HOME', join(homedir(), '.hermes')),
    // opencode keeps ONE global database in its XDG data dir. The env var it
    // honours for that dir is XDG_DATA_HOME, so rungraph follows it rather
    // than hard-coding ~/.local/share — otherwise a user who moved their data
    // dir would be told they have no opencode runs.
    opencode: roots(
      'RUNGRAPH_OPENCODE_HOME',
      // `||`, not `??`: an exported-but-EMPTY XDG_DATA_HOME is how a shell
      // spells "unset", and opencode itself treats it that way. With `??` the
      // empty string survives and the scan root becomes the RELATIVE path
      // "opencode" — resolved against whatever directory rungraph happens to
      // be run from, which finds nothing and reports no opencode runs.
      join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode'),
    ),
  };
}

/**
 * Build the run index: every adapter's detect(), newest first.
 *
 * @param {{ rootDirs?: Record<string, string[]>, project?: string }} [opts]
 *   `project` filters to runs whose cwd is (inside) the given path.
 * @returns {Promise<{ runs: import('./adapters/claude-code/detect.js').RunRef[],
 *                     warnings?: { adapter: string, reason: string }[] }>}
 */
export async function scan(opts = {}) {
  const roots = opts.rootDirs ?? defaultRootDirs();
  const all = [];
  // Adapter-level scan degradations — a disabled adapter (no node:sqlite), an
  // unreadable DB, a runId dedupe — surface as an additive top-level
  // `warnings` array, so `list --json`, /api/runs and MCP list_runs tell
  // agents the same fact a human would read off stderr. irVersion-safe per
  // SCHEMA.md's additive rule; absent when there is nothing to say.
  const warnings = [];
  for (const adapter of ADAPTERS) {
    const dirs = roots[adapter.name] ?? [];
    if (dirs.length === 0) continue;
    all.push(...(await adapter.detect(dirs)));
    warnings.push(...(adapter.scanWarnings?.() ?? []));
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
  return { runs, ...(warnings.length ? { warnings } : {}) };
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

/**
 * Serializable picker/index entry derived from a RunRef.
 *
 * Local runs whose adapter can resume them carry a `resume` block — only the
 * copy strings and the launch capability, never `argv`/`cwd` (those stay
 * server-side; POST /api/resume rebuilds them from its own scan). Bundle
 * entries are built elsewhere (bundle.js) and never carry `resume`: bundles
 * are other machines' transcripts, and a resume button on them would be a lie.
 */
export function toIndexEntry(ref, now = Date.now()) {
  const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
  const info = adapter?.resumeInfo?.(ref) ?? null;
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
    // A run is loose when its project is not a real place to stand: the
    // adapter gave it a group *label* rather than a path ('✦ Hermes tasks',
    // '(unknown project)'), its project is the home directory (nobody's
    // project), or the directory no longer exists (deleted worktrees). The
    // dashboard groups loose runs under one '✦ loose runs' bucket. Computed
    // here — not in the frontend — so /api/index, `list --json` and MCP
    // list_runs share the one implementation, and no vendor bucket label is
    // ever string-matched outside its adapter. No new I/O: projectExists was
    // probed at detect. Additive; bundle entries never carry it.
    loose: !isAbsolute(ref.project ?? '') || ref.project === homedir() || !ref.projectExists,
    ...(info
      ? {
          resume: {
            copyCommand: info.copyCommand,
            ...(info.forkCopyCommand ? { forkCopyCommand: info.forkCopyCommand } : {}),
            // v1 launches on macOS only; elsewhere the UI shows the copy tier
            // alone. A Linux chain would be untested code reasoned into place.
            canLaunch: process.platform === 'darwin',
          },
        }
      : {}),
  };
}

/** Resolve a runId back to its RunRef (fresh detect; runIds are stable). */
export async function findRun(runId, opts = {}) {
  const { runs } = await scan(opts);
  return runs.find((r) => r.runId === runId);
}

