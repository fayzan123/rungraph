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
  JSONL lines for `claude-code` and `codex`, walked rows for `hermes` and
  `opencode`, and for `cursor` conversation **headers** walked (IDE) or root
  snapshot **entries** walked (CLI). Because
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

- **`meta.ext.claudeCode`** — `{ compaction?, compactions?, unknownTypes? }`.
  `compaction` counts the run's compaction seams; `compactions` carries one
  `{ trigger?, preTokens?, postTokens? }` per seam, from the binary's own
  `compactMetadata` (`trigger` is `"manual"` for `/compact`, `"auto"` at the
  context limit). The seam itself is vendor-neutral — see the edge `reason`
  contract under **edges** — and the summary message the binary fabricates
  (`isCompactSummary`) is never rendered as a turn a human typed.
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
- **`meta.ext.cursor`** — one bag, two shapes, told apart by `surface`:
  `"ide"` (a Cursor IDE conversation out of `state.vscdb`) or `"cli"` (a
  `cursor-agent` chat out of its per-chat `store.db`).
  - IDE: `{ surface: "ide", _v, status?, unifiedMode?, forceMode?, isAgentic?,
    agentBackend?, model?, contextUsage?, totalLinesAdded?, totalLinesRemoved?,
    filesChangedCount?, isArchived?, unsupportedVersion?, skippedBubbles?,
    orphanBubbles?, missingChildComposers?, unknownTypes?, unknownToolStatuses? }`.
    `_v` is Cursor's composer format version (17 today); a composer below the
    adapter's floor (`_v < 9`) is **listed, never parsed**, carries
    `unsupportedVersion: true`, and reports every header as `unrecognized`
    under the type name `composer-v<N>`, so the badge reads "only 0% of this
    run could be parsed" rather than implying it was read.
  - CLI: `{ surface: "cli", mode?, isRunEverything?, model?, cliSchemaVersion?,
    rootUnreadable?, unmatchedResults?, unknownTypes?, unknownBlockTypes? }`.
    `isRunEverything` is `cursor-agent --force`; `cliSchemaVersion` appears only
    when `meta.json`'s `schemaVersion` is not the `1` this adapter was built
    on; `rootUnreadable` names which of the four reasons left the graph empty
    (`meta`, `no-root-id`, `root-missing`, `root-unparseable`) — such a run
    reports `records: 0, sourcesUnread: 1` and is still listed.
  - **`totals.tokens` is always `0` for Cursor.** Per-message token counts are
    `{0, 0}` on every record measured, and the IDE composer's
    `contextTokensUsed / contextTokenLimit` is a **context-window gauge, not
    spend** — reporting it as totals would overstate cost by an unknowable
    factor. It is carried as `contextUsage: { tokensUsed, tokenLimit, percent }`
    with its meaning intact. This is a real gap relative to Hermes and opencode.
  - `unknownToolStatuses` and `unknownBlockTypes` are **drift tallies, not
    coverage events**: a tool call whose `status` is outside the vocabulary the
    adapter knows is still classified on its evidence (never as `running`), and
    a message holding an unknown block type still counts as read. They are
    separate from `unknownTypes` on purpose, so the coverage note does not
    mistake vocabulary drift for unread records.
  - Neither of Cursor's two encryption-key fields is ever copied into this bag,
    the IR or the details — and `redactTree` additionally redacts any value
    under those field names by position (see the secrets scan).
- **`node.ext.codex`** (agent nodes) — `{ nickname, agentPath, depth }`,
  Codex's multi-agent lineage.
- **`meta.ext.<adapter>.unknownTypes`** — `{ "<record type>": count }`, the
  record types that adapter could not interpret. Present on any adapter, hence
  the `<adapter>` key (`claudeCode`, `codex`, `hermes`, `opencode`, `cursor`). Type names are vendor
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
| `startedAt` / `endedAt` | ISO 8601 (optional) | On a `tool` node `endedAt` is the group's **last resolution** — see [Replay timings](#replay-timings-calloffsets-and-tool-endedat). |
| `durationMs` | number (optional) | Never on `tool` nodes (see Replay timings). |
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
  collapse into one node ("Bash ×7"). Extra fields: `callCount`, `errorCount`,
  and the replay timings `callOffsets` (optional) and `endedAt` (optional) —
  see below. Individual calls live in the detail payload.
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

### Replay timings: `callOffsets` and tool `endedAt`

Additive in `irVersion` 1, on `tool` nodes only, absent on every graph written
before they existed. They are what makes a collapsed group replayable at
call granularity — a `Bash ×24` node whose `×N` counts up instead of appearing
whole. Every adapter with a per-call clock populates both; the Cursor CLI
store has no per-call timestamps and populates neither, and its groups appear
whole at their start.

**`callOffsets: number[]`** — each collapsed call's start, in **whole
milliseconds after the node's `startedAt`**, in the same order as the detail
payload's `calls[]`.

- Present only on groups of **two or more calls**. A single-call node carries
  nothing: call 0 *is* the node's start, so `[0]` would be information-free
  bytes on the majority of tool nodes — the same reasoning as `files` being
  absent rather than `[]`.
- Present only when the adapter timed **every** call in the group. One untimed
  call → no array. There is no partial list.
- Invariants: `callOffsets[0] === 0`, every entry an integer `≥ 0`,
  non-decreasing, `length === callCount`. An adapter that would compute a list
  violating any of these omits it whole, and `src/timeline.js` treats a
  malformed list as absent — never partially used.
