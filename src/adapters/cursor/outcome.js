import { IN_FLIGHT_STATUSES, TERMINAL_STATUSES } from './db.js';

/**
 * The tool-outcome classifier — one implementation, both surfaces. The two
 * parsers model different things and share no "message" abstraction, but
 * they answer the SAME question here, and two copies of it could disagree.
 *
 * **No single field says whether a Cursor IDE tool call succeeded.** Four
 * observed encodings of "did not succeed", all from real records:
 *
 *   read_file_v2             status=error      error.clientVisibleErrorMessage="File not found"
 *   run_terminal_command_v2  status=completed  additionalData.status="rejected"  result.rejected=true
 *   run_terminal_command_v2  status=completed  additionalData.status="error"     result.exitCode=1
 *   edit_file_v2             status=cancelled  error.clientVisibleErrorMessage="Edit rejected: User chose to skip"
 *
 * Two of the four say `completed`. Reading `status` alone reports 55 clean
 * calls out of 57 in the trouble corpus and loses a refused command, a failed
 * command and a cancelled edit.
 *
 * Fields deliberately NOT consulted, with the measurement ruling each out:
 *
 * - `additionalData.blockReason` — `"Not in allowlist: <cmd>"` on 9 commands
 *   in the trouble corpus that were approved and ran successfully. Using it
 *   would flag ~16% of a healthy session.
 * - `additionalData.reviewData.selectedOption` — the dialog's DEFAULT
 *   highlighted option, not the user's choice: `"rejectAndTellWhatToDoDifferently"`
 *   on ten commands that all executed.
 * - CLI `isError` — `false` on a non-zero exit (`output.failure`).
 *
 * Under precision-over-recall each would be a trust-destroying false-positive
 * source. tests/cursor.test.js pins every one of them.
 */

/**
 * @typedef {'ok'|'error'|'rejected'|'running'} Outcome
 */

/**
 * IDE: `toolFormerData` in, outcome out. `result` is passed already PARSED
 * (it is a JSON string on the record) so the classifier stays pure.
 *
 * `running` is first and exact: the in-flight vocabulary is the 3.16.29
 * bundle's. An UNKNOWN status is not `running` — a vendor that renames
 * `completed` would otherwise leave every call spinning forever — it is
 * tallied (so drift is visible where coverage drift is) and read on through
 * the evidence-based checks.
 *
 * `cancelled → rejected` conflates a user skipping an edit with an edit Cursor
 * cancelled on abort. Both are interventions and both are excluded from
 * work-quality signals, so the cost is a chip's wording, not a false flag.
 *
 * @param {object} tf        `toolFormerData`
 * @param {object|undefined} result   parsed `tf.result`
 * @param {(status: string) => void} [tally]  called with an unknown status
 * @returns {Outcome}
 */
export function ideOutcome(tf, result, tally) {
  const status = typeof tf?.status === 'string' ? tf.status : '';
  const ad = tf?.additionalData && typeof tf.additionalData === 'object' ? tf.additionalData : {};
  const res = result && typeof result === 'object' ? result : undefined;
  if (IN_FLIGHT_STATUSES.has(status)) return 'running';
  if (!TERMINAL_STATUSES.has(status)) tally?.(status || '(none)');
  if (res?.rejected === true) return 'rejected';
  if (ad.status === 'rejected') return 'rejected';
  if (status === 'rejected' || status === 'skipped') return 'rejected';
  if (status === 'cancelled') return 'rejected';
  if (status === 'error') return 'error';
  if (ad.status === 'error') return 'error';
  if (Number.isInteger(res?.exitCode) && res.exitCode !== 0) return 'error';
  return 'ok';
}

/**
 * CLI: the tool-result MESSAGE and its block in, outcome out. Structure
 * before prose, never `isError`: `providerOptions.cursor.highLevelToolCallResult.output`
 * is `{<kind>: {…}}` with kind ∈ success | error | failure | rejected, and
 * `failure` (a non-zero exit) carries `isError: false`. The prose `result`
 * mirrors it and is the fallback when `providerOptions` is absent.
 *
 * A `tool-call` with no matching `tool-result` in the root's list is
 * `running` — the CLI's only in-flight representation, decided by the
 * parser, not here.
 *
 * @param {object} msg    the `role: 'tool'` message
 * @param {object} block  its `tool-result` block
 * @returns {Outcome}
 */
export function cliOutcome(msg, block) {
  const output = msg?.providerOptions?.cursor?.highLevelToolCallResult?.output;
  const kind = output && typeof output === 'object' ? Object.keys(output)[0] : undefined;
  if (kind === 'rejected') return 'rejected';
  if (kind === 'error' || kind === 'failure') return 'error';
  if (kind === 'success') return 'ok';
  // The prose fallback reads STATUS LINES, never content. Observed shapes:
  // `Rejected: ` (one line), `Error: File not found` (one line), and a Shell
  // result opening with `Exit code: N`. A Read whose file happens to begin
  // with `Error:` is content, which is why the error match requires the whole
  // prose to be one short line, and the exit-code match is Shell's alone
  // when the tool name is known.
  const prose = typeof block?.result === 'string' ? block.result : '';
  const tool = typeof block?.toolName === 'string' ? block.toolName : '';
  if (/^Rejected:/.test(prose)) return 'rejected';
  if (/^Error: [^\n]{0,200}$/.test(prose.trim())) return 'error';
  const m = /^Exit code: (\d+)/.exec(prose);
  if (m && m[1] !== '0' && (!tool || tool === 'Shell')) return 'error';
  return 'ok';
}

/** The structured CLI payload under `output.<kind>`, or undefined. */
export function cliResultPayload(msg) {
  const output = msg?.providerOptions?.cursor?.highLevelToolCallResult?.output;
  if (!output || typeof output !== 'object') return undefined;
  const kind = Object.keys(output)[0];
  const payload = kind ? output[kind] : undefined;
  return payload && typeof payload === 'object' ? payload : undefined;
}
