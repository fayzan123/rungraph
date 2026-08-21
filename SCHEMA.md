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
| `coverage` | object (optional) | `{ records, unrecognized, sourcesUnread }` — how much of the run was read. See below. |
| `ext` | object (optional) | Namespaced provider extras. |

`coverage` is **raw counts, not a ratio**, so consumers derive what they need and
no precision is discarded at the source. It is additive within `irVersion: 1` —
consumers must tolerate its absence (a bundle written by an older rungraph has
none), and must treat absence as *unknown*, never as complete.

- `records` — records the adapter **examined**, in **its own unit**: non-blank
  JSONL lines for `claude-code` and `codex`, walked rows for `hermes`. Because
  the unit is adapter-defined, a ratio is only meaningful *within one run* and
  `records` is never compared across adapters. A tolerated final malformed
  record (mid-write truncation during live tail) counts here and **not** in
  `unrecognized`, so a live session does not flicker.
- `unrecognized` — of those, how many it could not interpret. One record can
  raise more than one complaint (a Hermes row carrying a batch of malformed tool
  calls), so this may exceed `records`; consumers clamp rather than throw.
- `sourcesUnread` — referenced sources it could not open **at all** (a missing
  agent transcript, an absent subagent rollout). Their size is unknowable, so
  they are never converted into a fabricated record count — but any nonzero
  value makes 100% unreachable, because an entirely unreadable subagent would
  otherwise score as fully read.

`src/coverage.js` is the one implementation of what those numbers mean —
percentage, quiet/loud classification and the MCP note all come from it.

Known `ext` bags (all optional; consumers must tolerate absence — and unknown
bags):

- **`meta.ext.hermes`** — `{ model, estimatedCostUsd, source, gitBranch,
  gitRepoRoot, profile, archived, rewindCount, inactiveMessageCount,
  modelSwitchCount?, schemaVersion }`. `source` is how the session reached
  Hermes (`cli`, `telegram`, …); `inactiveMessageCount` counts rows a rewind
  deactivated (the canonical `active = 1` history is what the graph draws).
- **`meta.ext.opencode`** — `{ version, agent, model, directory, cost?, billed?,
  archived?, archivedAt?, archivedAtMs?, revert?, copiedHistory?, compaction?,
  truncated?, orphanLanes?, unresolvedTasks?, missingChildSessions?,
  unknownTypes?, shapeWarnings? }`.
  - `version` is `session.version`, the opencode that wrote the run. Stamped on
    every run: when the numbers look wrong, "…and this was written by opencode
    1.22.0" is the lead a human or an agent actually needs.
  - `billed` is `{ input, output, cacheRead, cacheWrite }` — opencode's own
    column sums, the figures `opencode stats` prints. **They are expected to
    disagree with the IR's `tokens`, and both are right**: `tokens.input` on a
    turn is the MAXIMUM context that turn reached (each opencode step re-sends
    the whole conversation, so context is a high-water mark, not an additive
    quantity), while `billed` is summed volume. Peak size and billed volume are
    different questions.
  - `revert` is `{ messageID, snapshot }` — the boundary, for consumers that
    want it; the per-node truth is the core `reverted` field.
  - `copiedHistory` marks a run whose messages predate its own session row — a
    causal impossibility unless they were copied, which is what an
    `opencode --fork` produces. It deliberately **names no origin**: nothing in
    opencode's schema records one.
  - `shapeWarnings` is one narrow drift assertion, not schema validation: a run
    whose assistant steps report no numeric `tokens.input` says so, because a
    renamed JSON key yields a smaller-but-plausible number that coverage cannot
    catch by construction (coverage measures unreadable records, not misread
    ones).
  - `truncated` counts calls whose output opencode discarded. It is **not** a
    coverage event — opencode's spill files do not survive, so there is nothing
    rungraph failed to read.
  - `orphanLanes` counts subagent sessions whose dispatch record was pruned;
    they still get a lane, and cost coverage nothing (the child itself was read
    completely). `unresolvedTasks` counts dispatches opencode had not yet
    recorded a child session for — also free, for the same reason: nothing was
    written, so nothing went unread. Only `missingChildSessions` — a dispatch
    naming a session row that is *gone* — is charged to `sourcesUnread`.
- **`node.ext.opencode.truncated`** (tool nodes) — how many of that group's
  collapsed calls carry a preview instead of full output.
- **`node.ext.codex`** (agent nodes) — `{ nickname, agentPath, depth }`,
  Codex's multi-agent lineage.
