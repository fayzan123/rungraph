# rungraph

**See your agent runs as a graph.**

`rungraph` is a zero-setup visualizer for AI coding-agent runs. One command reconstructs the sessions already on your disk — no hooks, no instrumentation, works retroactively on every session you've ever run — and renders them as an interactive directed agentic graph: orchestrator, subagents, and tools as nodes; spawn/return relationships as edges; decision lineage (why the run moved the way it did) on the edges.

```
npx rungraph
```

> 🚧 **Status: pre-release.** v1 is in active development. The approved design spec lives at
> [`docs/superpowers/specs/2026-08-11-rungraph-design.md`](docs/superpowers/specs/2026-08-11-rungraph-design.md).

## What v1 will do

- **Post-hoc reconstruction** of Claude Code sessions and Workflow runs from native transcripts (`~/.claude/projects`) — zero setup, retroactive.
- **Interactive graph UI** — time flows down, parallel agents fan out into lanes, click any node for the prompt/result/transcript behind it.
- **Live tail** — open a running session and watch the graph grow, via file watching only.
- **Agent-first CLI** — every capability is scriptable: `rungraph list --json`, `rungraph graph <runId> --json` (the full graph IR on stdout, so your agent can inspect its own past runs), `rungraph serve --no-open`. No interactive prompts anywhere.
- **Vendor-neutral core** — Claude Code is the first adapter; Codex is next. The graph IR contains no vendor-isms.

## Privacy

Everything is local. The server binds `127.0.0.1` only. Nothing ever leaves your machine.

## License

[MIT](LICENSE)
