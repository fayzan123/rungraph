/**
 * Hermes Agent adapter. All Hermes-specific format knowledge — the SQLite
 * layout, the message grammar, the delegation tree — lives in this directory;
 * nothing downstream may reference it. Pure: no server imports, no I/O beyond
 * reading the run's own database (and, in the crash-recovery case only, a
 * scratch copy of it in rungraph's own temp dir).
 */
export {
  detect,
  scanWarnings,
  fingerprint,
  watchTargets,
  matchesProject,
  resumeInfo,
  ADAPTER_NAME as name,
} from './detect.js';
export { parse } from './parse.js';
