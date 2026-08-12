# rungraph — Dashboard Signal & Focus Layer — Design Spec

**Date:** 2026-08-12
**Status:** Approved by Fayzan (brainstorming session, 2026-08-12)
**Parent spec:** `2026-08-11-rungraph-design.md` (v1). Companion: `2026-08-11-frontend-navigation-design.md`.

All v1 constraints carry over unchanged: agent-first CLI, vendor-neutral IR, parser purity,
never-blank-screen, localhost-only.

## Problem

rungraph reconstructs a run faithfully and renders it. That is where it stops, and it is why the
tool reads as impressive rather than useful: **the verb is "look at."** Nobody wakes up wanting to
review a graph. When a run went fine they don't care; when it went badly they want the answer, not
a picture.

Concretely, the dashboard has no opinion. Every node renders with equal weight — a two-second file
read and a forty-minute retry spiral are visually identical. The graph therefore shows *everything*,
which means it points at *nothing*, and the user still does all the work of finding what matters.

A second, related problem: the project has a split identity. It ships an agent-first CLI *and* a
human dashboard, with no stated relationship between them, so neither feels like the product.

## Scope

An in-dashboard utility layer that makes the canvas triage a run instead of merely displaying it,
plus the agent-facing surface that drives it.

**In scope (four phases):**

1. Derived signals + the focus mechanism + plain text find
2. File attribution on tool nodes + files list + click-to-focus
3. Live trouble escalation during running sessions
4. `rungraph mcp` + a focus channel, so a question asked in Claude Code lights up the graph

**Explicitly out:**

- **An embedded chatbot / headless `claude -p` in the dashboard.** Considered and rejected — see
  "Rejected approaches" below.
- Cross-run querying. Phase 4 answers against the open run only. Because file attribution lives in
  each run's IR and every run's IR is derivable on demand, a cross-run view later needs no migration
  — just iteration over runs. No cross-run index is built now.
- Run comparison, cost estimates, filtering. All "look at" features; none give the tool a job.
- Any change to how runs are discovered, parsed, or laid out.

### Rejected approaches

**Embedded query bar backed by `claude -p`.** The original design had the dashboard shell out to the
local `claude` binary to answer natural-language questions in a chat panel. Rejected by Fayzan on
direct experience from Claude Workflow Composer: running Claude headlessly behind a localhost UI
means owning model pinning and deprecation, prompt maintenance, and a streaming chat UI — and it
reproduces the observability hole where the conversation happens somewhere the user cannot properly
inspect it, unlike their terminal.

The replacement (Phase 4) keeps the capability and discards the liability: the question is asked in
the user's real Claude Code session, answered in their terminal with their model under their full
observability, and the *only* thing rungraph contributes is the graph lighting up. Nothing to pin,
nothing to maintain, no chat UI, no API key, no cost surprise.

This also resolves the split identity. The MCP surface is for the agent, the canvas is for the
human, and they are two ends of **one loop** rather than two competing products. The CLI/IR is
plumbing that serves the dashboard, not a co-equal deliverable.

## 1. The FocusSet spine

The four features are not four features. Attention markers, file clicks, text find, and the agent's
answer all reduce to *"light up this set of nodes, and say why."* The canvas needs that concept
exactly once:

```js
FocusSet = {
  nodeIds: string[],
  label:   string,   // "6 failed edits"
  reason:  string,   // why it matters
  source:  'signal' | 'find' | 'file' | 'agent',
}
```

| Producer | Phase |
|---|---|
| `deriveSignals(ir)` | 1 |
| text find | 1 |
| file click | 2 |
| `focus_nodes()` over MCP | 4 |

| Consumer | Behavior |
|---|---|
| canvas | members full opacity + ring; non-members dim to ~25% |
| signal strip | one chip per signal; collapses to zero height when there are none |
| inspector | the reason, and the ranked list to work down |

Exactly one `FocusSet | null` lives in `App` state and is passed to all three.

**Non-members dim, never hide.** Hiding collapses the layout and destroys the spatial memory the
user built up looking at the graph — the one thing a graph view is genuinely good for.

**Clearing:** `Esc`, or a click on empty canvas. (Both already deselect per the navigation spec;
focus clears on the same gestures.)

