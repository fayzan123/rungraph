# rungraph — project instructions

Zero-setup, agent-first visualizer for AI coding-agent runs: `npx rungraph` reconstructs Claude Code sessions + Workflow runs from `~/.claude/projects` native transcripts (post-hoc, no hooks) into an interactive directed agentic graph, with live tail via file watching.

## Current state

- **Specs (source of truth, read before any work):**
  - `docs/superpowers/specs/2026-08-11-rungraph-design.md` — v1 architecture.
  - `docs/superpowers/specs/2026-08-11-frontend-navigation-design.md` — canvas navigation.
  - `docs/superpowers/specs/2026-08-12-signal-and-focus-layer-design.md` — signals, focus, files, MCP.
  - `docs/superpowers/specs/2026-08-20-opencode-adapter-design.md` — the opencode adapter,
    `src/sqlite.js`, and the core `IRNode.reverted` field.
  - `docs/superpowers/specs/2026-08-20-mcp-install-loop-design.md` — `src/clients.js`,
    multi-client `--install`/`--check`, the launch resolver and the `serve` nudge. Read its
    **Implementation amendments** section: two of its ground-truth claims were falsified by
    re-probing during the build, and the code follows the probe, not the spec.
  - `docs/superpowers/specs/2026-08-20-cursor-adapter-design.md` — the Cursor adapter (one
    adapter, two stores), the key-name redaction rule in `src/secrets.js`, and the first
    genuine paste-tier client. Read its **Implementation amendments** and the §14
    calibration record: the build deviated from the spec's letter in fifteen recorded places —
    four from the build, eleven from the 53-agent adversarial review after it.
- **v1 and the signal & focus layer are implemented.** Scanner, adapter, IR, CLI, server,
  live-tail watcher, the Preact frontend, `deriveSignals`, file attribution, the FocusSet
  spine, and `rungraph mcp` all ship.
