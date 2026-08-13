# X/Twitter launch thread draft

> Post as a thread; tweet 1 carries the GIF (attach docs/rungraph-demo.gif).

**1/**
Your coding agent already wrote down everything it did.

`npx rungraph` turns those transcripts into an interactive graph — every
session you've EVER run, retroactively. No hooks, no setup, no telemetry.

[attach rungraph-demo.gif]

**2/**
Agent sessions aren't conversations anymore. They're runs: an orchestrator
spawning subagents, workflows fanning out reviewers, tools failing and
retrying, you denying a permission that changes everything downstream.

rungraph draws that — spawns, returns, and the human course-changes.

**3/**
The bit I like most: click any tool node and you get the *why* — the
assistant's narration right before the call — next to the full inputs and
outputs. "Bash · npm test ×12" instead of "Bash". Runs become legible.

**4/**
It's local-only (binds 127.0.0.1, zero outbound requests) and agent-first:
every command has --json. An agent can read its own past runs — what it
spawned, what failed, where you said no.

**5/**
Live runs tail via file watching — the graph grows while the agent works.

The demo GIF is rungraph watching the live session that implemented its own
frontend. It ships what it shipped with.

MIT, Node ≥ 20:
https://github.com/fayzan123/rungraph

## Notes for you (not part of the thread)

- Tweet 1 must stand alone — most people won't expand the thread.
- If you'd rather post a single tweet, use 1/ with the repo link appended.
