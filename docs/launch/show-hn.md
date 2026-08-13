# Show HN draft

> Drafts for you to review and post yourself. This folder is deliberately
> untracked — nothing here goes to GitHub unless you commit it.

## Title

Show HN: Rungraph – See your AI coding-agent runs as a graph

*(HN cuts titles at 80 chars; this is 58. Don't use "🚀" or marketing words —
this phrasing matches HN norms.)*

## URL

https://github.com/fayzan123/rungraph

## First comment (post immediately after submitting)

I built this because my Claude Code sessions stopped being conversations and
started being *runs*: an orchestrator spawning subagents, workflows fanning
out review agents, tools failing and retrying, me occasionally denying a
permission and changing the course of everything downstream. The transcript
of all that already exists on disk — Claude Code writes JSONL under
~/.claude/projects — but nobody can read a 4,000-line JSONL file.

rungraph parses those transcripts post-hoc and draws the run as a directed
graph: turns, tool groups, subagents, and workflow runs as nodes; spawn/return
edges between them; human interventions (denials, question answers,
interrupts) as first-class nodes, because those are the moments a run changes
direction. `npx rungraph` and every session you've ever run is already there —
no hooks, no wrappers, no telemetry, nothing to install into your agent.

Details HN might care about:

- Zero runtime dependencies on the backend (node:http, fs.watch,
  util.parseArgs). The frontend (Preact + elkjs) ships prebuilt in the
  package; nothing builds on your machine.
- Live runs tail via file watching + SSE — the graph grows while the agent
  works. The demo GIF in the README is rungraph watching the live session
  that implemented its own frontend, which was a fun recursion.
- Everything is local: the server binds 127.0.0.1 only and makes zero
  outbound requests.
- It's agent-first: every subcommand has --json, data on stdout, logs on
  stderr, exit codes 0/1/2. An agent can read its *own* past runs — what it
  spawned, what failed, where the human said no. There's a "For agents"
  section in the README meant to be pasted into a prompt.
- The graph is a versioned, vendor-neutral IR (SCHEMA.md). Claude Code is
  the first adapter; a Codex adapter is next. Unknown transcript lines are
  counted and surfaced as a banner, never a crash, so format drift degrades
  gracefully.
- Tool nodes get descriptive labels ("Bash · npm test ×12", not "Bash"), and
  clicking one shows the assistant's narration from just before the call —
  the "why" — next to the full inputs/outputs.

Things it deliberately doesn't do (v1): search, run comparison, cost
estimates. Happy to answer anything about the transcript format — I reverse-
engineered it against a 529-file corpus and it has some genuinely weird
corners.

## Notes for you (not part of the post)

- Best posting window: weekday morning US Eastern.
- Have the GIF-backed README live before posting (done — it is).
- Expect "what about OpenAI/Codex?" — answer: adapter interface exists,
  Codex adapter is the next milestone.
- Expect "why not OpenTelemetry?" — answer: no instrumentation to add; this
  reads what's already on disk, retroactively.