- **Five adapters ship, and five clients:** claude-code, codex, hermes, opencode, cursor. The
  last three read SQLite through the shared `src/sqlite.js` and need Node ≥ 22.13; on older
  Nodes they self-disable with a structured warning, and only when a database actually exists
  to be skipped. Cursor is **two stores under one adapter** — the IDE's global `state.vscdb`
  (every project's conversations in one key-value table) and `cursor-agent`'s per-chat
  `store.db` (a content-addressed blob store whose conversation order lives in a protobuf
  root snapshot) — because the rail should show one vendor for one product. Refs carry
  `surface: 'ide' | 'cli'`; the scan root array holds both roots and the adapter classifies
  each by shape. No Cursor field says whether a tool call succeeded (a refused command is
  `status: completed`), so `outcome.js` is a calibrated classifier shared by both surfaces.

## The one loop

The MCP surface is for the agent, the canvas is for the human, and they are **two ends of one
loop** rather than two products: the user asks in their Claude Code terminal, Claude answers
there (their model, their session, their observability), then calls `focus_nodes` and the open
dashboard lights up. opencode and Cursor close the same loop (both speak MCP); Codex and
Hermes structurally cannot, which is most of why opencode and Cursor earned adapters. The CLI/IR is plumbing that serves the dashboard, not a co-equal
deliverable. Deliberately rejected: an embedded chatbot or headless `claude -p` behind the
localhost UI — it would mean owning model pinning, prompt maintenance and a chat UI, and would
hide the conversation somewhere the user cannot inspect it.

**You are the agent end of that loop.** When the rungraph MCP tools are available, close the
loop yourself: after answering any question about work done in this project, call `focus_nodes`
(`list_runs` → `find_nodes` → `focus_nodes`) so an open dashboard shows the nodes your answer
is about. This includes code questions — "where was X integrated" maps to the run that wrote
the code. Answer first in the terminal; the highlight follows, and is a bonus, never the answer.

`deriveSignals` runs **server-side, at every point an IR reaches a consumer** (`cli.js`,
`server.js`, `watcher.js`). This is load-bearing: computed in the frontend instead, Claude
answering in the terminal and the graph on screen could disagree about what is wrong with no
way to tell which one was lying. `tests/cli.test.js` fails CI if a call site is missed.

**Coverage** (`meta.coverage`) is the same discipline applied to the question underneath the
signals: not "what went wrong" but "how much of this run could I read at all". It is counted
by the adapters as they parse and classified by one shared function, so the badge on the
canvas and the note on the MCP read tools fire on exactly the same verdicts. Without it a
transcript that was 40% unreadable renders identically to a run that was read completely and
found clean — "nothing went wrong" and "I could not see part of this" collapse into the same
empty strip.

**Precision over recall** governs the signal layer. A false flag costs more than a missed one —
once the markers are not trusted the user is back to reading the whole graph. The clean-run
test (a run with zero signals) is the guard; thresholds in `THRESHOLDS` are calibrated against
real sessions, never reasoned into place.

## Non-negotiable constraints (from the approved spec)

- **Agent-first CLI:** every subcommand non-interactive with `--json`; data on stdout, logs on stderr; exit codes 0/1/2; no prompts anywhere. Agents must be able to operate the whole tool via Bash.
- **Vendor-neutral IR:** no Claude-specific names or fields outside `adapters/claude-code/`. Provider extras go in a namespaced `ext` bag. Everything downstream consumes only the IR (`irVersion: 1`, documented in SCHEMA.md).
- **Parser purity:** adapters take lines in, return IR out — no server imports, no I/O beyond reading the run's own files, plus one stat-only existence probe of the run's recorded cwd in `detect()` (it feeds `resumeInfo`'s cwd rule; `resumeInfo` itself is pure string construction). All format knowledge lives in adapters.
- **Never blank-screen:** unknown lines are skipped + counted, surfaced as a banner, never a crash. Truncated JSONL lines (live tail mid-write) are tolerated.
- **Privacy:** server binds `127.0.0.1` only. Content leaves the machine at exactly two
  boundaries and both redact secrets: `rungraph export` (blocks) and `rungraph mcp` (redacts
  at the `callTool` choke point, so labels are covered as well as payloads, and reports the
  count). The dashboard is deliberately NOT one of them — it renders to the user's own browser
  over loopback, where seeing a key is how you rotate it. Two write endpoints,
  `POST /api/focus` and `POST /api/resume`, both behind the same non-localhost-`Origin`
  rejection and Host guard; neither executes or persists request-supplied strings (resume takes
  a runId lookup key and a boolean — the adapter rebuilds the command from the server's own
  scan), and neither writes to disk.
- **Zero runtime dependencies.** `package.json` has devDependencies only, and that is
  load-bearing for `npx rungraph`. `src/mcp.js` hand-rolls JSON-RPC over stdio for this reason.
- **Still out of scope:** run comparison, filtering the *graph* (the picker narrows the run
  list by agent chip and by title), cost estimates, cross-run querying.

## Shared code, one implementation

Seven things exist exactly once because a second copy could disagree with the first:

- `src/signals.js` — the run's opinion. Server-side only.
- `src/find.js` — the matcher. **No imports at all**, so the frontend bundle imports it directly
  from `src/` and filters locally; `server.js` uses the same function for `GET /api/find` and
  the `find_nodes` MCP tool. A `node:` import here breaks the bundle (`tests/find.test.js` guards it).
- `src/coverage.js` — what "read N% of this run" means, and whether that is worth saying.
  **No imports at all**, same contract and same reason as `find.js`: the frontend imports it
  from `src/` for the strip badge, `mcp.js` imports it for the agent's note. Two copies could
  disagree about whether a run is quiet or loud, which is the failure it exists to prevent.
  Its thresholds are calibrated (and the one judgment call is labelled as one) — read the
  comments before touching them.
- `src/secrets.js` — the calibrated pattern list, plus `walkStrings`/`redactTree`. Two
  boundaries call it (`bundle.js` on export, `mcp.js` on every tool result) and they must
  agree about what a secret is; the walker lives here rather than in `bundle.js` so `mcp.js`
  never has to import the export path to get one. Pure, no imports. Read the calibration
  comments before touching the patterns.
- `src/sqlite.js` — the ONE `node:sqlite` touchpoint: the Node ≥ 22.13 gate, the
  readonly open, the crash-recovery copy, and the schema-tolerance helpers
  (`tableColumns`/`selectList`). It names no adapter and knows no schema — every
  column list, query and table name stays in its adapter. Extracted from
  `adapters/hermes/db.js` the day the opencode adapter arrived, which is the
  moment this whole rule was written for: two copies of the recovery policy
  could disagree. `tests/hermes.test.js` passing unmodified across the
  extraction is the extraction's own test.
- `src/clients.js` — the MCP client table: how rungraph installs into an agent and
  how it reads back whether it is there. `--install`, `--check` and `serve`'s nudge each
  need that answer, and three copies of it DID disagree — `--install` knew two clients,
  `--check` knew one, and the README published a third (a Hermes line that silently
  no-ops when scripted). Keyed to `ADAPTERS` by `adapter`, because an adapter's runs on
  disk are the entire detection mechanism; `tests/clients.test.js` fails CI if an adapter
  has no entry, so a fifth adapter cannot land without deciding how that provider
  installs. It does NOT take the no-imports rule — nothing in `frontend/` imports it, and
  §6's provider-neutral dashboard copy is what keeps that true. Every vendor behaviour in
  it was probed against the real CLI, and the per-entry comments record what was SEEN.
- `frontend/src/focus.js` — the FocusSet spine. Attention markers, file clicks, text find and
  the agent's answer are not four features; they all reduce to "light up this set of nodes, and
  say why". Non-members **dim, never hide** — hiding collapses the layout and destroys the
  spatial memory a graph view is uniquely good for.

## Testing

Fixture-driven TDD on the parser/adapters: synthetic format-faithful transcripts in
`tests/fixtures/` (regenerate with `node tests/fixtures/generate.mjs`), snapshot-tested IR.
The corpus deliberately includes a **clean run** (session `3333…`, must derive zero signals
AND zero unread records), a **trouble run** (session `4444…`, one of every high-severity
signal), and two **drift runs** (`6666…` quiet at 95% read, `7777…` loud at 21%) — both with
zero signals, because the coverage triggers exist for exactly the moment the UI would
otherwise imply completeness. The **secrets run** (`5555…`) carries one of every scanner
pattern kind across all five places outgoing text lives; the fifth is a **node label**,
which is what pins redaction to the `callTool` choke point instead of to `get_detail`
(labels reach `find_nodes` and `get_graph` without any payload being fetched). The
**compaction seam run** (`8888…`, seam records 1:1 on a live 2.1.241 `/compact` probe,
2026-08-23) pins three things: the fabricated summary is never a prompt a human typed, the
seam rides the next spine edge as `after context compaction`, and the seam costs nothing in
coverage. Pure frontend
helpers (`viewmath`, `focus`) are unit-tested; the rendered UI is manual + demo.
CI: GitHub Actions, Node ≥ 20.

The SQLite adapters keep committed `.db` fixtures (`tests/fixtures/hermes/`,
`tests/fixtures/opencode/`), regenerated by the same generator and never hand-edited. The
opencode corpus mirrors the same discipline — clean, trouble, drift ×2, secrets — and adds
the ones only opencode can pose: a **reverted run** whose work-quality signals are suppressed
*while an intervention inside the same reverted region still fires* (asserting only the first
half would let a blanket exclusion pass), a **14-call/5-error batch** that must parse to
`completed` and fire nothing, a **fork** that must be its own run with `copiedHistory` and no
invented origin, and a **compaction** whose fabricated user message must never read as a
prompt a human typed. Two more came out of the adversarial review and exist only as guards:
a **revert crossing a subagent lane** (`revert` is written on the session the user was
looking at, never on the child it dispatched, so the lane must INHERIT the boundary) and a
**refused `task`** (opencode permission-gates dispatch before it creates the child row, so a
denied subagent has the rejection string and no session id — it is an intervention, not a
phantom lane and not a coverage penalty). Both passed the whole suite before their fixes,
because nothing in the corpus crossed those two features. One cross-adapter test asserts the tool-node status invariant
(`error` iff `errorCount >= callCount`) over all five adapters' corpora — it previously existed as four
independent copies and was asserted nowhere. A second asserts the **compaction-seam rule**:
wherever an adapter records a compaction it writes exactly `after context compaction` on a
sequence edge (claude-code, codex and opencode carry seam fixtures), and the seam is a fact,
never a `course-change` signal — three adapters previously represented it three ways (edge
reason, ext count, nothing at all).

The Cursor corpus (`tests/fixtures/cursor/ide/state.vscdb` and `tests/fixtures/cursor/cli/chats/…`)
is shaped by the calibration sessions of 2026-08-20 and 2026-08-23: a **clean** IDE run, a
**trouble** run holding all four observed encodings of "did not succeed" (a `status: error`
read, a `completed` command with `additionalData.status: error`, a `completed` command with
`additionalData.status: rejected`, a `cancelled` edit) plus the abort, a **rejection** run, an
**in-flight** run carrying one `loading` call and one call with a status outside the 3.16.29
vocabulary (must NOT read as running), a **subagent** tree found by both routes — including a
grandchild linked only by its own `parentComposerId` — with one missing child, a
**tombstoned** run with NULL and absent rows, skip-flagged bubbles and a refused command whose
body is gone, a **refused batch** of three families (one denial) followed by a retry (a
second), an **applied edit** with a checkpoint record, a
**`_v:3`** composer (listed, 0% read, loud), a **degraded `_v:9`** composer with the modern
fields removed, a **cross-project** composer, a **bucket** composer, a **secrets** composer
carrying both encryption-key fields and a 64-hex blob id beside one scanner pattern in each
of the five outgoing places, and — on the CLI side — the rev-2 shape (parallel batch, two
refusals → two denial nodes), the rev-3 shape (`error` + `failure{exitCode:3, isError:false}`
+ an applied `StrReplace`), a three-family refused batch from one message, a **sibling batch**
(one call refused, its sibling failed and never fixed — the refusal must not excuse the
sibling), an in-flight root and an unreadable root. Nine approved commands
in the trouble run carry `blockReason` and the dialog's default `selectedOption`, which is the
calibration guard for the two fields §6 of the spec rules out. A 10 000-composer store is
synthesised at test time for the `detect()` budget, and one test drives `watchRun` across the
CLI's WAL delete/recreate.

`tests/clients.test.js` covers the MCP install loop, and splits the same way the SQLite
adapters do: the table shape, the launch resolver, the breadcrumb/nudge and a
`--check --json` case driven by **PATH shims** all run everywhere including CI, while one
integration test per vendor is gated on that vendor's binary and is the developer's local
gate. Those four run real `mcp add` commands, so every vendor config home is redirected
into the sandbox **by default** rather than per-test — a fail-safe written after a test that
only meant to read a JSON report delegated for real and registered rungraph in the
developer's own `~/.config/opencode/opencode.jsonc`. Note which variable isolates opencode:
`XDG_CONFIG_HOME`, not `OPENCODE_CONFIG` — opencode honours the latter on its READ path only.

**Calibration is local and recorded, never inferred.** The opencode gate ran the adapter over
this machine's real corpus on 2026-08-20 (10 runs / 2,561 rows, the fork excluded because it
duplicates its origin's history): zero unrecognized, zero unread sources, and the outlier
signal fired on **0 of 70 turns**. `THRESHOLDS` was not touched. Recall was not assessed and
nothing here claims it was. The Cursor gate ran over this machine's real corpus on 2026-08-23
(3 modern IDE composers / 101 headers, 2 CLI chats / 26 messages, 6 pre-`_v:9` composers
listed unread): zero unrecognized, zero unread sources on every modern run, `intervention` on
the trouble and rejection runs and the rev-2 CLI chat, nothing on the clean run, and `outlier`
on **0 of 6 turns**. `THRESHOLDS` was not touched.

## Stack

Single npm package `rungraph` (name verified available 2026-08-11). Node ≥ 20, MIT. Frontend: Preact + elkjs + SVG, prebuilt at publish time and shipped in the package — users never build.