## 2. Layout (approved: split by scope)

Each pane answers exactly one question. The existing three-pane shell is unchanged apart from one
new strip:

```
┌──────────────────────────────────────────────────────────┐
│ header                                                   │
├──────────┬───────────────────────────────────┬───────────┤
│  runs    │ ⟳ 6 failed edits  ✋ 2 denials  ⚑  │  files /  │
│  (left)  ├───────────────────────────────────┤  detail   │
│          │            the graph              │  (right)  │
└──────────┴───────────────────────────────────┴───────────┘
```

- **Left** = which run (unchanged)
- **Strip** = what's wrong in this run (new; above the canvas, inside the centre column)
- **Right** = what's in this run (files, when nothing is selected) / what's in this node (detail, as today)
- **Centre** = the graph

The strip renders nothing at all when a run has no signals, so it costs zero height on a clean run.
It is also the escalation surface for Phase 3.

## 3. Signals (Phase 1)

`src/signals.js` exports a **pure** `deriveSignals(ir) → Signal[]`. It consumes the IR only — never
transcript lines — so parser purity is untouched and it is snapshot-testable against existing
fixtures.

```js
Signal = {
  id:       string,
  kind:     'retry-storm' | 'unresolved-error' | 'intervention' | 'outlier' | 'course-change',
  severity: 'high' | 'info',
  nodeIds:  string[],
  label:    string,
  reason:   string,
}
```

| kind | fires when | severity |
|---|---|---|
| `retry-storm` | a tool node's `errorCount >= 3`, or consecutive same-name tool nodes each carrying errors | high |
| `unresolved-error` | a tool node has errors and is the last occurrence of that tool in its lane — it failed and nothing came back to fix it | high |
| `intervention` | any `human` node | `denial`/`interrupt` → high; `answer` → info |
| `outlier` | node `tokens` or `durationMs` >= 3× the run's median **and** above an absolute floor | info |
| `course-change` | an edge already carries `reason`; promoted onto its target node | info |

"Lane" is the `sequence`-edge chain a node belongs to — the session backbone, or one agent's own
chain — as the term is used in `SCHEMA.md`.

The absolute floor on `outlier` exists because in a six-node run everything is 3× the median.

**Governing rule: precision over recall.** A false flag costs more than a missed one — the moment
the user stops trusting the markers they are back to reading the entire graph. Two consequences:

- `course-change` promotes existing `edge.reason` lineage only. No speculative "it abandoned an
  approach" inference.
- `outlier` is **list-only** — ranked in the inspector, never badged on the canvas. In a large
  session the biggest node is usually just the biggest node.

**Display budget:** canvas badges `high` only. Strip shows up to 4 chips plus "+n more". Inspector
holds the full ranked list, ordered `high` before `info`, then by position in the run.

**Thresholds are provisional.** `>= 3` and `3×` cannot be calibrated by reasoning. Implementation
must run `deriveSignals` against the fixture corpus *and* real sessions from Fayzan's own
`~/.claude/projects`, then adjust. The clean-run test (§11) is the guard.

### Where it runs

`deriveSignals` is applied wherever an IR is produced for a consumer — `cli.js` (the `graph`
command), `server.js` (`parseCached`), and `watcher.js` (`onGraph`). Three call sites, one function.
A test asserts `rungraph graph --json` includes `signals`, so a missed call site fails CI rather
than silently producing an agent/human mismatch.

This placement is the load-bearing decision. If signals were computed in the frontend, Claude
answering in the terminal and the graph on screen would disagree about what is wrong, with no way
for the user to tell which one was lying.

## 4. Text find (Phase 1)

A plain substring input in the strip. **No model involved.** Matches against node `label`, and
against `files[]` once Phase 2 lands. Produces a `FocusSet` with `source: 'find'`.

This exists because sometimes the user just wants to locate a string, and that should not require an
agent, a network call, or a subprocess.

The matcher lives in `src/find.js` as a pure `matchNodes(ir, query) → nodeIds` with **no Node
builtins**, so the frontend bundle can import it directly and filter locally without a round trip
per keystroke. The same function backs the `find_nodes` MCP tool in Phase 4 (§7) — one matcher, so
the human's find and the agent's find can never disagree.

