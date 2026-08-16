/**
 * Codex CLI adapter. All Codex-specific format knowledge lives in this
 * directory — nothing downstream may reference it. Pure: no server imports,
 * no I/O beyond reading the run's own files (the parent rollout and its
 * subagent rollouts).
 */
export {
  detect,
  fingerprint,
  watchTargets,
  matchesProject,
  ADAPTER_NAME as name,
} from './detect.js';
export { parse } from './parse.js';
