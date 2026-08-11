# rungraph

**See your agent runs as a graph.**

![rungraph visualizing the live session that shipped it: open a run, walk nodes with the keyboard, read the "why" behind a tool call, jump via the minimap, fit the whole graph](https://raw.githubusercontent.com/fayzan123/rungraph/master/docs/rungraph-demo.gif)

*That's rungraph watching the live session that built this feature — the graph grows as the agent works.*

Your coding agent already wrote down everything it did. `rungraph` turns those
transcripts into an interactive **directed agentic graph** — orchestrator,
subagents, and tools as nodes; spawn/return relationships as edges; the
course-change moments (denials, answers, retries) marked on the path. It works
**retroactively on every session you've ever run**: no hooks, no wrappers, no
setup.

```
npx rungraph
```

That's the whole quickstart. It scans `~/.claude/projects`, starts a local
server, and opens your browser. Pick a run — including one that's **running
right now**: the graph grows live as the agent works (file watching only).

- **Time flows down**, parallel agents fan out into lanes.
- **Click any node** for the prompt, result, tokens, duration, and transcript
  behind it.
- **Workflow runs** (multi-agent orchestrations) get their own drill-in graphs,
  phases and all.

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
files, per-subagent files, and workflow journals. `rungraph` reconstructs the
run graph from those files post-hoc and serves it to a small local SPA
(prebuilt and shipped in the package — there is no build step on your machine).
Unknown line types are skipped and counted, never fatal: if the transcript
format is newer than your rungraph, you get a banner and a graph, not a crash.

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

## License

[MIT](LICENSE)
