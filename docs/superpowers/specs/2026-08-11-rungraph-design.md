# rungraph — Design Spec

**Date:** 2026-08-11
**Status:** Approved by Fayzan (brainstorming session, 2026-08-11)

## What it is

`rungraph` is an open-source, zero-setup visualizer for AI agent runs. One command — `npx rungraph` — reconstructs coding-agent sessions from the transcripts already on disk and renders them as an interactive **directed agentic graph**: orchestrator, subagents, and tools as nodes; spawn/return/sequence relationships as edges; decision lineage (why the run moved the way it did) on the edges.

**The wedge:** post-hoc + zero-setup. Competing tools (agent-flow) require hooks configured *before* the session; rungraph works retroactively on every session the user has ever run, with no instrumentation. Core is vendor-agnostic; v1 ships the Claude Code adapter.

**Success criteria (v1):** ship in ~2 weeks of side-channel time; launch post (Show HN + r/ClaudeAI) anchored by two demo GIFs — "point it at yesterday's session, see the graph" and "watch a live workflow bloom"; meaningful stars in month one. Scope is cut to exactly those two moments.

## Requirements (settled)

1. **Surface:** local web app. `npx rungraph` starts a local server and opens the browser. Terminal is the entry point; browser is the display.
2. **v1 data sources:** Claude Code session transcripts (`~/.claude/projects/*/<session>.jsonl`) including Agent-tool subagent files (`<session>/subagents/**/agent-*.jsonl`), and Workflow runs (`subagents/workflows/wf_*/journal.jsonl` + agent files). Feasibility verified against real data 2026-08-11: every line carries `uuid`/`parentUuid`/`timestamp`; subagents are separate per-agent files keyed by `agentId`; journals carry typed lifecycle events.
3. **Live tail:** file-watching only (no hooks, no proxy). Open a running session and watch nodes appear.
4. **Agent-first:** every capability available to agents via non-interactive CLI with JSON output; the human SPA and the agent CLI consume the same core.
5. **Vendor-agnostic core:** the IR and everything downstream contain zero Claude-isms. Claude Code support is an adapter; Codex is the designed-for second adapter (v1.1).
6. **Privacy:** all local. Server binds `127.0.0.1` only. Nothing leaves the machine. Stated prominently in README.

## Architecture

One npm package (`rungraph`), MIT license, Node ≥ 20. Six units:

1. **CLI** (`bin`) — subcommands, all non-interactive, all offering `--json`:
   - `npx rungraph` — human default: scan, serve, open browser.
   - `rungraph list --json` — run index (projects → sessions/workflow runs) on stdout.
   - `rungraph graph <runId> --json` — the Graph IR on stdout. Agents can read their own past runs without the browser.
   - `rungraph serve --no-open [--port N] [--project <path>]` — start server, print `{"url": ...}` on stdout.
   - Discipline: no interactive prompts anywhere; data on stdout, logs on stderr; meaningful exit codes (0 ok, 1 error, 2 no runs found).
2. **Scanner** — asks each registered adapter to `detect()` runs; builds a lightweight index (id, mtime, size, title from `aiTitle`/`slug`) via stat + first/last-line reads only. No full parsing at index time.
3. **Adapters** (`adapters/claude-code/` in v1) — implement `detect(rootDirs) → RunRef[]` and `parse(RunRef) → IR`. Pure: no server imports; filesystem access limited to reading the run's own files. All format knowledge lives here. `adapters/codex/` (rollout logs at `~/.codex/sessions/**/rollout-*.jsonl`) is v1.1 and pressure-tests the interface.
4. **Server** — thin HTTP layer on `127.0.0.1`:
   - `GET /api/index` — picker data
   - `GET /api/graph/:runId` — parse on demand, return IR JSON
   - `GET /api/detail/:nodeId` — lazy transcript slice for the inspector
   - `GET /api/watch/:runId` — SSE stream of IR deltas
   - Serves the prebuilt SPA. Port conflicts auto-increment; actual URL always printed.
   - Endpoints map 1:1 onto future MCP tools (`list_runs`, `get_graph`, `get_detail`, `open_visualization`) so `rungraph mcp` in v1.1 is a wrapper, not a rework.
5. **Frontend SPA** — prebuilt at publish time, shipped in the package; user never runs a build. Stack: Preact + elkjs auto-layout + SVG. No heavy chart libraries.
6. **Watcher** — `fs.watch` on the open run's files; appended lines incrementally parsed; IR deltas pushed over SSE. This is the entire live-tail feature.

**Data flow:** CLI → Scanner index → user (or agent) picks a run → Server invokes Adapter → IR JSON → Frontend lays out and renders → click for lazy detail → Watcher pushes deltas while a run is active.

