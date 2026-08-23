/**
 * Cursor adapter. One registered adapter, two internal surfaces — the IDE's
 * `state.vscdb` and cursor-agent's per-chat `store.db` — because the agent
 * rail should show one vendor for one product, and the surfaces need one
 * `matchesProject`, one bucket label, one coverage policy and one client
 * entry. All Cursor-specific format knowledge lives in this directory;
 * nothing downstream may reference it. Pure: no server imports, no I/O
 * beyond reading the run's own stores (and, in the crash-recovery case only,
 * a scratch copy of one in rungraph's own temp dir).
 *
 * Nothing else imports the surfaces: `parse` dispatches on `ref.surface`.
 */
import { parseIde } from './ide/parse.js';
import { parseCli } from './cli/parse.js';

export {
  detect,
  scanWarnings,
  fingerprint,
  watchTargets,
  resumeInfo,
  matchesProject,
  ADAPTER_NAME as name,
} from './detect.js';

/**
 * @param {import('./detect.js').CursorRunRef} ref
 * @param {{ collectDetails?: boolean }} [opts]
 */
export function parse(ref, opts = {}) {
  if (ref?.surface === 'cli') return parseCli(ref, opts);
  return parseIde(ref, opts);
}
