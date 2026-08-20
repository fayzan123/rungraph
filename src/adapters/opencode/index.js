/**
 * opencode adapter. All opencode-specific format knowledge — the SQLite
 * layout, the message/part grammar, the subagent tree, the revert blob —
 * lives in this directory; nothing downstream may reference it. Pure: no
 * server imports, no I/O beyond reading the run's own database (and, in the
 * crash-recovery case only, a scratch copy of it in rungraph's own temp dir).
 *
 * No `matchesProject` hook, deliberately: every opencode session has a real
 * git worktree, so `scan()` short-circuits on `projectFromCwd: true` and
 * returns the path-prefix match before any adapter hook is consulted. An
 * implementation here would be dead code. (This is the opposite of Hermes,
 * which exports `return false` precisely because its bucket runs are not
 * paths.)
 */
export {
  detect,
  scanWarnings,
  fingerprint,
  watchTargets,
  resumeInfo,
  ADAPTER_NAME as name,
} from './detect.js';
export { parse } from './parse.js';