- The guard equation, asserted across all five corpora:
  `callOffsets[i] === Date.parse(calls[i].startedAt) − Date.parse(node.startedAt)`
  where `calls[]` is the tool detail payload. The node field and the detail
  timestamp derive from one instant, so they cannot disagree.
- A batch issued in one row (Hermes issues several calls per assistant row)
  reads `[0, 0, 0]`. That is the truth — they were issued together — and it is
  documented, never smoothed.

**`endedAt`** — the group's **last resolution**: the latest result, error, or
human denial/refusal among its calls. Present only once **every** call has
resolved; a live group whose last call has no result yet carries none, exactly
as a live turn does. Never earlier than `startedAt` (an adapter that would
write one omits it).

**Deliberately not `durationMs`.** The `outlier` signal reads `durationMs`, and
tool groups are roughly 40% of a session's nodes — giving them a duration would
add a whole new population to the median the outlier is measured against, a
calibrated threshold moved as a side effect of a feature that has nothing to
do with it. `endedAt` alone leaves the signal layer byte-for-byte unchanged,
and the cross-adapter test asserts no tool node carries `durationMs`.

Downstream: both fields ride `rungraph graph --json` and the MCP `get_graph`
`detail:"full"` projection (like every other timing), are dropped by the
compact projection (a timing whitelist that never carried `startedAt` either),
and survive the structure-only bundle census (mechanical, not authored).

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
- One `reason` value is a cross-adapter contract rather than free text:
  `"after context compaction"` on a `sequence` edge marks a compaction seam —
  history was rewritten under the model at this point. Every adapter whose
  format records a compaction writes exactly this string (claude-code, codex
  and opencode today; `tests/opencode.test.js` holds the invariant), it is
  never promoted into a `course-change` signal (a seam is a fact, not a
  decision), and vendor detail rides the `ext` bags on top.

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
{ "kind": "tool",     "name": "…", "context": "…?", "calls": [{ "startedAt?", "input", "output", "isError", "durationMs?" }] }
{ "kind": "workflow", "returnValue": "…" }
{ "kind": "human",    "context": "…", "answer": "…" }
```

Detail payload strings are pre-truncated server-side to keep responses small;
they are display artifacts, not a data-fidelity contract.

`tool.context` (optional, additive in irVersion 1): the assistant's narration
emitted immediately before the group's first call — the "why" behind the tool
use. Absent when there was no narration; consumers must tolerate absence.

`tool.calls[].startedAt` (optional ISO 8601): the instant the call was issued,
from the same source the node's `callOffsets` are derived from — the
inspector's per-call timestamp, and the guard on the node field:
`callOffsets[i] === Date.parse(calls[i].startedAt) − Date.parse(node.startedAt)`.
Absent where the format records no per-call clock (the Cursor CLI store).

### Replay / timeline

The run as a sequence of events is derived, never parsed, by one pure module
(`src/timeline.js`, no imports — the frontend and the server share it, so "the
graph at 14:02" cannot mean two things). Each node contributes a `start`
(`startedAt`, or the carried-forward time of its predecessor in run order when
absent), a `call` per `callOffsets` entry after the first, and an `end`
(`endedAt`, or `startedAt + durationMs` when both are real; nothing is
invented). A playhead is a position in that sorted list, and its stable
identity across live re-parses is a **timestamp**, never an index.

**The reveal rule.** A signal counts at the moment its evidence is **complete**:
the maximum over its `nodeIds` of the node's end index, or its start index
where there is no end. It is shown iff that index is below the playhead — the
same comparison node presence uses. So a retry storm is never badged before
it was one, an unresolved error appears when the failing call has failed and
not when it was issued, and a clustered chip ("3 denials") appears at the
third. Nothing is re-derived at replay time, only revealed: an agent reading
timings and the strip on screen agree about when each signal became true.

`callOffsets` and tool `endedAt` are graph fields, not detail payloads: the
timeline is built from the IR alone, without fetching a single call.

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

One rule is keyed by field **name** rather than value shape: a non-empty value
under `blobEncryptionKey` or `speculativeSummarizationEncryptionKey` (the two
live keys Cursor keeps on its records) is a finding and is redacted as
`[REDACTED:key-name]` wherever it sits in the tree. Those values are a bare
64-hex string and a base64 string that no prefix pattern can catch, and the
obvious value-shape fix — a 64-hex pattern — would redact every content-hash
id in Cursor's stores. The adapter never copies either field in the first
place; this rule guards the day a future payload dumps a raw record.

### Structure-only census

The governing rule: **derived and mechanical survives; authored text dies.**

| survives | dies |
|---|---|
| node ids, kinds, status, error/call counts | every detail payload |
| timings — including the replay fields `callOffsets` and tool `endedAt` — token counts, models, `agentId`, `runRef` | turn labels (→ `"turn N"`), agent labels (→ `"agent N"`), human labels (→ generic) |
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
agent whose runs are on this machine (`--client claude|codex|hermes|opencode|cursor|all`
targets one, or all five). Cursor is the paste tier — `cursor-agent mcp` has
no `add` — so its row is always `pasted`, and its per-client object carries a
`deeplink` (`cursor://anysphere.cursor-deeplink/mcp/install?…`) beside the
block: the IDE's own one-click install, printed and never invoked. `--install --json` reports per client:
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
