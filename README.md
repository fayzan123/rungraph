# rungraph

**See your agent runs as a graph.**

![rungraph visualizing the live session that shipped it: open a run, walk nodes with the keyboard, read the "why" behind a tool call, jump via the minimap, fit the whole graph](https://raw.githubusercontent.com/fayzan123/rungraph/master/docs/rungraph-demo.gif)

*That's rungraph watching the live session that built this feature — the graph grows as the agent works.*

Your coding agent already wrote down everything it did. `rungraph` turns those
transcripts into an interactive **directed agentic graph** — orchestrator,
subagents, and tools as nodes; spawn/return relationships as edges; the
course-change moments (denials, answers, retries) marked on the path. It works
**retroactively on every session you've ever run**: no hooks, no wrappers, no
setup, no telemetry.

```
npx rungraph
```

That's the whole quickstart. It scans `~/.claude/projects`, starts a local
server, and opens your browser. Pick a run — including one that's **running
right now**: the graph grows live as the agent works (file watching only).

## What you see

Agent sessions stopped being conversations a while ago. They're *runs*: an
orchestrator spawning subagents, workflows fanning out reviewers, tools
failing and retrying, a human occasionally saying no. rungraph draws that
structure so a 4,000-line transcript becomes something you can actually read:

- **Time flows down.** Your prompts are the backbone; parallel agents fan out
  into side-by-side lanes and return to the turn that collected their result.
- **Tool nodes say what ran**, not just which tool: `Bash · npm test ×12`,
  `Edit · canvas.jsx`, `Grep · waitForURL`. Consecutive calls of the same
  tool collapse into one node so a test-fix loop doesn't become a hairball.
- **Click any node** for the full story: prompt and response for turns; every
  call's inputs, outputs, errors, and timing for tools; the complete
  transcript for subagents. Tool nodes also show the **why** — the agent's
  own narration from just before the call ("Now I'll rerun the tests to
  check…").
- **Human interventions are first-class nodes.** A denied permission, an
  answered question, a mid-turn interrupt — these are the moments a run
  changes direction, and the edges that follow them carry the reason
  (`after permission denial`, `retry after failure`, `after Bash error`).
- **Workflow runs** (multi-agent orchestrations) appear as single nodes you
  can drill into: their own graph, phase boxes and all, retries linked to the
  attempts they replaced.
- **Tokens, durations, and models** annotate nodes; whole-run totals in the
  header.

## Getting around

Navigation is Figma-style, built for the tall, skinny graphs real runs
produce:

| Input | Action |
|---|---|
| Two-finger scroll | Pan |
| Pinch / cmd+scroll | Zoom at the cursor |
| Click-drag | Pan |
| Click node / edge | Inspect it |
| Double-click node | Zoom to 100%, centered |
| `j` / `k` (or `↓` / `↑`) | Walk nodes in run order, inspector follows |
| `f` | Fit the whole graph |
| `Esc` | Deselect |

A **minimap** (bottom-right) shows the whole run as a strip with a draggable
viewport — errors glow as red beacons; click one to jump straight to the
failure. Runs open at readable zoom: finished runs at the first prompt, live
runs at the latest activity, with follow mode sliding the view as new nodes
stream in.

## For agents

Everything the UI can do, a coding agent can do over the CLI — no browser, no
prompts, JSON on stdout, logs on stderr, exit codes `0` ok / `1` error / `2` no
runs found. Paste this section into a prompt and an agent can self-serve:

```bash
npx rungraph list --json
# {"runs":[{"runId":"claude-code:…:5822df8b-…","kind":"session","title":"Fix flaky auth test",
#           "project":"/home/you/dev/app","modifiedAt":"2026-08-11T16:31:06.055Z","active":true,…},…]}

npx rungraph graph 'claude-code:…:5822df8b-…' --json
# The full Graph IR for that run on stdout:
# {"irVersion":1,"meta":{"runId":"…","kind":"session","title":"…","totals":{"tokens":184230,"toolCalls":57,"agents":4},…},
#  "nodes":[{"id":"…","kind":"agent","label":"Investigate flaky test","status":"completed","tokens":{…}},…],
#  "edges":[{"kind":"spawn","from":"…","to":"…","label":"Investigate why auth.spec.ts flakes"},…],
#  "groups":[…]}
# → an agent can read its own past runs: what it spawned, what failed, where the human said no.

npx rungraph serve --no-open
# {"url":"http://127.0.0.1:4321"}   (server stays in foreground; same data over HTTP + SSE live tail)
```

The IR is versioned and documented in [SCHEMA.md](SCHEMA.md). It is
vendor-neutral: Claude Code is the first adapter (sessions, subagents, and
Workflow runs); a Codex adapter is next.

## Privacy

Everything is local. The server binds `127.0.0.1` only. rungraph makes no
network requests, phones nothing home, and nothing ever leaves your machine.

## How it works

Claude Code writes JSONL transcripts under `~/.claude/projects` — main session
files, per-subagent files, and workflow journals with a manifest per run.
`rungraph` reconstructs the run graph from those files post-hoc: adapters turn
transcript lines into a versioned, vendor-neutral IR, and everything
downstream (web UI, CLI, HTTP API) consumes only the IR.

It is built to survive real transcripts:

- **Never a blank screen.** Unknown line types are skipped and counted — if
  the transcript format is newer than your rungraph, you get a banner and a
  graph, not a crash. A half-written final line (an agent mid-write) is
  tolerated and retried on the next tick.
- **Live without hooks.** Liveness comes from watching the run's own files;
  the graph updates over SSE with stable node ids, so deltas merge instead of
  redrawing.
- **Light on your machine.** The backend has zero runtime dependencies
  (`node:http`, `fs.watch` and friends). The frontend (Preact + elkjs) ships
  prebuilt in the package — there is no build step on your machine.

## CLI reference

```
rungraph                     scan, serve, open browser (human default)
rungraph list [--json]       run index, newest first
rungraph graph <runId>       Graph IR for one run (JSON on stdout)
rungraph serve [--no-open]   start server; prints {"url": …}
  --project <path>           only runs for this project directory
  --port <n>                 preferred port (auto-increments if taken)
```

Requires Node ≥ 20.

## Roadmap

- **Codex adapter** — the IR and adapter interface are already vendor-neutral.
- **`rungraph mcp`** — the HTTP endpoints map 1:1 onto MCP tools
  (`list_runs`, `get_graph`, `get_detail`, `open_visualization`).
- **Search** — find a run or a node by text.
- **Run comparison** — diff two runs of the same task.
- **Cost estimates** — turn per-node token counts into dollars.

## License

[MIT](LICENSE)
