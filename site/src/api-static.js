/**
 * Static stand-in for frontend/src/api.js — the landing-page embed's data
 * layer. Same exports, same shapes; the server is replaced by three baked
 * files under site/data/ (one demo run, reviewed line-by-line before commit).
 *
 * scripts/build-site.mjs aliases every import of frontend/src/api.js to this
 * file when bundling the embed, so the app itself ships unmodified. Paths are
 * relative on purpose: GitHub Pages serves the site under /rungraph/.
 */

// applyDelta unchanged from the real client: the merge logic is part of the
// contract, and a second copy could disagree with the first.
export { applyDelta } from '../../frontend/src/api.js';

const cache = new Map();

async function fetchJson(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  });
  // A transient failure must not poison every later read of the same file.
  p.catch(() => cache.delete(path));
  cache.set(path, p);
  return p;
}

export function fetchIndex() {
  return fetchJson('data/index.json');
}

export async function fetchGraph(runId) {
  const graph = await fetchJson('data/graph.json');
  if (graph?.meta?.runId !== runId) throw new Error(`graph: 404 (no run "${runId}")`);
  return graph;
}

export async function fetchDetail(runId, nodeId) {
  const details = await fetchJson('data/details.json');
  const d = details[nodeId];
  if (!d) throw new Error(`detail: 404 (no detail for "${nodeId}")`);
  return d;
}

/**
 * No server to broadcast to — resolve like a one-client success so any caller
 * behaves exactly as it would against a live dashboard with this tab open.
 */
export async function postFocus(runId, nodeIds, label, reason) {
  return { ok: true, runId, clientCount: 1, otherClients: 0, url: '' };
}

/**
 * The baked run is finished and cannot change: no EventSource is ever
 * constructed (so no reconnect banner), nothing is pushed, and the returned
 * unsubscribe has nothing to undo. onStatus(true) keeps the app's connection
 * state exactly where a healthy live socket would leave it.
 */
export function watchGraph(runId, onMessage, onStatus) {
  onStatus?.(true);
  return () => {};
}

/**
 * Unreachable in the embed: baked index entries never carry a `resume` field,
 * so the affordance that would call this never renders. The export exists only
 * so the bundler resolves the module; behave like a launchless machine anyway.
 */
export async function postResume(runId, fork) {
  return { launched: false, copyCommand: '' };
}
