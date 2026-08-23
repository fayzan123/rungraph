# Where the adapter count lives

rungraph ships **five** adapters (claude-code, codex, hermes, opencode, cursor)
and **five** MCP clients, one per adapter. That number — and the lists and
env-var sets that go with it — is written down in prose in the places below.
The code itself never hard-codes it (`ADAPTERS` and `CLIENTS` are arrays, and
`tests/clients.test.js` fails CI if they disagree), but prose does not fail
CI, and it went stale twice while the fourth and fifth adapters landed.

**When the sixth adapter lands, walk this list top to bottom.** Each entry
says what the line is, what it currently says, and what kind of edit it
needs. Then add the new adapter's own lines to this file.

Last walked: 2026-08-23, on the Cursor adapter (v0.6.0).

## Tier 1 — user-facing (must change)

| File | What it says | Edit |
|---|---|---|
| `README.md` ~L27 | "It scans `~/.claude/projects`, … and Cursor's two stores — Claude Code, Codex, Hermes Agent, opencode and Cursor runs" | add the store path and the name |
| `README.md` ~L31 | "(Hermes, opencode and Cursor runs need Node ≥ 22.13 …)" | add the name if the new adapter reads SQLite |
| `README.md` ~L130 | "**rungraph ships five adapters, so it installs into five agents.**" + the list + the sample `--install` output block | count ×2, list, one line in the block |
| `README.md` ~L145 | "`--client all` installs into all five regardless" | count |
| `README.md` ~L162 | "For the five above, `--install --client <name>` does the registration" | count |
| `README.md` ~L180 | "(If your agent's Hermes/opencode/Cursor runs are missing, your default Node is older than 22.13 …)" | add the name if SQLite |
| `README.md` ~L300 | the rail chips "(`all · claude · codex · hermes · opencode · cursor`)" and the loose-runs examples | add the chip |
| `README.md` ~L308 | "Copy the exact `claude --resume` / … / `cursor-agent --resume` command" | add the resume spelling, if the adapter resumes |
| `README.md` ~L357 | "vendor-neutral, with five adapters: Claude Code (…), Codex CLI (…), Hermes Agent (…), opencode (…), and Cursor — …" | count + a parenthetical for the new one, including its env var |
| `README.md` ~L372 | "**What the Cursor adapter does not do**" | each adapter with real gaps gets its own such paragraph |
| `README.md` ~L393 | "How it works" — "Claude Code writes JSONL … Cursor is read the same way, from two stores …" | a sentence on where the new adapter reads from |
| `README.md` ~L430 | CLI help excerpt: "`--client <c>  mcp --install: claude \| codex \| hermes \| opencode \| cursor \| all`" | mirror `src/cli.js` |
| `docs/GUIDE.md` ~L23 | "It scans … and Cursor's two stores … Requires Node ≥ 20 (Hermes, opencode and Cursor runs need ≥ 22.13 …; `RUNGRAPH_HERMES_HOME`, `RUNGRAPH_OPENCODE_HOME`, `RUNGRAPH_CURSOR_GLOBAL_STORAGE` and `RUNGRAPH_CURSOR_CLI_HOME` point the scan elsewhere …)" | store path, SQLite note, env var |
| `docs/GUIDE.md` ~L33 | "rungraph reads the JSONL transcripts Claude Code and Codex already write — and Hermes Agent's, opencode's and Cursor's SQLite databases" | add the name |
| `docs/GUIDE.md` ~L180 | "rungraph ships five adapters and installs into five agents — Claude Code, Codex, Hermes, opencode and Cursor." + the sample output block + the Cursor paste paragraph | count ×2, list, block line |
| `docs/GUIDE.md` ~L200 | "`--client all` installs into all five regardless" | count |
| `docs/GUIDE.md` ~L249 | "the dashboard's own copy button says the same, and means any of the five" | count |
| `docs/GUIDE.md` ~L304 | troubleshooting row: "codex, Hermes and opencode overwrite on a re-add" | add the name only if the new client is delegate-tier and overwrites |
| `docs/GUIDE.md` ~L363 | "Claude Code, Codex CLI, Hermes Agent, opencode and Cursor are the five adapters today" + the "what it does not do" sentence | count + list |
| `site/index.html` ~L239 | fineprint: "with five adapters today: Claude Code, Codex CLI, Hermes Agent, opencode and Cursor" | count + list |
| `site/index.html` ~L294 | FAQ "which agents": "Five, each from wherever it already writes: … One scan picks up all five. … The three SQLite readers need Node ≥ 22.13" | count ×2, a `<b>name</b> (<code>path</code>)` entry, SQLite count |
| `site/index.html` ~L316 | "A Codex run, a Hermes run and a Cursor run behave exactly like a Claude Code one" | optional — add if the new name reads naturally |
| `site/index.html` ~L323 | "Hermes, opencode and Cursor runs need Node ≥ 22.13" | add the name if SQLite |
| `site/index.html` ~L334 | "Claude Code Workflow runs, Codex subagent rollouts, Hermes delegation lanes, Cursor's IDE and CLI surfaces … not one thing wearing five labels" | the structure name + count |
| `site/index.html` ~L348 | "All five agents write a full transcript as they work — Claude Code and Codex as JSONL; Hermes, opencode and Cursor into SQLite" | count + format group |
| `site/index.html` ~L436 | "Node ≥ 20. That's it — Hermes, opencode and Cursor runs want ≥ 22.13" | add the name if SQLite |
| `site/index.html` ~L524 | "the Hermes, opencode and Cursor databases are opened strictly readonly" | add the name if SQLite |
| `site/index.html` ~L707 | "registers with every agent whose runs are already on this machine — Claude Code, Codex, Hermes, opencode and Cursor — by driving each vendor's own CLI … (Cursor's CLI has no `mcp add` …)" | list; a parenthetical if the new client is paste-tier |
| `site/index.html` ~L717 | "installs into all five regardless of what was detected" | count |
| `src/cli.js` ~L31 | `--help`: "mcp --install (… with claude, codex, hermes, opencode and cursor)" | list |
| `src/cli.js` ~L42 | `--help`: "--client <c>  mcp --install: claude \| codex \| hermes \| opencode \| cursor \| all" | list — and the two tests that assert this exact string: `tests/cli.test.js` and `tests/opencode.test.js` ("--help names all five") |
| `package.json` `description` | "…the transcripts Claude Code, Codex, Hermes, opencode, and Cursor already write" | list |
| `package.json` `keywords` | `"cursor"` | add a keyword for the new agent |