- **`meta.ext.<adapter>.unknownTypes`** — `{ "<record type>": count }`, the
  record types that adapter could not interpret. Present on any adapter, hence
  the `<adapter>` key (`claudeCode`, `codex`, `hermes`, `opencode`). Type names are vendor
  vocabulary, which is why they live in `ext` rather than beside `coverage`: a
  percentage alone is unactionable, because "read 95%, all of it one metadata
  type" and "read 95%, and 400 assistant turns are missing" are the same number
  and opposite emergencies. Keys are sanitized — `/^[a-z0-9_.:-]{1,40}$/i`, at
  most 10 distinct keys, everything else folded into `other` — because the type
  string comes from whatever wrote the transcript and is unvalidated by
  definition.

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
| `reverted` | boolean (optional) | **This node's work was rolled back by the user.** Present only when `true`. |
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

### `reverted`

Additive in `irVersion` 1 — absent on every graph written before it existed, and
absent on every run with no revert in it, so a normal graph carries zero bytes
for it. Populated by the opencode adapter today (`session.revert`, whose
`messageID` names the TURN the revert rolled back to); the concept is general —
Claude Code has rewind, Hermes carries `rewind_count` — so other adapters may
populate it later without a schema change.

It is a **core field rather than an `ext` key**, and that is load-bearing: the
MCP compact projection carries no `ext`, and compact is the default the tool
descriptions steer agents toward. An `ext` key would reach the canvas and never
reach the agent, leaving the two ends of the loop describing one run
differently.

Two rules govern it downstream:

- **Renders as a MARK, never as opacity.** Opacity is the FocusSet's exclusive
  vocabulary (members light, non-members dim), and a second meaning on that one
  channel would leave the reader unable to tell "not part of the answer" from
  "thrown away". Reverted nodes are struck through and badged `↩`, and a
  reverted node that IS a focus member renders lit.
- **Excluded from work-quality signals, NOT from interventions.**
  `retry-storm`, `unresolved-error` and `outlier` skip reverted nodes, because
  those are claims about output the revert discarded. Interventions (denial,
  interrupt, answer) survive it: a revert rolls back work, not the record of
  what a person decided.

It is deliberately **not** a coverage input. Coverage answers "how much could I
read", and a reverted run was read completely — an accuracy caveat and a
readability one are different questions, and collapsing them would corrupt the
one meaning coverage has.

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
| `GET /api/index` | `{ "runs": [{ runId, adapter, kind, title, project, loose?, startedAt, modifiedAt, sizeBytes, active, resume?, provenance? }], warnings?, errors? }` |
| `GET /api/graph/:runId` | the Graph IR above |
| `GET /api/find/:runId?q=` | `{ runId, query, matched, nodeIds, nodes }` — plain substring over node labels and `files` |
| `GET /api/detail/:nodeId?run=:runId` | a detail payload |
| `GET /api/view` | `{ "runs": [{ runId, clientCount }] }` — what the open dashboards are showing; `[]` when no browser is connected |
| `GET /api/watch/:runId` | SSE stream: `{type:"snapshot", graph}` first, then `{type:"delta", meta, nodes, edges, groups, signals, removedNodeIds, removedEdgeIds}` (merge by id; `signals` replaces wholesale) and `{type:"focus", runId, nodeIds, label, reason}` |
| `POST /api/focus` | `{ runId, nodeIds, label, reason }` → broadcasts a `focus` frame; replies `{ ok, runId, clientCount, url }` |
| `POST /api/resume` | `{ runId, fork? }` → opens a terminal window resuming that session (macOS; fork only where the vendor supports it); replies `{ launched: true }`, or `{ launched: false, copyCommand }` on any launcher problem — never a hard failure. `400` in bundle mode, for unresumable runs, and for `fork` on a fork-less vendor; `404` for an unknown runId |
| `GET /api/export?runs=a,b&redaction=&allow=1&as=&dry=1` | the finished `.rungraph` bundle as a download; `dry=1` → `{ blocked, findings, inventory }` for the consent dialog; a scan hit → `409 { blocked, findings, inventory }` instead of the file; on a bundle server → `409` "send the original file instead" |
| `GET /api/locate/:runId` | `{ found, url?, port?, self?, sources? }` — do I (or any live server in the registry) serve this run? The deep-link jump. |