Find does **not** auto-pan the viewport (it would thrash while typing). Agent-sourced focus does —
see §7.

## 5. Files (Phase 2)

**Adapter change.** `parse.js` currently stores tool inputs only as
`cap(JSON.stringify(block.input), 3000)` inside the lazily-fetched detail payload — the file path
exists, but only as display text. The adapter additionally extracts file paths into a structured,
generic `files[]` on tool nodes.

Knowledge of *which* tool names carry file paths (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, …)
is Claude-Code-specific and stays inside `adapters/claude-code/`. The emitted `files[]` is a
vendor-neutral array of paths. Tool nodes collapse multiple calls, so `files[]` is the de-duplicated
union across the group's calls.

**Agent nodes carry `files[]` too.** A subagent's tool calls do not become tool nodes — they live in
the agent node's detail `transcript[]`. Without this, work done inside subagents would be invisible
to the files lane, which would silently miss a large fraction of real edits. The adapter therefore
emits `files[]` on `agent` nodes as the union of paths touched anywhere in that agent's transcript.
Workflow nodes are not enumerated: they drill into their own graph via `runRef`, which carries its
own attribution.

**UI.** When nothing is selected, the inspector lists the run's touched files with a per-file count
of the nodes that touched them. Clicking one produces a `FocusSet` with `source: 'file'`.

This is the dashboard form of "why does this code exist" — it grounds an abstract graph in the
artifact the user actually cares about.

Paths are stored as the adapter observed them (absolute, as Claude Code records them). The frontend
displays them relative to the project root, which it reads from the run's `/api/index` entry
(`project`) — IR `meta` does not carry a project path and is not changed to.

## 6. Live escalation (Phase 3)

`watcher.js` already re-parses and diffs on file change. Signals are re-derived on each rebuild and
included **in full** in every delta payload (the array is small; diffing it is not worth the
complexity). A change in signals alone counts as a delta — `diffGraphs` currently returns `null`
when nothing changed, and must not suppress a rebuild where only the signal set moved.

When a new `high` signal appears on a live run, the strip escalates visually. The intent, in
Fayzan's framing: the user goes and does something else while the agent works, and rungraph pulls
them back at the moment intervention is actually worth it — ambient when things are fine, loud when
they are not.

**Out of reach, stated so nobody tries:** anything requiring knowledge of what the agent is *about
to do*. rungraph reads transcripts written after the fact. "The agent is blocked on a permission
prompt right now" is not reliably observable and is not designed for.

**Performance:** re-derivation is a pure pass over an in-memory IR and should be trivial, but it runs
on every delta. Implementation must measure on a large (500+ node) live run rather than assume.

## 7. MCP + focus channel (Phase 4)

`src/mcp.js`, exposed as `rungraph mcp`, wrapping the endpoints that already exist — the 1:1 mapping
`SCHEMA.md` has promised since v1.

| tool | maps to |
|---|---|
| `list_runs` | `GET /api/index` |
| `get_graph(runId)` | `GET /api/graph/:runId` |
| `find_nodes(runId, query)` | `GET /api/find/:runId?q=` (new) |
| `get_detail(runId, nodeId)` | `GET /api/detail/:nodeId?run=` |
| `focus_nodes(runId, nodeIds, label, reason)` | `POST /api/focus` (new) |
| `get_current_view()` | `GET /api/view` (new) |
| `open_visualization(runId?)` | opens the browser |

**The loop:** the user asks in their Claude Code terminal → Claude calls `find_nodes` / `get_graph` /
`get_detail`, which now carry `signals` and `files` → Claude answers **in the terminal** → Claude
calls `focus_nodes` → the server broadcasts on the SSE channel that already exists → the open
dashboard lights up.

### How node selection actually works

There is no retrieval algorithm here, and the spec should not imply one. The IR lands in Claude's
context as a structured document; Claude reasons over it the same way it reasons over a file it just
read, and returns node ids.

The primitive that makes this exact rather than fuzzy is **node id stability**, which `SCHEMA.md`
already guarantees for live-tail merging. Claude quotes ids back, the server resolves them, and no
fuzzy matching appears anywhere in the loop. The model does the semantic work; the addressing stays
exact.

