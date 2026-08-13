import { watch } from 'node:fs';
import { statOrNull } from './util.js';
import { attachSignals } from './signals.js';

/**
 * Watch one run's files and re-parse on change. This is the entire live-tail
 * feature: fs.watch only — no hooks, no proxy.
 *
 * Emits via `onGraph(ir, details)` after each successful re-parse (including
 * once immediately). Parse errors are reported via `onError` and never fatal;
 * the next file event retries (truncated mid-write lines are tolerated by the
 * line parser itself).
 *
 * @param {import('./adapters/claude-code/detect.js').RunRef} ref
 * @param {{ parse: Function, watchTargets?: Function }} adapter
 * @param {{ onGraph: Function, onError?: Function, debounceMs?: number }} handlers
 * @returns {{ close: () => void }}
 */
export function watchRun(ref, adapter, { onGraph, onError, debounceMs = 300 }) {
  const watchers = [];
  let timer = null;
  let closed = false;
  let parsing = false;
  let dirty = false;

  // What to watch is file-layout knowledge, which belongs to the adapter.
  const targets = (adapter.watchTargets?.(ref) ?? [{ path: ref.sessionFile, recursive: false }])
    .map((t) => ({ ...t, armed: false }));

  async function arm() {
    for (const t of targets) {
      if (t.armed) continue;
      const st = await statOrNull(t.path);
      if (!st) continue;
      try {
        const w = watch(t.path, { recursive: t.recursive }, schedule);
        w.on('error', () => {});
        watchers.push(w);
        t.armed = true;
      } catch {
        // Path vanished between stat and watch, or recursive unsupported —
        // the debounced re-parse loop re-arms on the next event.
      }
    }
  }

  function schedule() {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  }

  async function run() {
    if (closed) return;
    if (parsing) {
      dirty = true;
      return;
    }
    parsing = true;
    try {
      await arm(); // dirs (e.g. subagents/) may appear mid-run
      const { ir, details } = await adapter.parse(ref, { collectDetails: true });
      // Re-derived on every rebuild: a live run's trouble is exactly the thing
      // that changes while you are not looking. Pure pass over an in-memory IR.
      attachSignals(ir);
      if (!closed) onGraph(ir, details);
    } catch (err) {
      onError?.(err);
    } finally {
      parsing = false;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  }

  arm().then(run);

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}

/**
 * Diff two graphs into a delta the SPA merges by id. Node/edge/group ids are
 * stable across re-parses by adapter contract, so a growing run yields
 * adds/updates, not churn.
 */
export function diffGraphs(prev, next) {
  if (!prev) return { type: 'snapshot', graph: next };
  const delta = {
    type: 'delta',
    meta: next.meta,
    nodes: changed(prev.nodes, next.nodes),
    edges: changed(prev.edges, next.edges),
    groups: changed(prev.groups, next.groups),
    // Signals ride along IN FULL rather than diffed — the array is small and
    // the merge logic a diff would need is not worth the complexity.
    signals: next.signals ?? [],
    removedNodeIds: removedIds(prev.nodes, next.nodes),
    removedEdgeIds: removedIds(prev.edges, next.edges),
  };
  const empty =
    delta.nodes.length === 0 &&
    delta.edges.length === 0 &&
    delta.groups.length === 0 &&
    delta.removedNodeIds.length === 0 &&
    delta.removedEdgeIds.length === 0 &&
    // A run where only the signal set moved IS a change — that is precisely
    // the escalation moment Phase 3 exists to surface, so it must not be
    // suppressed as "nothing happened".
    JSON.stringify(prev.signals ?? []) === JSON.stringify(next.signals ?? []) &&
    JSON.stringify(prev.meta) === JSON.stringify(next.meta);
  return empty ? null : delta;
}

function changed(prevArr, nextArr) {
  const prevById = new Map(prevArr.map((x) => [x.id, JSON.stringify(x)]));
  return nextArr.filter((x) => prevById.get(x.id) !== JSON.stringify(x));
}

function removedIds(prevArr, nextArr) {
  const nextIds = new Set(nextArr.map((x) => x.id));
  return prevArr.filter((x) => !nextIds.has(x.id)).map((x) => x.id);
}
