# Contributing to rungraph

Thanks for wanting to help. rungraph is small on purpose and opinionated on
purpose — this document tells you where the walls are before you spend an
evening building against one.

## Getting started

```bash
git clone https://github.com/fayzan123/rungraph.git
cd rungraph
npm ci
npm test              # full suite, ~10s
npm run dev           # rebuild the frontend on change (backend needs no build)
node bin/rungraph.js  # run your checkout against your own sessions
```

Node ≥ 20. The backend runs straight from `src/` — only the frontend builds
(esbuild, prebuilt at publish so users never do this).

## Map of the repo

| path | what |
|---|---|
| `src/cli.js` | every subcommand; `bin/rungraph.js` is a shim over it |
| `src/scanner.js` | finds runs on disk, dispatches to adapters |
| `src/adapters/claude-code/`, `src/adapters/codex/` | ALL format knowledge, one dir per vendor |
| `src/server.js` | localhost HTTP + SSE; serves the dashboard and bundles |
| `src/watcher.js` | live tail — file watching, graph diffing |
| `src/signals.js` | derived signals (retry storms, dead ends…) — server-side only |
| `src/mcp.js` | the MCP server (hand-rolled JSON-RPC over stdio) |
| `src/bundle.js`, `src/secrets.js` | `.rungraph` export/open + the blocking secrets scan |
| `src/registry.js` | how concurrent servers find each other |
| `src/find.js`, `src/deeplink.js` | **import-free** modules shared verbatim with the browser bundle |
| `frontend/src/` | the Preact dashboard |
| `tests/` | fixture-driven suite; `tests/fixtures/generate.mjs` writes the corpus |

The *why* behind the design lives in `CLAUDE.md` (the project's standing
constraints), in unusually thorough commit messages, and in the module-top
comments — read the ones for the area you're touching before you start. PRs
that re-litigate a decided trade-off without new evidence will be asked for
the evidence.

## The non-negotiables

These are load-bearing. A PR that breaks one will be declined regardless of
how good the feature is, so check the list first:

1. **Zero runtime dependencies.** `package.json` has devDependencies only, and
   `npx rungraph` being instant depends on it. If a feature needs a package,
   the feature gets redesigned. (This is why `src/mcp.js` hand-rolls JSON-RPC.)
2. **Vendor-neutral IR.** No vendor-specific names, fields, or assumptions
   outside that vendor's `src/adapters/<name>/` directory. Provider extras go
   in the namespaced `ext` bag. Everything downstream — server, CLI, MCP,
   frontend, bundles — consumes only the IR (`SCHEMA.md`).
3. **Parser purity.** Adapters take lines in and return IR out. No server
   imports, no network, no I/O beyond reading the run's own files.
4. **Never blank-screen.** Unknown lines are skipped and counted, surfaced as
   a banner — never a crash. Truncated final lines (live tail mid-write) are
   tolerated. Format drift must degrade, not break.
5. **Privacy.** The server binds `127.0.0.1` only and makes zero outbound
   requests. `POST /api/focus` stays the only write endpoint. Nothing leaves
   the machine except through `rungraph export`, which inventories and
   secret-scans everything it writes.
6. **Import-free shared modules.** `src/find.js` and `src/deeplink.js` have
   *no imports at all* — the frontend bundle includes them directly. A single
   `node:` import breaks the browser build; tests guard this, but don't fight
   the guard.
7. **One implementation per opinion.** Signals derive server-side at every
   IR hand-off point, never in the frontend; the matcher, the deep-link codec,
   and the focus spine each exist exactly once. A second copy that could
   disagree with the first is a bug even while it agrees.

## Signals and thresholds: measured, not reasoned

The signal layer is governed by **precision over recall** — one false marker
and users stop trusting all of them. Consequences:

- Values in `THRESHOLDS` are calibrated against real session corpora. A PR
  that changes one, or adds a signal, needs measurement (how many runs of a
  real corpus fire, and were they right?), not an argument that it "should"
  fire.
- The clean-run fixture (session `3333…`) must keep deriving **zero** signals.
  That test is the trust budget.

## Testing

The suite is fixture-driven: synthetic, format-faithful transcripts in
`tests/fixtures/`, snapshot-tested IR.

```bash
npm test                            # everything
npx vitest run tests/codex.test.js  # one file
npx vitest run -u                   # update snapshots after an intended change
node tests/fixtures/generate.mjs    # regenerate fixtures after editing the generator
```

Things that will bite you:

- **Never edit fixture `.jsonl` by hand** — edit `tests/fixtures/generate.mjs`
  and regenerate. Snapshots embed file sizes, so even a one-byte change shows.
- **Scan-root env vars.** `RUNGRAPH_CLAUDE_PROJECTS` and
  `RUNGRAPH_CODEX_SESSIONS` override the scan roots, and the **empty string
  disables that adapter's scan**. Any test that scans must set *both*, or it
  wanders into the developer's real transcript corpus.
- **Fake secrets in fixtures must be visibly fake and must not match real
  providers' detectors.** GitHub push protection scans pushes: a Slack-shaped
  fake with a numeric workspace id will block the entire push (the generator
  has a comment where this bit us). Use `FAKE`/zeros, keep rungraph's own
  patterns matching, and keep GitHub's happy.

## Writing an adapter

The most valuable contribution there is. An adapter is a directory under
`src/adapters/<name>/` exporting `name`, `detect`, `parse`, `fingerprint`,
`watchTargets`, and `matchesProject` — see `src/adapters/codex/` for the
current best example of the shape.

Ground rules, learned the hard way:

- Build against a **real corpus** of that tool's transcripts, not the docs.
  Both existing adapters found undocumented format generations, duplicated
  streams, and lying timestamps only a corpus reveals.
- Unknown line types: skip and count (rule 4). Your parser will meet newer
  files than you've seen.
- Pair tool calls to outputs by id, never by adjacency — parallel calls are
  real.
- Fixtures go through `generate.mjs` like everyone else's, including a clean
  run for the zero-signals gate.

## Pull requests

- Small and focused beats large and complete. An issue first for anything
  design-shaped saves everyone time.
- Tests come with the change — this project is test-first, and behavior
  without a test doesn't stick.
- Match the commit style you see in `git log`: `feat: …`, `fix: …`,
  `docs: …`, lowercase, imperative.
- If behavior changes, the docs change in the same PR: `README.md` for the
  pitch, `docs/GUIDE.md` for the walkthrough, `SCHEMA.md` for anything the IR
  or HTTP surface does. IR changes should be additive (consumers tolerate
  absent fields); anything else means an `irVersion` conversation first.
- CI (Node 20 and 22) must be green.

## Reporting bugs

Include your rungraph version, Node version, and OS. For parse problems, the
gold standard attachment is a **structure-only bundle** of the affected run:

```bash
rungraph export <runId> --structure-only
```

That keeps graph shape, tool names, files, and timings — and strips every
prompt and output — so you can attach it without sharing your work. Please
don't paste raw transcript files into issues; they contain everything you and
your agent said.

Security issues: see [SECURITY.md](SECURITY.md) — please don't open a public
issue.