The consequence is that **the IR's expressiveness is the bottleneck, not the query layer.**
`signals[]` and `files[]` are what let Claude answer well instead of guessing from labels — so
Phases 1 and 2 are load-bearing for Phase 4's answer quality, not merely its prerequisites.

### `find_nodes` — narrowing before pulling

`get_graph` on a large run is expensive: a 500-node graph is plausibly 40–50k tokens dropped into
the user's session to answer one question. `find_nodes(runId, query)` filters server-side and
returns only matching nodes, so Claude can narrow before pulling detail.

**It is the same matcher the Phase 1 text find uses.** `src/find.js` exports a pure
`matchNodes(ir, query) → nodeIds` with no Node builtins, imported by both `server.js` (for the
endpoint) and the frontend bundle (which filters locally, avoiding a round trip per keystroke).
One implementation, two consumers — the same pattern as `FocusSet` and `deriveSignals`, and for the
same reason: the agent and the human must not disagree about what matches.

### `get_current_view` — resolving "this run"

Without it, "this run" is ambiguous unless the user pastes a runId. The server already tracks SSE
clients per run, so `GET /api/view` returns `{ runs: [{ runId, clientCount }] }` — what the open
dashboards are actually showing. Empty array when no browser is connected, which is also how Claude
learns not to bother calling `focus_nodes`.

**Focus channel.** `POST /api/focus` accepts `{ runId, nodeIds, label, reason }` and broadcasts
`{ type: 'focus', ... }` to that run's SSE clients. Agent-sourced focus **does** pan/zoom the
viewport to the focused set — unlike find, the user asked for it and is looking at their terminal,
so the graph should have moved by the time they glance over.

**When the dashboard is on a different run,** the browser does *not* auto-switch — a background
process yanking the user's view to another run is worse than doing nothing. Instead the server
already tracks SSE clients per run, so `POST /api/focus` responds with how many clients are watching
that run, and the MCP tool passes that through. Claude can then tell the user in the terminal that
their dashboard is showing something else, and give them the run's URL.

**Port discovery.** The MCP process and the `serve` process are separate. `serve` writes
`{ port, pid, startedAt }` to a well-known file in the OS temp directory on startup and removes it
on clean shutdown. `mcp` reads it and confirms liveness with a `GET /api/index` before trusting it,
which also handles a stale file from a crashed process.

**Discoverability.** A user who only ever opens the dashboard will not know this exists. The
inspector's empty state carries a one-line affordance pointing at it.

**Setup cost, stated honestly.** This requires a one-time `claude mcp add`, which is a real dent in
the zero-setup promise. Mitigated by shipping `rungraph mcp --install` to perform the registration,
and by the fact that every other part of the tool keeps working without it.

## 8. IR additions

Additive; `irVersion` stays `1`, consistent with how `tool.context` was added.

```jsonc
{
  "irVersion": 1,
  "meta": { … },
  "nodes": [
    { "id": "n12", "kind": "tool",  "files": ["/abs/path/src/auth/token.js"] },
    { "id": "n19", "kind": "agent", "files": ["/abs/path/src/auth/session.js"] }
  ],
  "edges": [ … ],
  "groups": [ … ],
  "signals": [
    {
      "id": "sig-1",
      "kind": "retry-storm",
      "severity": "high",
      "nodeIds": ["n12"],
      "label": "6 failed edits",
      "reason": "Edit failed 6× on src/auth/token.js with no successful follow-up"
    }
  ]
}
```

- `signals` — top-level, sibling of `nodes`/`edges`/`groups`. Signals reference node *sets*, so they
  cannot live on individual nodes.
- `nodes[].files` — `tool` and `agent` nodes only; optional; absent rather than empty when nothing
  was touched.

Both names are vendor-neutral. `SCHEMA.md` is updated in the same change, including a note that
consumers must tolerate absence of both (older graphs, adapters that cannot supply them).

## 9. Error handling & degradation

Extending the never-blank-screen rule:

