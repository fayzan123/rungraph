/**
 * The sidebar's grouping opinion, out of JSX.
 *
 * Two orthogonal axes — *where* (project) and *who* (agent) — used to be
 * flattened onto one list. This module owns the untangling: bundle keying
 * (`📦 <file>`), the `✦ loose runs` bucket, case-merged project groups with
 * display casing, recency ordering, the agent filter, and the counts. The
 * Picker renders this module's output and keeps only UI state (prefs,
 * selection, share mode).
 *
 * Everything here is pure (no preact, no DOM, no fetch) so it unit-tests
 * alongside viewmath and focus — `tests/picker.test.js`.
 */

import { adapterName } from './focus.js';

/**
 * Where runs with no real project to stand in gather: Hermes bucket runs,
 * home-cwd chats, dead worktrees. The `✦` mark means "bucket", not a vendor —
 * the server's `loose` flag decides membership, so no adapter's group label
 * is ever string-matched here.
 */
export const LOOSE_BUCKET = '✦ loose runs';

/**
 * The group key an index entry files under. One implementation, shared by the
 * grouping below and by the Picker's reveal/prefs logic — the key is also the
 * localStorage pref key, so it must be derived identically everywhere.
 *
 * Precedence: bundle (`📦`) > loose bucket > case-merged project path.
 * Consumers must tolerate `loose` being absent (an older server).
 */
export function groupKeyFor(run) {
  if (run?.provenance) return `📦 ${run.provenance.bundle}`;
  if (run?.loose) return LOOSE_BUCKET;
  const p = typeof run?.project === 'string' ? run.project : '';
  return p.toLowerCase();
}

/**
 * Newest first, runId as the tiebreak — the same rule the scanner sorts by,
 * so a helper fed an unsorted list still produces the server's order.
 */
function byRecency(a, b) {
  if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/**
 * Group index entries for the sidebar.
 *
 * @param {Array<object>} runs  index entries (any order; re-sorted by recency)
 * @param {{ filter?: string }} [opts]  `filter` narrows to one adapter:
 *   groups with zero matching runs disappear, mixed groups keep only matching
 *   rows, `total` keeps the unfiltered count so headers can say "k of n".
 * @returns {Array<{ key: string, label: string,
 *   kind: 'project'|'bucket'|'bundle', runs: Array<object>,
 *   total: number, live: number }>}
 *   Groups in recency order (each group placed by its newest run, filter or
 *   not — no reordering jitter when the filter toggles). `live` counts the
 *   *matching* runs that are active.
 */
export function groupRuns(runs, { filter } = {}) {
  const ordered = [...(runs ?? [])].sort(byRecency);
  const groups = new Map();
  for (const r of ordered) {
    const key = groupKeyFor(r);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        kind: r.provenance ? 'bundle' : r.loose ? 'bucket' : 'project',
        runs: [],
        total: 0,
        live: 0,
        // Path groups case-merge for display: casing tallied per spelling, in
        // recency order, so the majority casing wins and ties go to the most
        // recent spelling. Bundle and bucket labels never case-merge.
        casings: new Map(),
      });
    }
    const g = groups.get(key);
    g.total += 1;
    if (g.kind === 'project' && typeof r.project === 'string') {
      g.casings.set(r.project, (g.casings.get(r.project) ?? 0) + 1);
    }
    if (filter && r.adapter !== filter) continue;
    g.runs.push(r);
    if (r.active) g.live += 1;
  }
  const out = [];
  for (const { casings, ...g } of groups.values()) {
    if (filter && g.runs.length === 0) continue;
    let label = g.key;
    if (g.kind === 'project') {
      let bestN = 0;
      for (const [casing, n] of casings) {
        if (n > bestN) [label, bestN] = [casing, n];
      }
    }
    out.push({ ...g, label });
  }
  return out;
}

/**
 * One chip per adapter present in the index, for the agent rail. The Picker
 * renders these only when there is more than one — a single-vendor list has
 * nothing to distinguish — and prepends its own `all` chip.
 *
 * Ordered by descending run count, adapter id as the tiebreak: stable for a
 * given corpus, no recency jitter in the rail.
 *
 * @returns {Array<{ adapter: string, name: string, count: number, live: boolean }>}
 */
export function adapterChips(runs) {
  const byAdapter = new Map();
  for (const r of runs ?? []) {
    if (!byAdapter.has(r.adapter)) {
      byAdapter.set(r.adapter, {
        adapter: r.adapter,
        name: adapterName(r.adapter),
        count: 0,
        live: false,
      });
    }
    const chip = byAdapter.get(r.adapter);
    chip.count += 1;
    if (r.active) chip.live = true;
  }
  return [...byAdapter.values()].sort(
    (a, b) => b.count - a.count || (a.adapter < b.adapter ? -1 : a.adapter > b.adapter ? 1 : 0),
  );
}
