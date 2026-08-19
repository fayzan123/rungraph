/**
 * Graph IR — the single vendor-neutral contract consumed by the SPA,
 * `rungraph graph --json`, and future MCP tools.
 *
 * Documented for humans in SCHEMA.md. Versioned via `irVersion`.
 * Provider-specific extras live only in the namespaced `ext` bag on
 * nodes/edges/meta — nothing else in the IR may be provider-specific.
 *
 * @typedef {'session' | 'workflow'} RunKind
 * @typedef {'turn' | 'agent' | 'tool' | 'workflow' | 'human'} NodeKind
 * @typedef {'sequence' | 'spawn' | 'return'} EdgeKind
 * @typedef {'completed' | 'error' | 'running'} NodeStatus
 *
 * @typedef {Object} Tokens
 * @property {number} input
 * @property {number} output
 *
 * @typedef {Object} IRNode
 * @property {string} id            Unique within the run.
 * @property {NodeKind} kind
 * @property {string} label         Short human label (prompt snippet, tool name, …).
 * @property {NodeStatus} status
 * @property {string} [startedAt]   ISO 8601.
 * @property {string} [endedAt]     ISO 8601.
 * @property {number} [durationMs]
 * @property {Tokens} [tokens]
 * @property {string} [model]       agent nodes: model that ran the agent.
 * @property {string} [agentId]     agent nodes: provider agent id.
 * @property {number} [callCount]   tool nodes: number of collapsed calls.
 * @property {number} [errorCount]  tool nodes: how many of those calls errored.
 * @property {string} [runRef]      workflow nodes: runId of the drill-in subgraph.
 * @property {'answer'|'denial'|'interrupt'} [interventionKind]  human nodes.
 * @property {string} [group]       id of the group (phase) this node belongs to.
 * @property {boolean} [hasDetail]  true if /api/detail can expand this node.
 * @property {string[]} [files]     tool/agent nodes: paths this node touched, as the
 *                                  adapter observed them. Absent — never [] — when
 *                                  nothing was touched.
 * @property {Object} [ext]         namespaced provider extras.
 *
 * @typedef {Object} IREdge
 * @property {string} id
 * @property {EdgeKind} kind
 * @property {string} from          node id
 * @property {string} to            node id
 * @property {string} [label]       spawn: child prompt snippet; return: result summary.
 * @property {string} [reason]      decision lineage, when derivable (tool error before
 *                                  a retry, denial before a new approach, phase transition).
 * @property {Object} [ext]
 *
 * @typedef {Object} IRGroup
 * @property {string} id
 * @property {string} label         e.g. workflow phase title.
 *
 * @typedef {Object} IRMeta
 * @property {string} runId
 * @property {string} adapter       e.g. "claude-code"
 * @property {RunKind} kind
 * @property {string} title
 * @property {string} [startedAt]
 * @property {string} [endedAt]
 * @property {{tokens: number, toolCalls: number, agents: number}} totals
 * @property {number} unrecognizedLineCount
 * @property {Coverage} [coverage]  How much of the run was read — see coverage.js.
 * @property {Object} [ext]
 *
 * @typedef {Object} Coverage
 * @property {number} records        Records the adapter EXAMINED, in its own unit
 *                                   (non-blank JSONL lines, walked DB rows, …).
 *                                   Adapter-defined; never compared across adapters.
 * @property {number} unrecognized   …of those, how many it could not interpret.
 * @property {number} sourcesUnread  Referenced sources it could not open at all
 *                                   (e.g. a missing agent transcript). Their size is
 *                                   unknowable, so they are never turned into records.
 *
 * @typedef {Object} IRSignal
 * @property {string} id            Stable across re-parses (derived from node ids).
 * @property {'retry-storm'|'unresolved-error'|'intervention'|'outlier'|'course-change'} kind
 * @property {'high'|'info'} severity
 * @property {string[]} nodeIds     Never empty. Signals reference node SETS, which is
 *                                  why they live here and not on individual nodes.
 * @property {string} label
 * @property {string} reason
 *
 * @typedef {Object} GraphIR
 * @property {1} irVersion
 * @property {IRMeta} meta
 * @property {IRNode[]} nodes
 * @property {IREdge[]} edges
 * @property {IRGroup[]} groups
 * @property {IRSignal[]} [signals] Derived, not parsed — see signals.js. Additive in
 *                                  irVersion 1; consumers must tolerate absence.
 */

import { emptyCoverage } from './coverage.js';

export const IR_VERSION = 1;

export const NODE_KINDS = ['turn', 'agent', 'tool', 'workflow', 'human'];
export const EDGE_KINDS = ['sequence', 'spawn', 'return'];
export const STATUSES = ['completed', 'error', 'running'];

/**
 * @param {Partial<IRMeta>} meta
 * @returns {GraphIR}
 */
export function emptyGraph(meta) {
  return {
    irVersion: IR_VERSION,
    meta: {
      runId: '',
      adapter: '',
      kind: 'session',
      title: '',
      totals: { tokens: 0, toolCalls: 0, agents: 0 },
      unrecognizedLineCount: 0,
      // Raw counts, not a ratio: consumers derive what they need and no
      // precision is discarded at the source. Additive to irVersion 1 —
      // consumers must tolerate its absence (older bundles have none).
      coverage: emptyCoverage(),
      ...meta,
    },
    nodes: [],
    edges: [],
    groups: [],
  };
}

/** Trim a prompt/result string down to a one-line label. */
export function snippet(text, max = 80) {
  if (typeof text !== 'string') return '';
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
