# rungraph — project instructions

Zero-setup, agent-first visualizer for AI coding-agent runs: `npx rungraph` reconstructs Claude Code sessions + Workflow runs from `~/.claude/projects` native transcripts (post-hoc, no hooks) into an interactive directed agentic graph, with live tail via file watching.

## Current state

- **Specs (source of truth, read before any work):**
  - `docs/superpowers/specs/2026-08-11-rungraph-design.md` — v1 architecture.
  - `docs/superpowers/specs/2026-08-11-frontend-navigation-design.md` — canvas navigation.
  - `docs/superpowers/specs/2026-08-12-signal-and-focus-layer-design.md` — signals, focus, files, MCP.
- **v1 and the signal & focus layer are implemented.** Scanner, adapter, IR, CLI, server,
  live-tail watcher, the Preact frontend, `deriveSignals`, file attribution, the FocusSet
  spine, and `rungraph mcp` all ship.

## The one loop

The MCP surface is for the agent, the canvas is for the human, and they are **two ends of one
loop** rather than two products: the user asks in their Claude Code terminal, Claude answers
there (their model, their session, their observability), then calls `focus_nodes` and the open
dashboard lights up. The CLI/IR is plumbing that serves the dashboard, not a co-equal
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
- **Privacy:** server binds `127.0.0.1` only; nothing leaves the machine. Two write endpoints,
  `POST /api/focus` and `POST /api/resume`, both behind the same non-localhost-`Origin`
  rejection and Host guard; neither executes or persists request-supplied strings (resume takes
  a runId lookup key and a boolean — the adapter rebuilds the command from the server's own
  scan), and neither writes to disk.
- **Zero runtime dependencies.** `package.json` has devDependencies only, and that is
  load-bearing for `npx rungraph`. `src/mcp.js` hand-rolls JSON-RPC over stdio for this reason.
- **Still out of scope:** run comparison, filtering, cost estimates, cross-run querying.

## Shared code, one implementation

Four things exist exactly once because a second copy could disagree with the first:

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
otherwise imply completeness. Pure frontend
helpers (`viewmath`, `focus`) are unit-tested; the rendered UI is manual + demo.
CI: GitHub Actions, Node ≥ 20.

## Stack

Single npm package `rungraph` (name verified available 2026-08-11). Node ≥ 20, MIT. Frontend: Preact + elkjs + SVG, prebuilt at publish time and shipped in the package — users never build.