## Tier 2 — project docs and comments (should change)

| File | What it says | Edit |
|---|---|---|
| `CLAUDE.md` ~L25 | "**Five adapters ship, and five clients:** claude-code, codex, hermes, opencode, cursor. The last three read SQLite …" + a paragraph on the new adapter's shape | count ×2, list, SQLite count, paragraph |
| `CLAUDE.md` ~L41 | "opencode and Cursor close the same loop (both speak MCP); Codex and Hermes structurally cannot" | add the name to whichever half applies |
| `CLAUDE.md` ~L123 | `src/clients.js` bullet: "`tests/clients.test.js` fails CI if an adapter has no entry, so a fifth adapter cannot land without deciding how that provider installs" | ordinal |
| `CLAUDE.md` ~L162 | "over all five adapters' corpora" (cross-adapter invariant) | count |
| `CLAUDE.md` ~L166 | the Cursor corpus paragraph | each adapter's corpus gets its own paragraph |
| `CLAUDE.md` ~L186 | calibration record | each adapter's calibration gets its own sentences |
| `CONTRIBUTING.md` ~L27 | file table: the list of `src/adapters/*/` dirs; "shared by the three SQLite adapters" | add the dir; SQLite count |
| `CONTRIBUTING.md` ~L117 | "Scan-root env vars … `RUNGRAPH_CURSOR_GLOBAL_STORAGE` and `RUNGRAPH_CURSOR_CLI_HOME` … Any test that scans must set *all six*" | add the env var(s), count |
| `CONTRIBUTING.md` ~L145 | the bullet pointing at this file | — |
| `SCHEMA.md` ~L42 | coverage `records` unit: "… walked rows for `hermes` and `opencode`, and for `cursor` conversation headers walked (IDE) or root snapshot entries walked (CLI)" | add the new adapter's unit |
| `SCHEMA.md` ~L110 | the `meta.ext.<adapter>` bags: one bullet per adapter, and the `<adapter>` key list "(`claudeCode`, `codex`, `hermes`, `opencode`, `cursor`)" | add the bag and the key |
| `SCHEMA.md` ~L496 | "`--client claude\|codex\|hermes\|opencode\|cursor\|all` targets one, or all five" | list + count |
| `src/clients.js` ~L18 | module docblock: "rungraph ships five adapters; it should ship five clients … the Cursor entry was added under exactly that guard" | count ×2 |
| `src/clients.js` ~L30 | "Every vendor behaviour encoded below was PROBED … Versions: claude …, cursor-agent 2026.08.11 / Cursor 3.16.29" | add the probed version |
| `src/clients.js` ~L192 | `runVendor` comment: "THREE of the five vendor commands rungraph runs boot rungraph's own MCP server" | count of commands; the "three" only if the new vendor's list/add health-checks |
| `src/mcp.js` ~L868 | `installMcp` docblock: "rungraph ships five adapters, so it installs into five clients … `--client all` targets all five … five config formats … Four of the five are drivable non-interactively" | count ×4; the delegate/paste split |
| `src/mcp.js` ~L1116 | "Three of the four DELEGATE vendors REPLACE the entry on a re-add" | only if the new client is delegate-tier |
| `frontend/src/inspector.jsx` ~L260 | `AskYourAgent` docblock: "rungraph installs into five agents" | count |
| `tests/clients.test.js` ~L42 | isolation contract: "The five adapters' roots (six env vars — Cursor has two)" | count, env-var count |
| `tests/clients.test.js` ~L117 | "rungraph ships five adapters and should ship five clients … Whoever lands a sixth adapter cannot land it without deciding how that provider installs" | counts, ordinal |
| `tests/clients.test.js` ~L195 | "on any of the five" + the `rungraph-dev` precision case per client | count; add an `expect(clientByName('<new>')…)` line |
| `tests/clients.test.js` ~L478 | "three of the five boot rungraph's own server" | count of vendor CLIs |
| `tests/clients.test.js` ~L782 | "where none of the five vendor CLIs exist" | count |
| `tests/mcp.test.js` ~L595, ~L637 | "the four delegate-vendor integration cases" / "every one of the four delegate vendors" | count of delegate-tier clients |
| `tests/opencode.test.js` ~L952 | cross-adapter invariant: "in all five adapters" + the `corpora` array | count; add the new adapter's fixture root(s) |
| `tests/opencode.test.js` ~L1115 | "--help names all five" + the exact `--client` string | count + string |
| `tests/helpers.js` ~L95 | the `FIXTURE_RUN_COUNT` comment: "the cross-cutting suites disable all THREE SQLite adapters (… and both Cursor roots)" | SQLite count, env vars |
| `tests/picker.test.js` ~L203 | `expect(ADAPTERS.length).toBeGreaterThan(3)` | a floor, not a count — leave unless it should rise |
| `frontend/src/styles.css` ~L39 | the adapter accent variables (`--cursor`, `--cursor-dim`) and the four `[data-adapter="cursor"]` rules | `tests/picker.test.js` fails CI without an accent at all four identity points, ≥30° of hue from every other accent |

