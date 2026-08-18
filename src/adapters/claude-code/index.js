/**
 * Claude Code adapter. All Claude-specific format knowledge lives in this
 * directory — nothing downstream may reference it. Pure: no server imports,
 * no I/O beyond reading the run's own files.
 */
export {
  detect,
  fingerprint,
  watchTargets,
  matchesProject,
  resumeInfo,
  ADAPTER_NAME as name,
} from './detect.js';
export { parse } from './parse.js';
