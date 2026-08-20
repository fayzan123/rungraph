# Using rungraph

Everything from a standing start: opening a run, reading what it tells you, and
wiring your own coding agent to it.

- [1. Start it](#1-start-it)
- [2. Read the graph](#2-read-the-graph)
- [3. What went wrong — the strip](#3-what-went-wrong--the-strip)
- [4. Focus](#4-focus)
- [5. Getting around](#5-getting-around)
- [6. Ask your agent](#6-ask-your-agent)
- [7. When something looks broken](#7-when-something-looks-broken)
- [8. Driving it from a script](#8-driving-it-from-a-script)

---

## 1. Start it

```bash
npx rungraph
```

That's the whole setup. It scans `~/.claude/projects`, `~/.codex/sessions`,
`~/.hermes` and `~/.local/share/opencode`, starts a server on
`127.0.0.1:4321`, and opens your browser. Requires Node ≥ 20 (Hermes and
opencode runs need ≥ 22.13 for the built-in SQLite reader — on older Nodes
they're skipped with a warning and everything else works;
`RUNGRAPH_HERMES_HOME` and `RUNGRAPH_OPENCODE_HOME` point the scan elsewhere,
and opencode's own `XDG_DATA_HOME` is honoured).

There is nothing to configure and nothing to instrument. rungraph reads the
JSONL transcripts Claude Code and Codex already write — and Hermes Agent's and
opencode's SQLite databases — so **every session still on your disk is already
there**, including ones from before you installed rungraph.
(Claude Code prunes old transcripts after its `cleanupPeriodDays` retention
setting, 30 days by default, so how far back "already there" reaches is that
setting's call, not rungraph's.)

Useful variants:

```bash
npx rungraph serve --no-open      # start the server, print the URL, don't open a browser
npx rungraph --port 5000          # different port (auto-increments if taken)
npx rungraph --project ~/dev/app  # only runs whose cwd is inside this path
```

Stop it with Ctrl-C.

---

## 2. Read the graph

Time flows **down**. Your prompts are the backbone; agents fan out into
side-by-side lanes and return to the turn that collected their result.

| node | is |
|---|---|
| **turn** | one prompt → response exchange |
| **tool** | grouped tool activity — consecutive calls of the same tool collapse into one node (`Bash · npm test ×12`) |
| **agent** | a subagent, with its own transcript inside |
| **workflow** | a multi-agent run; drill into its own graph |
| **human** | you: a denial, an answered question, an interrupt |

Click any node for the full story — every call's input, output, error and
timing; the complete transcript for a subagent; and for tools the **why**, which
is the agent's own narration from immediately before the call.

Edges carry a `⚑ reason` when the run's own lineage explains the move:
`after Bash error`, `after permission denial`, `retry after failure`.

---

## 3. What went wrong — the strip

A graph that renders everything with equal weight points at nothing. The strip
above the canvas is rungraph's opinion about the run.

| chip | means |
|---|---|
| ⟳ **retry storm** | the same tool kept failing in one place — `Edit` fails, agent reads the file, `Edit` fails again |
| ⚠ **unresolved error** | something failed and nothing ever came back to fix it |
| ✋ **intervention** | you denied a permission, interrupted a turn, or answered a question |
| ◆ **outlier** | a step that cost far more tokens or wall-clock than the rest of the run |
| ⚑ **course change** | the run's own recorded reason for changing direction |

**A clean run shows no strip at all.** That is deliberate, and it is the point:
the markers are only worth anything if you trust them, so they are tuned to stay
quiet. Across 60 real sessions the median run produces 2 signals and *zero*
high-severity ones; roughly a quarter produce none at all. If you see a chip, it
earned its place.

That claim is only worth something if rungraph actually read the run, so every
run also carries **coverage** — how many records it examined and how many it
could not interpret. The inspector shows it always (`records  1075 / 1075`,
plus the record types it did not understand when that number is short), and the
strip says `read 95% of this run` when something went unread on a run that
otherwise looks clean, louder when most of the run is missing. Transcript
formats are undocumented and unversioned: this is how "nothing went wrong" stays
distinguishable from "I could not see part of this". Your agent is handed the
same numbers and told to say so before calling a run clean.

Only `high` severity (retry storm, unresolved error, denial, interrupt) gets a
badge on the canvas. `outlier` never does — in a long session the biggest node
is usually just the biggest node — so it lives in the inspector list instead.

On a **live** run the strip re-derives as the run grows, and goes loud when
something *new* goes wrong. Walk away and it will pull you back at the moment
intervention is actually worth it.

---

## 4. Focus

Clicking a chip **focuses** those nodes: they light up with a ring, everything
else dims to a quarter. Nothing is ever hidden — hiding would collapse the
layout and destroy the mental map you just built.

Four things produce a focus, and they all behave the same way:

- **a signal chip** — click it (click again to clear)
- **find** (`/`) — plain substring over node labels *and the files each node
  touched*, so searching `token.js` finds the `Read` and `Edit` nodes whose
  labels don't contain that string. Filters in the browser; no round trip.
- **a file** — the inspector lists every file the run touched with a count;
  click one to see exactly which steps touched it
- **your agent** — see §6

`Esc`, or a click on empty canvas, clears it.

The files list includes work done **inside subagents**, which is where a lot of
real editing happens and which you cannot otherwise see without opening each
agent's transcript.

---

## 5. Getting around

| input | does |
|---|---|
| two-finger scroll / drag | pan |
| pinch, or cmd+scroll | zoom at the cursor |
| click node / edge | inspect it |
| double-click node | zoom to 100%, centred |
| `j` / `k` (or `↓` / `↑`) | walk nodes in run order |
| `f` | fit the whole graph |
| `/` | find |
| `[` / `]` | collapse the left / right pane |
| `Esc` | deselect and clear the focus |

The minimap (bottom-right) shows the whole run with errors as red beacons —
click one to jump straight to the failure.

**The run list groups by project.** With more than one agent's runs on the
machine, a chip rail above the list filters by agent (click a chip; click it
again — or `all` — to clear; the filter resets on reload), and runs whose
project isn't a real directory — deleted worktrees, home-directory chats,
`✦ Hermes tasks` — share one `✦ loose runs` group.

**Pane state is remembered per browser.** If a side looks missing, you collapsed
it earlier: press `[` or `]`.

---

## 6. Ask your agent

This is the half that makes rungraph a tool rather than a picture. The dashboard
is for you; the MCP server is for your agent; they are two ends of one loop.

### Set it up

```bash
npx rungraph mcp --install     # registers with Claude Code, user scope
# then restart Claude Code
npx rungraph mcp --check       # confirm it worked
```

For **opencode**, which speaks MCP and so closes the same loop:

```bash
npx rungraph mcp --install --client opencode
```

That one prints a config block to paste and **writes nothing** — opencode's own
`opencode mcp add` is an interactive wizard with no flags, and its config files
are JSONC, where a rewrite without a JSONC parser would eat your comments. It
also prints an `AGENTS.md` line that tells opencode to call `focus_nodes` after
it answers. `--client` is never guessed: a machine with both agents installed
has no right answer to sniff for.

`--check` is the honest answer to "is this working?":

```
✔ runs on disk             130 runs found
✔ mcp server               answers over stdio, 7 tools
✔ registered with claude   registered and connected
✔ dashboard server         serving on http://127.0.0.1:4321
```

Every failing line prints the one next step that fixes it.

> `--install` writes a status line to **stderr**, which some terminals paint
> red. That is not an error — check the exit code, or just run `--check`.

### Ask it something

You don't have to invent questions. Open a run and the bottom of the inspector
writes them for you, from **that run's own data**, with a copy button:

> *why did the Edit on `token.js` keep failing in this run?*
> *which steps touched `frontend/src/app.jsx` in this run?*
> *what did the "audit auth module" agent find?*

Paste one into Claude Code. What happens:

1. Claude calls `find_nodes` / `get_graph` / `get_detail` — which now carry the
   signals and the file attribution, so it reasons over facts rather than
   guessing from labels.
2. **It answers in your terminal** — your model, your session, fully
   inspectable. rungraph never runs a model and has no API key.
3. It calls `focus_nodes`, and your dashboard lights up the nodes it just
   described — switching to the right run, or opening a tab, if it needs to.

### What it can answer

- **triage** — *what failed? did anything never get fixed? where did I say no?*
- **file archaeology** — *which steps touched this file? what did this run change?*
- **structure** — *what did it spawn, and what came back?*
- **cost** — *what took longest? which agent was most expensive?*
- **verbatim** — *what was the actual error message?* *what prompt did that subagent get?*
- **self-audit** — *did it actually run the tests, or just say it did?*

### What it can't

- **What the agent is about to do, or why it is stuck right now.** Transcripts
  are written after the fact. "Blocked on a permission prompt this second" is
  not observable, and is not faked.
- **Whether the work was correct.** It knows the edit landed, not that it was right.
- **File contents or diffs**, beyond what a tool call's input captured.
- **Dollars** — no pricing data.
- **Cross-run questions** aren't a feature yet. An agent *can* loop over runs,
  but there is no index, so it is N calls and slow.

### The seven tools

| tool | for |
|---|---|
| `list_runs` | the run index |
| `get_graph` | one run — compact by default, `detail:"full"` for timings/tokens |
| `find_nodes` | narrow before pulling; a big graph is 20k+ tokens |
| `get_detail` | the actual error text behind one node |
| `focus_nodes` | light up the dashboard |
| `get_current_view` | which run the dashboard is showing |
| `open_visualization` | open the browser on a run |

The read-only ones work with **no server running** — they parse from disk — so
asking questions never requires the dashboard to be open.

---

## 7. When something looks broken

| symptom | cause / fix |
|---|---|
| `mcp --install` output looks like an error | it writes status to stderr; exit code is 0. Run `--check`. |
| Claude doesn't see the tools | restart Claude Code after `--install`; then `--check`. |
| `the claude CLI is not on PATH` | `--install` prints the exact JSON to paste into your MCP config. |
| the highlight never appears | nothing was open. It now opens a tab for you; if not, `--check` the dashboard line. |
| a pane is missing | you collapsed it — `[` or `]`. Remembered per browser. |
| a run shows a banner about unrecognized records | your Claude Code is newer than your rungraph. The graph still renders; `npx rungraph@latest`. |
| the strip says `read 62% of this run` | same cause, worse: enough of the transcript is unreadable that the graph is genuinely incomplete. Upgrade; the inspector's `unread` row names the record types, which is what an issue report needs. |
| the graph is empty | that session has no turns yet (a headless or just-started run). |
| port 4321 in use | it auto-increments; the printed URL is authoritative. |
| a bundle file shows a red banner | it didn't decode (corrupt, or written by a newer rungraph — the banner says which). Other bundles still serve. |
| "this run isn't on this dashboard" | the link points at another server — take the jump button, or re-open the bundle it came from. |
| export refused on a bundle viewer | by design: send the original `.rungraph` file instead of re-exporting it. |

Everything is local. The server binds `127.0.0.1` only, makes no network
requests, and nothing leaves your machine — with two named exceptions, both
guarded: `rungraph export`, which blocks on detected secrets, and `rungraph
mcp`, whose tool results travel to your model provider and are redacted on the
way out. The dashboard itself always shows the real values.

---

## 8. Share a run

**Send:** *share…* in the runs pane (check off runs, review the inventory,
download), or `rungraph export --last 2 --as you`. Export always prints what's
about to leave — runs, nodes, your prompts, files touched — and **blocks** on
detected secrets, offering `--redact-secrets`, `--structure-only`, or
`--allow-secrets`. Send the `.rungraph` file over any channel you already
trust; rungraph never touches a network.

**Receive:** `npx rungraph open team-work.rungraph`. An ephemeral dashboard —
nothing copied, nothing left behind — with every run wearing its provenance
("shared by Bilal"). Signals derive on your side, your agent can be pointed at
the shared runs (`list_runs` shows them next to your own), and the whole focus
loop works on them.

**Link:** *copy link* in the header captures the current view as a URL;
`focus_nodes` answers with one too. A link that lands on a dashboard without
that run offers a one-click jump to the one that has it.

---

## 9. Driving it from a script

Every subcommand is non-interactive: JSON on stdout, logs on stderr, exit
`0` ok / `1` error / `2` nothing matched.

```bash
rungraph list --json
rungraph graph <runId> --json     # full IR, including signals[] and files[]
rungraph find <runId> <query> --json
rungraph serve --no-open --json   # {"url":"http://127.0.0.1:4321"}
rungraph export --last 1 --json   # {"written","bytes",…}; exit 1 + findings on a scan hit
rungraph open <file> --no-open --json
rungraph mcp --check --json
```

The IR is versioned and documented in [SCHEMA.md](../SCHEMA.md). It is
vendor-neutral — Claude Code, Codex CLI, Hermes Agent and opencode are the four
adapters today, and a `.rungraph` bundle opens with no adapter at all.
