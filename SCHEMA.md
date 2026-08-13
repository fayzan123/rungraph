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
  "groups": [ … ],
  "signals": [ … ]
}
```

`signals` (and `nodes[].files`) are **additive in `irVersion` 1** — the same way
`tool.context` was added. Consumers must tolerate their absence: older graphs
and adapters that cannot supply them simply omit both.

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
| `files` | string[] (optional) | **File attribution** — paths this node touched. `tool` and `agent` nodes only; **absent**, never `[]`, when nothing was touched. |
| `ext` | object (optional) | Provider extras (namespaced). |

`files` are stored exactly as the adapter observed them (absolute, as the
provider records them); displaying them relative to a project root is the
consumer's job — IR `meta` does not carry a project path. A `tool` node
collapses several calls, so its `files` is the de-duplicated union across the
group. An `agent` node's `files` is the union of everything touched anywhere in
that agent's own transcript: a subagent's tool calls never become tool nodes, so
without this a large fraction of real edits would be invisible. `workflow` nodes
are not enumerated — they drill into their own graph via `runRef`, which carries
its own attribution.

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

## signals

Derived, never parsed: `signals` is a pure function of the rest of the IR
(`deriveSignals(ir)`), computed wherever an IR is produced for a consumer — the
CLI, the server's parse cache, and every live-tail rebuild. It is top-level
because a signal references a *set* of nodes and therefore cannot live on one.

| field | type | meaning |
|---|---|---|
| `id` | string | Unique within the run, **stable across re-parses** (derived from node ids, not a counter) — consumers diff id sets to spot what is newly wrong. |
| `kind` | `"retry-storm"` \| `"unresolved-error"` \| `"intervention"` \| `"outlier"` \| `"course-change"` | |
| `severity` | `"high"` \| `"info"` | Only `high` earns a badge on the canvas. |
| `nodeIds` | string[] | Never empty; every id exists in `nodes`. |
| `label` | string | Chip text, e.g. `"6 failed Edit calls"`. |
| `reason` | string | One sentence on why it matters, concrete about these nodes. |

| kind | fires when | severity |
|---|---|---|
| `retry-storm` | a tool node's `errorCount >= 3`, or consecutive same-tool nodes in a lane each carrying errors | high |
| `unresolved-error` | a tool node failed and is the last of its tool in its lane — nothing came back to fix it | high |
| `intervention` | any `human` node, grouped by `interventionKind` | `denial`/`interrupt` → high; `answer` → info |
| `outlier` | `tokens` or `durationMs` ≥ 3× the run's median **and** above an absolute floor | info |
| `course-change` | an edge already carries `reason`, promoted onto its target node | info |

A "lane" is the `sequence`-edge chain a node belongs to — the session backbone,
or one agent's own chain.

The governing rule is **precision over recall**: a false flag costs more than a
missed one, because the moment the markers stop being trustworthy the user is
back to reading the whole graph. Hence `course-change` promotes existing
lineage only (no speculative inference), `outlier` is list-only (in a large
session the biggest node is usually just the biggest node), and **a clean run
produces zero signals**. Ordering is `high` before `info`, then by position in
the run. Signals are an enhancement, never a render dependency: if derivation
fails, the field is `[]` and the graph draws normally.

## Level of detail

The graph carries only what the default canvas needs: turns, agents, grouped
tools, workflows, human interventions. Full transcripts and individual tool
calls are **detail payloads**, fetched lazily per node:

`GET /api/detail/:nodeId?run=<runId>` → one of:

```jsonc
{ "kind": "turn",     "prompt": "…", "responseText": "…" }
{ "kind": "agent",    "prompt": "…", "result": "…", "transcript": [{ "role", "text", "toolName?" }] }
{ "kind": "tool",     "name": "…", "context": "…?", "calls": [{ "input", "output", "isError", "durationMs?" }] }
{ "kind": "workflow", "returnValue": "…" }
{ "kind": "human",    "context": "…", "answer": "…" }
```

Detail payload strings are pre-truncated server-side to keep responses small;
they are display artifacts, not a data-fidelity contract.

`tool.context` (optional, additive in irVersion 1): the assistant's narration
emitted immediately before the group's first call — the "why" behind the tool
use. Absent when there was no narration; consumers must tolerate absence.

## HTTP API (localhost only)

| endpoint | returns |
|---|---|
| `GET /api/index` | `{ "runs": [{ runId, adapter, kind, title, project, startedAt, modifiedAt, sizeBytes, active }] }` |
| `GET /api/graph/:runId` | the Graph IR above |
| `GET /api/find/:runId?q=` | `{ runId, query, matched, nodeIds, nodes }` — plain substring over node labels and `files` |
| `GET /api/detail/:nodeId?run=:runId` | a detail payload |
| `GET /api/view` | `{ "runs": [{ runId, clientCount }] }` — what the open dashboards are showing; `[]` when no browser is connected |
| `GET /api/watch/:runId` | SSE stream: `{type:"snapshot", graph}` first, then `{type:"delta", meta, nodes, edges, groups, signals, removedNodeIds, removedEdgeIds}` (merge by id; `signals` replaces wholesale) and `{type:"focus", runId, nodeIds, label, reason}` |
| `POST /api/focus` | `{ runId, nodeIds, label, reason }` → broadcasts a `focus` frame; replies `{ ok, runId, clientCount, url }` |

The server binds `127.0.0.1` only. `POST /api/focus` is its one write endpoint:
it accepts node ids and two display strings, its only effect is which nodes a
local browser tab highlights, and it reads no files and mutates nothing on disk.
Any local process that could reach it can already read the transcripts directly.
Requests carrying a non-localhost `Origin` are rejected, so a page the user
happens to be browsing cannot drive their dashboard.

`GET /api/find` exists so an agent can narrow before pulling: a 500-node graph
is plausibly 40–50k tokens dropped into a session to answer one question. The
frontend does not call it — it imports the same matcher and filters locally,
avoiding a round trip per keystroke. One matcher, two consumers, so the human's
find and the agent's find cannot disagree.

## MCP (`rungraph mcp`)

The endpoints above map 1:1 onto the MCP tools, which is why `rungraph mcp` is
transport and almost no new logic:

| tool | maps to |
|---|---|
| `list_runs` | `GET /api/index` |
| `get_graph(runId, detail?)` | `GET /api/graph/:runId` (`detail:"compact"` by default — ids, labels, kinds, files, signals; `"full"` adds timings and token counts) |
| `find_nodes(runId, query)` | `GET /api/find/:runId?q=` |
| `get_detail(runId, nodeId)` | `GET /api/detail/:nodeId?run=` |
| `focus_nodes(runId, nodeIds, label, reason)` | `POST /api/focus` |
| `get_current_view()` | `GET /api/view` |
| `open_visualization(runId?)` | opens the browser |

The read-only tools work with no server running — they parse from disk — so
asking an agent about a run never requires the dashboard to be open. Only the
focus and view tools need `serve`; without it they say the highlight was
skipped rather than failing. `serve` publishes `{ port, pid, startedAt }` to a
well-known file in the OS temp directory for discovery, and readers confirm
liveness with a real request before trusting it, which is also how a stale file
from a crashed process is handled.

Register it once with `rungraph mcp --install`.

## Versioning

`irVersion` bumps on breaking shape changes. Additive optional fields do not
bump the version. Adapters may emit fewer fields than documented (everything
optional is genuinely optional) — consumers must tolerate absence.