The server binds `127.0.0.1` only, and **every request is `Host`-guarded**:
anything other than `127.0.0.1`/`localhost`/`[::1]` (with the server's port)
gets a 403. Binding alone never prevented the DNS-rebinding read — a hostile
page resolving its own domain to 127.0.0.1 arrives same-origin, and only the
Host header betrays it. There are two write endpoints, `POST /api/focus` and
`POST /api/resume`, both of which additionally reject requests carrying a
non-localhost `Origin`, so a page the user happens to be browsing cannot
drive their dashboard. Neither executes or persists request-supplied strings:
focus accepts node ids and two display strings and only changes what a local
browser tab highlights; resume accepts a runId (a lookup key into the
server's own scan) and a boolean, and the command it launches is built
entirely server-side by the run's adapter. Neither writes to disk.

`resume` appears on local runs whose adapter can resume them (never on
workflow rows, never in bundle mode):
`{ copyCommand, forkCopyCommand?, canLaunch }` — the pasteable command, the
resume-as-a-copy variant where the vendor forks, and whether this platform
supports the open-in-terminal tier (macOS in v1). `argv` and the launch cwd
never leave the server. `provenance` appears only on bundle-served runs (see
below); consumers must tolerate the absence of both — every local run lacks
`provenance`, every bundle run lacks `resume`. `errors` appears only when a
bundle file failed to decode: `[{ file, error }]`, a named banner per file.

`warnings` (additive in irVersion 1; also carried by `rungraph list --json`
and MCP `list_runs`) reports adapter-level scan degradations as
`[{ adapter, reason }]` — an adapter disabled by the runtime (Hermes on a
Node without `node:sqlite`), an unreadable database, a deduplicated runId.
Absent when there is nothing to say. It exists so an agent reading JSON
learns the same fact a human would read off stderr, instead of inferring
"no runs" from silence.

`project` is normally a real path (the run's cwd or repo root). Runs that
have neither get a literal group label instead — Hermes sessions started
from no particular directory all carry **`✦ Hermes tasks`** — and such
bucket runs never match a `--project` filter. Bundle entries use `📦 <name>`
the same way. `loose` (additive in irVersion 1; also carried by
`rungraph list --json` and MCP `list_runs`) marks runs whose `project` is a
group label, the home directory, or a directory that no longer exists; the
dashboard groups them under `✦ loose runs`. Bundle entries never carry it,
and consumers must tolerate its absence.

## Bundles (`.rungraph`)

`rungraph export` writes a gzipped-JSON bundle; `rungraph open` serves one.
The envelope:

```jsonc
{
  "bundleVersion": 1,               // governs this envelope
  "irVersion": 1,                   // governs the payload
  "sharedBy": "Bilal",              // display string; --as, defaults to $USER. Unverified.
  "exportedAt": "2026-08-15T18:02:11Z",
  "redaction": "full",              // 'full' | 'redact-secrets' | 'structure-only'
  "runs": [
    { "runId": "…", "project": "/abs/cwd", "ir": { /* full Graph IR */ },
      "details": { "<nodeId>": { /* detail payload */ } } },
    { "runId": "…", "snapshot": "2026-08-15T18:02:11Z", "ir": { /* … */ } }
  ]
}
```

- **The bundle carries IR, not raw transcripts** — redaction operates on this
  one documented schema, vendor neutrality survives sharing, and the viewer
  needs no adapters to open one. Detail payloads are embedded eagerly (a
  bundle has no transcript files to fetch them from lazily); they are capped
  at parse time, so a bundle shows the recipient exactly what the sender's own
  dashboard shows.
- **Workflow runs referenced by `runRef` are included transitively**, once —
  drill-down must work for the recipient.
- **Signals are not stored.** The viewer's server derives them at view time,
  exactly like any local run — one implementation, and an old bundle gets the
  current calibrated signal layer for free.
- **`snapshot`** marks a run that looked live at export time (its IR has no
  `endedAt`): a point-in-time capture, surfaced in the recipient's provenance
  badge.
- **Version posture:** a newer `bundleVersion` or `irVersion` is refused with
  a named upgrade message — never a blank screen or a partial render that
  silently drops fields. Bad gzip/JSON degrades to a named per-file banner;
  other bundles on the command line still serve.
- **Provenance lives on index entries, not in the IR:**
  `{ sharedBy, bundle, exportedAt, snapshot? }` describes the *transfer*, not
  the run, so the IR is untouched (no `irVersion` implications).

### The secrets scan

Export scans **whatever actually leaves, at every redaction tier** — labels,
detail payloads, file paths, everything — for anchored, prefix-keyed secret
patterns (AWS keys, GitHub/Slack/npm/Anthropic/OpenAI/Google/Stripe/SendGrid/
GitLab tokens, AWS secret assignments, PEM private-key blocks with real
bodies). On any hit the export blocks, listing each finding's run, node and
place. `--redact-secrets` replaces matches with `[REDACTED:<kind>]` and
verifies the output re-scans clean; `--allow-secrets` exports verbatim as a
deliberate, named act. No entropy heuristics — the pattern list is calibrated
against real corpora for near-zero false positives, and the scanner **fails
closed**: if it throws, nothing leaves.

### Structure-only census

The governing rule: **derived and mechanical survives; authored text dies.**

| survives | dies |
|---|---|
| node ids, kinds, status, error/call counts | every detail payload |
| timings, token counts, models, `agentId`, `runRef` | turn labels (→ `"turn N"`), agent labels (→ `"agent N"`), human labels (→ generic) |
| `files[]`, workflow names, tool names + their PATH-LEVEL label hints (a basename the node's own `files[]` carries, e.g. `Edit · auth.js`) | tool label hints that are authored text — Bash commands/descriptions, Grep patterns, WebSearch queries — reduce to the bare tool name |
| edges (id, kind, from, to), groups, run meta totals | run titles (→ `"session (structure only)"`) |
| | `edge.label` (prompt/result snippets), `edge.reason` (can quote answered questions verbatim), every `ext` bag (free-form, unauditable) |

A structure-only bundle still answers "where was feature X built" — file paths
and tool labels feed `find_nodes` — it just cannot answer "what did they say".

`GET /api/find` exists so an agent can narrow before pulling: a 500-node graph
is plausibly 40–50k tokens dropped into a session to answer one question. The
frontend does not call it — it imports the same matcher and filters locally,
avoiding a round trip per keystroke. One matcher, two consumers, so the human's
find and the agent's find cannot disagree.

## MCP (`rungraph mcp`)

The endpoints above map 1:1 onto the MCP tools, which is why `rungraph mcp` is
transport and almost no new logic. (`POST /api/resume` is the one deliberate
exception — there is no `resume` tool, because the agent end of the loop is
already inside a session; resume is the human's edge, from the dashboard.)

| tool | maps to |
|---|---|
| `list_runs` | `GET /api/index` |
| `get_graph(runId, detail?)` | `GET /api/graph/:runId` (`detail:"compact"` by default — ids, labels, kinds, files, signals; `"full"` adds timings and token counts) |
| `find_nodes(runId, query)` | `GET /api/find/:runId?q=` |
| `get_detail(runId, nodeId)` | `GET /api/detail/:nodeId?run=` |
| `focus_nodes(runId, nodeIds, label, reason)` | `POST /api/focus`; the response's `url` is a deep link (`#run=…&f=…`) restoring the focus |
| `get_current_view()` | `GET /api/view`, aggregated across every live server |
| `open_visualization(runId?)` | opens the browser, on the server that owns the run |

The read-only tools work with no server running — they parse from disk — so
asking an agent about a run never requires the dashboard to be open. Only the
focus and view tools need a server; without one they say the highlight was
skipped rather than failing.

**The port registry.** Every server writes `<port>.json`
(`{ port, pid, startedAt, sources }`) into a per-user `rungraph-servers-<uid>`
directory in the OS temp dir on startup and removes it on clean shutdown —
one file per server, so concurrent servers never race. Readers confirm
liveness with a real request before trusting an entry, and whoever finds a
dead one deletes it. **The MCP aggregates:** `list_runs` merges runs across
all live servers (bundle-served runs keep their `provenance` and gain the
owning `dashboard` URL); every other tool routes by `runId` to the server
actually serving that run, re-probing on a miss; a runId served by two
servers routes to the most recently started. Runs that exist on disk are
answered from disk, so the zero-server case keeps working.

**Deep links.** Focus state travels in the URL hash:
`#run=<runId>&sel=<nodeId>&f=<base64url(descriptor)>`, where the descriptor
names the focus **by its source, not its members** —
`{source:'find',query}` / `{source:'signal',signalId}` / `{source:'file',path}`
re-execute on load; only `{source:'agent',nodeIds,label,reason}` is an
explicit set. A link landing on a server that lacks the run consults
`GET /api/locate/:runId` and offers a jump to the server that has it.

Register it once with `rungraph mcp --install`, which registers with every
agent whose runs are on this machine (`--client claude|codex|hermes|opencode|all`
targets one, or all four). `--install --json` reports per client:
`{ detected, installed, already, pasted, failed, launch, clients: [...] }`. The
per-client object keeps every field a single-client install used to return at top
level (`client`, `installed`, `alreadyInstalled`, `scope`, `command`, `config`,
`reason`, and the paste-tier `configPath`/`configExists`/`candidates`/
`instructions`/`instructionsFile`), and adds `status` — `installed` / `already` /
`pasted` / `failed`, the one field to read. **One field was removed:** `wrote`,
which had become misleading once every client delegated — the vendor's own CLI
writes its own config file and rungraph writes none of them. `--check --json` keeps `{ ok, checks }`, and the new per-row fields (`client`,
a `state` of `ok`/`absent`/`broken`, `advisory`) are additive. **The DATA is not
additive, though:** the single check named `registered with claude` no longer
exists. It became one `registered · <client>` row per detected provider, so
`checks.find(c => c.name === 'registered with claude')` now returns undefined.
`ok` still means "the loop is usable", which is now "at least one detected
provider is registered".

## Versioning

`irVersion` bumps on breaking shape changes. Additive optional fields do not
bump the version. Adapters may emit fewer fields than documented (everything
optional is genuinely optional) — consumers must tolerate absence.
