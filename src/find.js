/**
 * Plain substring matcher over the Graph IR.
 *
 * One implementation, two consumers: `server.js` (GET /api/find, and through it
 * the `find_nodes` MCP tool) and the frontend bundle, which imports this file
 * directly and filters locally so typing costs no round trips. The human's find
 * and the agent's find must never disagree about what matches — hence one
 * function.
 *
 * PURITY CONTRACT: no Node builtins, no imports at all. `tests/find.test.js`
 * asserts this, because the frontend bundle cannot tolerate a `node:` import.
 */

/**
 * @param {{nodes?: Array<{id: string, label?: string, files?: string[]}>}} ir
 * @param {string} query  plain substring, case-insensitive
 * @returns {string[]} matching node ids, in IR order. Empty query → [] (not
 *   everything: "match nothing" is the honest answer to "no query").
 */
export function matchNodes(ir, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const out = [];
  for (const n of ir?.nodes ?? []) {
    if (matchesNode(n, q)) out.push(n.id);
  }
  return out;
}

/** Lower-cased, trimmed query. Returns '' for anything unusable. */
export function normalizeQuery(query) {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

/**
 * Does one node match an already-normalized query? Matches the display label
 * and every attributed file path — the two things a user or an agent actually
 * knows the name of.
 *
 * @param {object} node
 * @param {string} q  output of normalizeQuery
 */
export function matchesNode(node, q) {
  if (!q || !node) return false;
  if (typeof node.label === 'string' && node.label.toLowerCase().includes(q)) return true;
  for (const f of node.files ?? []) {
    if (typeof f === 'string' && f.toLowerCase().includes(q)) return true;
  }
  return false;
}
