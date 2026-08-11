# rungraph — project instructions

Zero-setup, agent-first visualizer for AI coding-agent runs: `npx rungraph` reconstructs Claude Code sessions + Workflow runs from `~/.claude/projects` native transcripts (post-hoc, no hooks) into an interactive directed agentic graph, with live tail via file watching.

## Current state & next step

- **Spec is approved and committed:** `docs/superpowers/specs/2026-08-11-rungraph-design.md`. Read it before any work — it is the source of truth for scope and architecture.
- **No implementation exists yet.** Next step: invoke the `superpowers:writing-plans` skill against the spec to produce the implementation plan, then implement via TDD.

## Non-negotiable constraints (from the approved spec)

- **Agent-first CLI:** every subcommand non-interactive with `--json`; data on stdout, logs on stderr; exit codes 0/1/2; no prompts anywhere. Agents must be able to operate the whole tool via Bash.
- **Vendor-neutral IR:** no Claude-specific names or fields outside `adapters/claude-code/`. Provider extras go in a namespaced `ext` bag. Everything downstream consumes only the IR (`irVersion: 1`, documented in SCHEMA.md).
- **Parser purity:** adapters take lines in, return IR out — no server imports, no I/O beyond reading the run's own files. All format knowledge lives in adapters.
- **Never blank-screen:** unknown lines are skipped + counted, surfaced as a banner, never a crash. Truncated JSONL lines (live tail mid-write) are tolerated.
- **Privacy:** server binds `127.0.0.1` only; nothing leaves the machine.
- **v1 scope is cut hard:** no search, no run comparison, no filtering, no cost estimates, no MCP (v1.1: Codex adapter, `rungraph mcp`). Ship-fast is the binding constraint (~2 weeks side-channel).

## Testing

Fixture-driven TDD on the parser/adapters: sanitized real transcripts in `tests/fixtures/`, snapshot-tested IR. Frontend is manual+demo for v1. CI: GitHub Actions, Node ≥ 20.

## Stack

Single npm package `rungraph` (name verified available 2026-08-11). Node ≥ 20, MIT. Frontend: Preact + elkjs + SVG, prebuilt at publish time and shipped in the package — users never build.