## Tier 3 — historical, leave alone

These say "three" or "four" about a moment in the past and are correct as written.

| File | What it says |
|---|---|
| `src/coverage.js` ~L28 | "Calibrated against the 2026-08-19 corpus measurement: 224 runs … across three adapters" |
| `tests/opencode.test.js` ~L946 | "Three adapters implemented this rule in three independent copies and asserted it NOWHERE; a fourth … made the risk concrete" |
| `CLAUDE.md` ~L162 | "it previously existed as four independent copies" |
| `src/clients.js` opencode entry | "opencode delegates like the other three" |
| `tests/fixtures/generate.mjs` ~L2339, ~L2792 | fixture *content* ("`src/adapters` has four adapters", "three adapters") — the transcript text of a synthetic Cursor run; changing it changes snapshots for nothing |
| git history | "Merge branch 'mcp-install-loop': four adapters, four clients" |

## Not counts — grep false positives

Lines that say "four" or "five" and have nothing to do with adapters, so a
future grep does not send you editing them: the four outcome encodings
(`outcome.js`, `tests/cursor.test.js`), the four identity points of the rail
accent (`tests/picker.test.js`), the four `deriveSignals` call sites
(`tests/cli.test.js`, `tests/site.test.js`), the four focus × revert
combinations (`focus.js`, `tests/opencode.test.js`), the four
`rootUnreadable` reasons (`SCHEMA.md`), the five outgoing places a secret can
live (`CLAUDE.md`, `generate.mjs`, `tests/cursor.test.js`), the five signals
(`site/index.html` `aria-label`), and opencode's five `tokens_*` columns.

## Checklist for the sixth

1. Write the adapter; `tests/clients.test.js` will refuse to pass until
   `src/clients.js` has its entry.
2. Add its scan root(s) to `defaultRootDirs()` in `src/scanner.js`, and set
   the new env var to `''` in every cross-cutting suite (grep
   `RUNGRAPH_OPENCODE_HOME` in `tests/` for the list).
3. Add its accent to `frontend/src/styles.css`.
4. Walk Tier 1, then Tier 2, in this file.
5. Add this adapter's own lines (its store path sentence, its "does not do"
   paragraph, its corpus and calibration paragraphs) as new rows above.
6. Update "Last walked" at the top.