| failure | behavior |
|---|---|
| `deriveSignals` throws | log to stderr, return `[]`, graph renders normally. Signals are an enhancement, never a render dependency. |
| tool input has no recognizable file path | contributes nothing to `files[]`. No crash, no placeholder entry. |
| FocusSet references node ids a live delta has removed | filter to known ids; if that empties the set, clear focus and tell the user the nodes are gone. |
| MCP tool called with no `serve` running | answer in the terminal, skip the highlight, and say it was skipped. |
| `serve` running but no browser tab open | POST succeeds, SSE has zero clients, nothing happens. Not an error. |
| stale port file from a crashed server | liveness check fails, treated as "no server running". |

## 10. Security posture

`POST /api/focus` is the server's **first write endpoint**. Noting it explicitly rather than letting
it appear silently in a tool whose pitch is privacy:

- It binds `127.0.0.1` only, like everything else. Nothing leaves the machine.
- It accepts node ids and display strings, and its only effect is which nodes a local browser tab
  highlights. It reads no new files and mutates nothing on disk.
- Any local process that could POST to it can already read `~/.claude/projects` directly, so it
  grants no capability that did not already exist.

## 11. Testing

Following the existing fixture-driven approach:

- `tests/signals.test.js` — snapshot `deriveSignals` across current fixtures, plus purpose-built
  fixtures per signal kind (a retry storm, a denial, an unresolved error, an outlier).
- **A clean run must produce zero signals.** This is the precision guard and the test most likely to
  catch threshold drift.
- `tests/cli.test.js` — `rungraph graph --json` includes `signals`, so a missed call site fails CI.
- `tests/adapter.test.js` — snapshots regenerate for `files[]`; a fixture covering a tool call with
  no file path asserts the field is absent, not empty. The existing subagent fixture asserts its
  `agent` node carries the files edited inside the subagent, since that path is the easiest to
  regress and the most costly to miss.
- `tests/find.test.js` — `matchNodes` over fixtures: label hits, `files[]` hits, empty query returns
  nothing (not everything), and no Node builtins are imported so the frontend bundle can consume it.
- `tests/server.test.js` — `POST /api/focus` reaches connected SSE clients; a POST for a run with no
  clients succeeds silently; malformed bodies return 400 without killing the server. `GET /api/find`
  returns the same ids `matchNodes` returns directly. `GET /api/view` reports connected runs and an
  empty array when nothing is watching.
- Frontend stays manual + demo per CLAUDE.md, except the pure focus-filtering helpers, which
  unit-test alongside `viewmath`.

## Phasing

| phase | ships | depends on |
|---|---|---|
| 1 | `src/signals.js`, `src/find.js`, focus state in canvas, signal strip, text find | — |
| 2 | `files[]` extraction, files list in inspector, click-to-focus | 1 |
| 3 | signals on live deltas, strip escalation | 1 |
| 4 | `rungraph mcp` (incl. `find_nodes`, `get_current_view`), `POST /api/focus`, agent-driven focus | 1, 2 |

Phase 1 is releasable alone and carries most of the value. Phase 4 is cheap *because* Phase 1 builds
the focus mechanism and the matcher it needs — it contributes little new logic of its own, mostly
transport.

Phase 4 now depends on Phase 2 as well. Not to compile — `find_nodes` and `focus_nodes` work without
`files[]` — but for answer quality: without file attribution Claude is matching on node labels alone,
which is the difference between "the retry loop on `token.js`" and "some Edit node failed."

## Open questions for implementation

1. **Threshold calibration** — `errorCount >= 3`, `3×` median, and the `outlier` absolute floor are
   starting values to be tuned against real sessions.
2. **Strip overflow** — "+n more" opens the inspector list; whether it should also be keyboard
   reachable is a detail for the frontend pass.
3. **`--install` ergonomics** — whether `rungraph mcp --install` writes user-level or project-level
   MCP config, and what it does when an entry already exists.
4. **`get_graph` size on large runs** — `find_nodes` gives Claude a way to narrow, but nothing
   *stops* it calling `get_graph` on a 500-node run and spending 40–50k tokens. Whether the tool
   needs a compact projection (ids, labels, kinds, signals — no timings or token counts) or simply a
   tool description steering toward `find_nodes` first should be decided by measuring a real large
   run, not up front.
