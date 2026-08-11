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
 * @property {Object} [ext]
 *
 * @typedef {Object} GraphIR
 * @property {1} irVersion
 * @property {IRMeta} meta
 * @property {IRNode[]} nodes
 * @property {IREdge[]} edges
 * @property {IRGroup[]} groups
 */

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