## Graph IR

The single contract consumed by SPA, `--json`, and future MCP. Versioned (`irVersion: 1`), documented in `SCHEMA.md`, vendor-neutral (provider-specific extras only in a namespaced `ext` object per node/edge).

**Shape:** `{ meta, nodes[], edges[], groups[] }`
- `meta`: runId, adapter, kind (`session` | `workflow`), title, startedAt, endedAt, totals (tokens, toolCalls, agents), unrecognizedLineCount.
- **Node kinds (5):**
  - `turn` — one user→assistant exchange in the main session; labeled by prompt snippet; the top-level backbone.
  - `agent` — any spawned agent (subagent or workflow agent): agentId, label, model, status, tokens, duration.
  - `tool` — grouped tool activity: consecutive same-tool calls collapse to one node ("Bash ×7"); individual calls live in the inspector. Anti-hairball rule.
  - `workflow` — a workflow run as one node, drilling into its own subgraph (phases as groups, agents inside).
  - `human` — user interventions: question answers and permission denials (course-change moments).
- **Edge kinds (3):** `sequence` (parentUuid chain within a lane), `spawn` (parent → child, labeled with the child's prompt), `return` (child → parent, carrying result summary). Optional `reason` field when derivable (tool error before a retry, denial before a new approach, phase transition) — this field is the decision-lineage feature.
- Node status: `completed` | `error` | `running`. Metrics: tokens + duration only (no cost estimates in v1 — pricing tables are a maintenance treadmill).
- **Level of detail:** default canvas = turns + agents + grouped tools. Full transcripts and individual tool calls are inspector-only, fetched lazily.

## Frontend UX

- **Three panes:** left = run picker (newest first, active runs badged "● live"); center = graph canvas; right = inspector (slides open on node/edge click).
- **Canvas:** time flows top-to-bottom; parallel agents fan out into side-by-side lanes; elkjs layout, SVG, pan/zoom/fit. Status color-coded; running nodes pulse.
- **Inspector:** agent node → prompt given, result, tokens, duration, lazy transcript. Tool group → individual calls. Edge → reason.
- **Live tail:** auto-follow on open (new nodes slide in); single pause-follow toggle.
- **Theme:** dark-first (terminal-native audience). Implementation uses frontend-design skills — the screenshot must be memorable, not generic.
- **Deliberate v1 cuts:** no search, no run comparison, no filtering (all v1.1).

## Error handling

- **Prime directive: never blank-screen.** Unknown line types/fields are skipped and counted; graph renders with a non-blocking banner ("N lines unrecognized — transcript format may be newer than this version"). Format drift is the expected steady state, not an exception.
- Truncated/malformed JSONL lines (normal mid-write during live tail): tolerated, retried next tick.
- Referenced-but-missing agent transcript → placeholder node marked "transcript unavailable."
- Multi-MB files: stream-parsed; lazy inspector keeps payloads small.
- Port in use → auto-increment; browser-open failure → URL printed anyway.

## Testing

- **Parser/adapters get the investment:** fixture-driven TDD. Sanitized real transcripts (Fayzan's disk holds 25 workflow runs + 398 agent files) checked into `tests/fixtures/`; IR output snapshot-tested.
- Golden end-to-end: CLI against fixture dir, assert API responses.
- Frontend: manual + demo for v1 (budget goes to parser robustness).
- CI: GitHub Actions, Node 20+.

## Packaging & launch

- npm `rungraph` (availability verified 2026-08-11: npm free; GitHub exact-name repos ≤1★). GitHub: `fayzan123/rungraph`.
- README order: demo GIF → 10-second human quickstart → **"For agents" section** (install → list → graph → serve with expected outputs, written to be pasted into a prompt) → privacy statement → SCHEMA.md link.
- `--help` text descriptive enough for an agent to self-serve every command.
- Launch: Show HN + r/ClaudeAI, riding the "agentic graphs" vocabulary; two GIFs as above.

## v1.1 roadmap (explicitly out of v1 scope)

Codex adapter → validates adapter interface; `rungraph mcp` (thin wrapper over existing API); search/filter; run comparison; additional adapters (Gemini CLI, Cursor) as demand shows.

## Context

Validated 2026-08-11 via brutal-product-analysis: conditional BUILD, 6.5/10. Niche evidence: claude-tap 3,017★/6mo, claude-code-history-viewer 2,032★, agent-flow 1,480★/4mo. Differentiation conditions: post-hoc zero-setup reconstruction (agent-flow cannot — hook-based) and decision lineage. Known risks: agent-flow overlap, Anthropic shipping native visualization (hedged by vendor-agnostic core), niche riding Claude Code's hype cycle.
