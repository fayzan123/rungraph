# Graph IR — `irVersion: 1`

The Graph IR is rungraph's single contract: the web UI, `rungraph graph --json`,
and future MCP tools all consume exactly this shape. It is **vendor-neutral** —
nothing in it is specific to any one agent product. Provider-specific extras
appear only inside namespaced `ext` bags.

```jsonc
{
  "irVersion": 1,
  "meta": { … },
  "nodes": [ … ],
  "edges": [ … ],
  "groups": [ … ]
}
```

## meta

| field | type | meaning |
|---|---|---|
| `runId` | string | Stable, opaque run identifier (use it verbatim in CLI/API calls). |
| `adapter` | string | Which adapter produced this graph, e.g. `"claude-code"`. |
| `kind` | `"session"` \| `"workflow"` | Top-level session vs. a workflow run. |
| `title` | string | Human title for the run. |
| `startedAt` / `endedAt` | ISO 8601 string (optional) | Wall-clock bounds. `endedAt` is absent while the run looks live. |
| `totals` | object | `{ tokens, toolCalls, agents }` — whole-run aggregates. `tokens` is input+output. |
| `unrecognizedLineCount` | number | Transcript lines the adapter could not interpret. `> 0` renders a banner, never an error — format drift is expected. |
| `ext` | object (optional) | Namespaced provider extras. |

## nodes

Common fields:

| field | type | meaning |
|---|---|---|
| `id` | string | Unique within the run. **Stable across re-parses** — live-tail deltas merge by id. |
| `kind` | `"turn"` \| `"agent"` \| `"tool"` \| `"workflow"` \| `"human"` | See below. |
| `label` | string | Short display label (prompt snippet, tool name, …). |
| `status` | `"completed"` \| `"error"` \| `"running"` | |
| `startedAt` / `endedAt` | ISO 8601 (optional) | |
| `durationMs` | number (optional) | |
| `tokens` | `{ input, output }` (optional) | |
| `group` | string (optional) | Id of the `groups[]` entry (e.g. workflow phase) containing this node. |
| `hasDetail` | boolean (optional) | `true` → `GET /api/detail/:nodeId?run=<runId>` returns a lazy detail payload. |
| `ext` | object (optional) | Provider extras (namespaced). |

Kind-specific fields:

- **`turn`** — one user→assistant exchange on the session backbone. Label is the
  prompt snippet.
- **`agent`** — a spawned agent (subagent or workflow agent). Extra fields:
  `agentId`, `model`.
- **`tool`** — grouped tool activity: consecutive calls of the same tool
  collapse into one node ("Bash ×7"). Extra fields: `callCount`, `errorCount`.
  Individual calls live in the detail payload.
- **`workflow`** — a workflow run as a single node. Extra field: `runRef` — the
  `runId` of the workflow's own graph (fetch it to drill in).
- **`human`** — a human intervention: `interventionKind` is `"answer"`
  (question answered), `"denial"` (permission refused), or `"interrupt"`
  (mid-turn interruption). These are the course-change moments.

## edges

| field | type | meaning |
|---|---|---|
| `id` | string | Unique within the run, stable across re-parses. |
| `kind` | `"sequence"` \| `"spawn"` \| `"return"` | |
| `from` / `to` | string | Node ids. |
| `label` | string (optional) | `spawn`: the child's prompt snippet. `return`: result summary. |
| `reason` | string (optional) | **Decision lineage** — why the run moved this way, when derivable (e.g. tool error before a retry, denial before a new approach, phase transition). |
| `ext` | object (optional) | |

- `sequence` — temporal order within a lane (the backbone chain).
- `spawn` — parent → child agent/workflow.
- `return` — child → parent, carrying the result.

## groups

| field | type | meaning |
|---|---|---|
| `id` | string | Referenced by `nodes[].group`. |
| `label` | string | e.g. a workflow phase title. |

## Level of detail

The graph carries only what the default canvas needs: turns, agents, grouped
tools, workflows, human interventions. Full transcripts and individual tool
calls are **detail payloads**, fetched lazily per node:

`GET /api/detail/:nodeId?run=<runId>` → one of:

```jsonc
{ "kind": "turn",     "prompt": "…", "responseText": "…" }
{ "kind": "agent",    "prompt": "…", "result": "…", "transcript": [{ "role", "text", "toolName?" }] }
{ "kind": "tool",     "name": "…", "calls": [{ "input", "output", "isError", "durationMs?" }] }
{ "kind": "workflow", "returnValue": "…" }
{ "kind": "human",    "context": "…", "answer": "…" }
```

Detail payload strings are pre-truncated server-side to keep responses small;
they are display artifacts, not a data-fidelity contract.

## HTTP API (localhost only)

| endpoint | returns |
|---|---|
| `GET /api/index` | `{ "runs": [{ runId, adapter, kind, title, project, startedAt, modifiedAt, sizeBytes, active }] }` |
| `GET /api/graph/:runId` | the Graph IR above |
| `GET /api/detail/:nodeId?run=:runId` | a detail payload |
| `GET /api/watch/:runId` | SSE stream: `{type:"snapshot", graph}` first, then `{type:"delta", meta, nodes, edges, groups, removedNodeIds, removedEdgeIds}` (merge by id) |

The server binds `127.0.0.1` only. These endpoints map 1:1 onto the planned
MCP tools (`list_runs`, `get_graph`, `get_detail`, `open_visualization`).

## Versioning

`irVersion` bumps on breaking shape changes. Additive optional fields do not
bump the version. Adapters may emit fewer fields than documented (everything
optional is genuinely optional) — consumers must tolerate absence.
