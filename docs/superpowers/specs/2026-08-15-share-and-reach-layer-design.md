# rungraph — Share & Reach Layer — Design Spec

**Date:** 2026-08-15
**Status:** Approved by Fayzan (brainstorming session, 2026-08-15)
**Parent spec:** `2026-08-11-rungraph-design.md` (v1). Companions:
`2026-08-11-frontend-navigation-design.md`, `2026-08-12-signal-and-focus-layer-design.md`.

All prior constraints carry over unchanged: agent-first CLI, vendor-neutral IR, parser purity,
never-blank-screen, localhost-only, zero runtime dependencies, precision over recall.

## Problem

rungraph is solitary. Everything it does — reconstruction, signals, the focus loop — happens for
one person looking at their own runs. Three limits follow:

1. **A run cannot leave the machine.** If person B's agent went sideways and person A could help,
   or A manages B and wants to see where a feature was actually built, the only option today is
   screen-sharing. The whole review loop — A asking *their* agent questions about B's sessions,
   the graph lighting up — exists and works, but only ever against your own transcripts.
2. **Only Claude Code runs parse.** The IR is vendor-neutral by design, but until a second adapter
   exists that is a claim, not a property. Every design decision downstream of
   `adapters/claude-code/` is untested against a second format.
3. **A view cannot be referenced.** There is no way to hand a colleague, a PR description, or your
   future self a pointer to "this run, these nodes, this is why they matter." Focus state is
   ephemeral and dies with the tab.

The three fixes share a theme — extending who and what the existing loop can reach — and they
compound: a shared bundle is more useful when the recipient's agent can be pointed at it
(aggregated MCP), when it can contain runs from any vendor (Codex adapter), and when the sender
can say "look here" (deep links).

There is also a distribution consequence worth stating: opening a bundle requires `npx rungraph`,
so every shared bundle recruits its recipient. Sharing makes the tool social instead of solitary.

## Scope

**In scope (four phases):**

1. `.rungraph` bundles: `rungraph export` with a blocking secrets scan, `rungraph open` for
   ephemeral viewing, provenance surfaced end to end
2. Multi-server MCP: the port file becomes a registry; the MCP aggregates every live dashboard
3. A Codex CLI adapter under the existing adapter contract, grounded in corpus discovery
4. Deep links: focus state in the URL, produced by the UI and by `focus_nodes`

**Explicitly out:**

- **Any relay, upload, or transfer service.** Considered and rejected — see below.
- **`rungraph import` / a managed local library of received bundles.** Rejected — see below.
- Annotations (sender marking nodes before export). A likely later chapter; it composes with
  bundles via the manifest without changing this design, so nothing here needs to anticipate it.
- Static single-file HTML export. A view-only complement to bundles, not a substitute — a bundle's
  point is that the recipient's *agent* can query it.
- Run comparison, cost estimates, filtering — still out, per the parent specs.
- Accounts or identity of any kind. `sharedBy` is an unverified display string.

### Rejected approaches

**A token/relay transfer service.** The original sketch: B uploads (encrypted) sessions somewhere,
sends A a token, A redeems it and the data downloads. Rejected because even an E2E-encrypted
dead-drop means running infrastructure, writing a retention policy, and owning liability for the
most sensitive artifact developers produce — transcripts contain prompts, file contents, and
sometimes pasted credentials. That is the opposite of a tool whose pitch is "nothing leaves the
machine." The replacement keeps the capability and discards the liability: **the file is the
token.** B sends the `.rungraph` file over whatever channel they already trust — Slack, AirDrop,
email, a repo — and rungraph itself never touches a network. Revisit only if file-passing proves
to be real friction in practice.

**`rungraph import` into a managed store.** A `~/.rungraph/shared/` library would persist received
bundles across launches, but it adds a disk-write path that does not exist today, plus a remove
command, provenance bookkeeping, and lifecycle questions. The filesystem is already a library:
keep the bundle file, re-open it any time, delete it when done. `rungraph open` stays ephemeral
and rungraph keeps writing nothing to disk.

## 1. The bundle format

A `.rungraph` file is gzipped JSON — `node:zlib`, so the zero-dependency rule holds:

```jsonc
{
  "bundleVersion": 1,
  "irVersion": 1,
  "sharedBy": "Bilal",              // display string; --as, defaults to $USER
  "exportedAt": "2026-08-15T18:02:11Z",
  "redaction": "full",              // 'full' | 'redact-secrets' | 'structure-only'
  "runs": [
    { "runId": "…", "ir": { /* the run's full IR, detail payloads included */ } },
    { "runId": "…", "snapshot": "2026-08-15T18:02:11Z", "ir": { /* … */ } }
  ]
}
```

A run that appeared **live at export time** exports as-is — the parser tolerates mid-write
truncation by design, so nothing new can crash — and carries a `snapshot` timestamp, surfaced in
the recipient's provenance badge and in the export inventory. The mid-disaster "my agent is
stuck, look at this" ask is one of sharing's best cases; refusing live runs would kill it over a
heuristic (quiet windows) that cannot distinguish "running" from "stalled" anyway.

**Bundle fidelity equals dashboard fidelity.** Detail payloads are capped at parse time (inputs
3000 chars, outputs/prompts 8000) before they ever enter the IR, so a bundle shows the recipient
exactly what the sender's own dashboard shows — and content beyond a cap cannot leak because it
never existed in the exportable form. The caps also keep bundles bounded.

**The bundle carries IR, not raw transcripts.** Three reasons, each load-bearing:

1. Redaction operates on one documented schema (`SCHEMA.md`) instead of every vendor's transcript
   format. A secrets scan over raw formats would need per-vendor knowledge and would rot.
2. Vendor neutrality survives sharing: a Codex run exports and opens identically to a Claude run.
3. The viewer needs no adapters to open a bundle — `rungraph open` on a machine that has never
   seen Claude Code or Codex still renders the graph.

**Detail payloads are exported eagerly.** Live serving fetches node detail lazily from transcript
files; a bundle has no transcript files, so export walks every node's detail and embeds it. This
is the main reason export is a distinct code path rather than "serialize what the server has."

**Workflow runs referenced by `runRef` are included transitively.** A workflow node drills into
its own graph; a bundle missing those IRs would break drill-down for the recipient. Export
follows `runRef`s from the selected runs and bundles every reachable run, once.

**Signals are not stored.** The viewer's server derives them at view time, exactly like any local
run — the one-implementation rule (`src/signals.js`, server-side, at every consumer) survives
sharing unchanged. A bundle written by an older rungraph gets the viewer's current, calibrated
signal layer for free.

**Version posture.** `bundleVersion` governs the envelope, `irVersion` the payload. The viewer
accepts `irVersion` values it knows and **refuses newer ones with a named-versions banner**
("this bundle was written by a newer rungraph — upgrade with `npm i -g rungraph`"), never a blank
screen or a partial render that silently drops fields.

## 2. Export

```
rungraph export <runId…> [--last <n>] --out <file> [--as <name>]
                [--structure-only] [--redact-secrets] [--allow-secrets] [--json]
```

Agent-first CLI rules apply: non-interactive, no prompts, inventory and logs to stderr, data to
stdout (`--json` emits a machine-readable summary: output path, runs, counts, findings). Run ids
come from `rungraph list --json`, same as everywhere else; `--last <n>` selects the n most
recent runs of the current project instead — the dominant human path ("export what I just did"),
reusing the scanner's existing recency sort and project matching. `--out` defaults to
`<project>-<date>.rungraph` in the current directory. Exit codes: 0 written, 1 blocked or
failed, 2 usage.

**Default is full content** — prompts, tool outputs, diffs, detail payloads. A bundle exported for
"help me debug this" is useless without content, and a default everyone overrides is not a
default.

**The inventory prints to stderr on every export, blocked or not:** run count, node count, files
touched (calling out dotfiles and env-looking paths), how many of the sender's own prompts are
included. People do not realize how much lives in a transcript; the tool makes it visible before
it leaves the machine.

### The blocking secrets scan

Export scans all outgoing text (labels, detail payloads, file contents embedded in diffs) for
**high-confidence secret patterns**: AWS access keys (`AKIA…`), PEM private-key blocks, GitHub
tokens (`ghp_`/`gho_`/…), Slack tokens (`xox…`), npm tokens, and similar anchored, prefix-keyed
patterns. On any hit the export **blocks with exit 1** and lists every finding — run, node,
where in the node, pattern kind:

```
✗ export blocked: 2 high-confidence secrets found
    run abc123 · node g:toolu_017x · Bash output · AWS access key (AKIA…)
    run abc123 · node t:9f2e…      · your prompt  · GitHub token (ghp_…)
  re-run with one of:
    --redact-secrets    replace each match with a placeholder, keep everything else
    --structure-only    strip all content, keep graph shape / tool names / timings
    --allow-secrets     export verbatim (you've confirmed these are fine to share)
```

- `--redact-secrets` replaces each match with `[REDACTED:<kind>]` and exports everything else
  verbatim. The expected common path: the recipient never needed the credential.
- `--allow-secrets` exists for false positives (fixture keys, documented example tokens). It is a
  deliberate, named act — not a `-f`.

**Precision over recall applies to the scanner exactly as it does to signals.** Anchored,
prefix-keyed patterns only — no entropy heuristics, which flag every hash and UUID and train
users to reflexively type `--allow-secrets`, after which the scanner protects no one. The block
is cheap (a re-run) and the failure it prevents is irreversible (a live key in someone's Slack).
The pattern list is calibrated the same way thresholds were: run against the real local corpus
and require near-zero false positives before shipping. **The scanner fails closed** — if it
throws, the export blocks with the error, because the safe default for an outbound artifact is
"did not leave."

### `--structure-only`

The governing rule: **derived and mechanical survives; authored text dies.** Retained: node ids,
kinds, tool names, tool-node labels (mechanical, path-level — e.g. "Edit src/auth.js"),
`files[]`, timings, token counts, status and error counts, edges, groups, run meta. Dropped:
every detail payload, and turn/human labels are replaced with generic positional ones
("turn 12"). The exact field census against `SCHEMA.md` is an implementation task; the rule
decides every case. A structure-only bundle still answers "where was feature X built" — file
paths and tool labels feed `find_nodes` — it just cannot answer "what approach did they take."

The scan runs on **whatever actually leaves, at every redaction tier** — structure-only output
included (paths and mechanical labels can carry tokens too, rarely but irreversibly).

### Dashboard export — one implementation, two frontends

Humans export from the dashboard too: the runs pane gains a selection mode — check off runs, hit
Export — backed by `GET /api/export?runs=…&redaction=…`, which runs the **same export module**
the CLI uses (eager detail, transitive `runRef`s, manifest, scan) and streams the finished
bundle as a download. The browser's own downloader writes the file, so rungraph itself still
writes nothing to disk.

The consent surface must not fork: the dialog shows the same inventory before anything
downloads, and a scan hit returns the findings instead of the file — rendered as the same block
with the same three resolutions (redact / structure-only / allow), with identical defaults to
the CLI. Two frontends teaching two privacy postures would be worse than either alone.

The export dialog also carries the agent affordance — "or ask your agent:
`rungraph export --last 2 --as Bilal`" — because the CLI *is* the agent's export surface; no MCP
export tool is added, per the agent-first constraint. **A docs deliverable ships with this
phase:** a Sharing section in the README walking both flows end to end — B's export (dashboard
checkbox and agent incantation), the transfer ("send the file however you already send files"),
and A's `rungraph open` plus asking their agent about the opened runs.

```
rungraph open <bundle…> [--port <n>]
```

Reads the bundle(s), starts the same server, serves their runs. Nothing is copied anywhere;
closing the process leaves no trace. The file itself is the library — keep it, re-open it,
delete it. Multiple bundles serve side by side. `open` serves **bundles only** — a dedicated
review context; the recipient's own runs stay on their own dashboard, and the MCP registry (§4)
is what joins the two views for the agent.

- **Provenance is carried on run index entries, not inside the IR.** `sharedBy`, `bundle`
  (filename), and `exportedAt` describe the *transfer*, not the run, so they live on the
  server's index entries: `/api/index` and `list_runs` return them, and the runs pane renders a
  provenance badge ("shared by Bilal · team-work.rungraph"). The IR is untouched — no `irVersion`
  implications.
- **Bundles are static.** No watcher, no live tail, liveness is always "complete." The SSE
  channel still runs for the focus loop, which works on bundle runs exactly as on local ones.
- **Bundle-served runs refuse re-export** — `/api/export` on an `open` server answers "send the
  original `.rungraph` file instead." Re-exporting would stamp fresh provenance over B's
  (`sharedBy` laundering) and can only ever lose information relative to the file A already has.
- **A corrupt or truncated bundle degrades, never crashes:** bad gzip or JSON produces a named
  error banner for that file; other bundles on the command line still serve. Unknown
  `bundleVersion`/`irVersion` follows §1's refusal rule.

## 4. The port registry and the aggregated MCP

The routing question this answers: person A keeps their own dashboard running *and* opens B's
bundle. Two servers exist. The agent must never silently answer about the wrong one — the same
class of quiet-lie the server-side-signals rule exists to prevent.

**The single port file becomes a registry directory.** `$TMPDIR/rungraph-servers/<port>.json`,
one file per live server — separate files, so concurrent servers never race on a shared file:

```jsonc
{ "port": 4321, "pid": 812, "startedAt": "…", "sources": ["local"] }
{ "port": 4322, "pid": 990, "startedAt": "…", "sources": ["bundle:team-work.rungraph"] }
```

Servers write their entry on startup and remove it on clean shutdown, as today. Stale entries
from crashed processes fail the per-entry liveness probe (unchanged from `liveServerUrl`) and are
opportunistically deleted by whoever finds them. Registry entries contain a port, a pid, and
source labels — nothing sensitive. No migration shim for the old single file: the MCP process and
the server ship in one package and restart together.

**The MCP aggregates.** `rungraph mcp` probes every registry entry:

- `list_runs` merges runs across all live servers, each entry tagged with its provenance and
  originating dashboard. The agent sees A's runs and B's bundle runs in one list and
  distinguishes them by the fields, matched against the user's phrasing ("in the bundle Bilal
  sent me").
- Every other tool routes by `runId`: the MCP maintains a runId→server map refreshed on each
  `list_runs`/`get_current_view`, and on a miss re-probes all servers before erroring.
  `focus_nodes` therefore lands on the server — and the browser tab — that is actually showing
  that run.
- If the same `runId` is served by two servers (two dashboards over the same project), route to
  the most recently started; the IRs are identical reconstructions of the same files. Run ids
  are UUID-derived, so bundle/local collisions do not occur in practice.
- `get_current_view` aggregates connected views across servers. `open_visualization(runId)`
  opens the owning server's URL; with no argument, the most recently started.

Scoping needs no new concept: **the agent's universe is whatever the live servers serve**, and
every downstream tool already takes a `runId`. Cross-run querying stays out of scope for free —
the agent is the query engine, looping `find_nodes` over the runs `list_runs` gave it.

## 5. The Codex adapter

`src/adapters/codex/`, under the exact contract `adapters/claude-code/` established: lines in,
IR out; no server imports; no I/O beyond the run's own files; `fingerprint`, `watchTargets`,
`matchesProject` exported so scanner/server/watcher stay vendor-neutral. The scanner is already
shaped for this — `ADAPTERS` is an array and `defaultRootDirs()` returns per-adapter roots — so
Codex appends an adapter and a root: `~/.codex/sessions`, overridable via
`RUNGRAPH_CODEX_SESSIONS` (the `RUNGRAPH_CLAUDE_PROJECTS` precedent).

**Format facts observed on this machine, to be confirmed — not assumed — by discovery:** rollout
files `rollout-<timestamp>-<uuid>.jsonl` under `YYYY/MM/DD` directories; line `type`s
`session_meta`, `event_msg`, `response_item`, `turn_context`, `world_state`, `compacted`;
`session_meta` carries `cwd` (project matching), CLI version, and — notably — subagent lineage:
`thread_source: "subagent"`, `parent_thread_id`, spawn depth, agent nicknames. Subagent threads
live in **separate rollout files linked to their parent**, so Codex runs produce a genuine
directed graph, and the adapter must resolve parent/child across files — the shape
`fingerprint`/`watchTargets` already exist to express (a run is a file *set*).

**Discovery precedes implementation.** A corpus-discovery pass over the 74 real local Codex
sessions establishes ground truth — the same methodology that grounded v1, where discovery
against the real corpus is what caught `Agent`-not-`Task` and the denial variants. Its report is
the input to fixture design. Fixtures are synthetic and format-faithful via
`tests/fixtures/generate.mjs`, and include a Codex **clean run** and a Codex **subagent run**.

Codex-specific material (`world_state`, `turn_context`, nicknames, fork lineage) goes in the
namespaced `ext` bag. Unknown line types are skipped and counted per the never-blank-screen
rule — Codex's format will drift, and drift must degrade, not crash.

**Signals are the acceptance risk, named up front.** `deriveSignals` consumes the IR, so it runs
on Codex runs automatically — but its thresholds were calibrated on Claude sessions. The spec
mandates measuring signal yield over the Codex corpus before the adapter ships, with the same
bar the Claude corpus had to meet: clean runs derive zero signals, median yield in the same
band. If Codex distributions differ materially, the fix is chosen from measurement — adapter
normalization versus vendor-scoped thresholds — not designed pre-emptively. Precision over
recall is not waived for vendor two.

**And it is not a ship blocker.** If calibration misses the bar at ship time, the adapter ships
with signal derivation **suppressed for Codex-sourced runs** (the scanner knows each run's
adapter; the gate is one check where signals attach) until thresholds meet it. Codex users get
the graph, files, focus, MCP, and sharing on day one; the strip stays empty exactly as on a
clean run. A graph without markers is still the product — markers that lie are not.

## 6. Deep links

Focus state moves into the URL hash, as **another producer feeding the existing FocusSet
spine** — the fifth row of the producers table, alongside signals, find, files, and the agent.
Consumers (canvas, strip, inspector) are untouched; dim-never-hide is untouched.

```
http://127.0.0.1:4321/#run=<runId>&sel=<nodeId>&f=<base64url(descriptor)>
```

The descriptor names the focus **by its source, not by its members**, so links stay short and
stay honest when the underlying run knowledge improves:

```jsonc
{ "source": "find",   "query": "auth" }            // re-runs matchNodes on load
{ "source": "signal", "signalId": "sig:…" }         // re-resolves against derived signals
{ "source": "file",   "path": "/abs/path/src/auth/token.js" }  // re-resolves via files[]
{ "source": "agent",  "nodeIds": ["…"], "label": "…", "reason": "…" }  // explicit set
```

`find`, `signal`, and `file` descriptors re-execute on load — one matcher, one signal
derivation, one attribution source, so a link and a fresh query can never disagree. Only
agent-sourced sets are explicit ids with their label and reason, because they have no query to
re-run.

- **Restore:** on load the canvas restores selection and focus through the spine, and pans/zooms
  to the set (the agent-focus behavior — the user clicked a link; the view should have moved).
- **Degradation, registry-assisted:** on an unknown `runId` the dashboard asks its own server,
  which consults the port registry (§4) and probes the other live servers via a new
  `GET /api/locate/:runId`; if one owns the run, the banner upgrades to "this run is open on
  :4322 — jump to it," otherwise it names the runId and stops. Never a blank screen. This is
  what makes links survive the flagship share flow — A's own dashboard on 4321, B's bundle on
  4322, B's link hitting the wrong one — and it fixes every cross-server link, not just bundle
  ones. Node ids missing from the current graph → filter to known ids; if that empties the set,
  clear focus and say so (the live-delta rule, reused).
- **Producers:** a copy-link affordance on the current view, and `focus_nodes` returns the URL in
  its response so the agent can hand the user a pastable link for a PR or an issue.
- **Durability, stated honestly:** links embed host and port. `serve` already prefers 4321 and
  auto-increments, so links survive restarts on a machine running one dashboard; a link minted
  on a fallback port dies with that server — connection refused, a failure the browser explains
  itself. Links are same-machine artifacts unless the recipient also has the run (e.g. via a
  bundle), which is exactly the compose-with-sharing case they exist for.

## 7. Schema and surface additions

- **IR: unchanged.** `irVersion` stays 1; nothing in this layer adds IR fields.
- **Bundle envelope** (§1) documented in `SCHEMA.md` alongside the IR it wraps.
- **Index entries / `list_runs`:** optional `provenance: { sharedBy, bundle, exportedAt,
  snapshot? }`; consumers must tolerate absence (every local run).
- **`focus_nodes` response:** gains `url`.
- **Server:** `GET /api/export` (bundle download; refuses on bundle-served runs and on scan
  findings, returning the findings instead), `GET /api/locate/:runId` (registry-backed lookup
  for the deep-link jump), and — on **every** request — a `Host`-header guard: anything other
  than `127.0.0.1`/`localhost`/`[::1]` with the server's port gets a 403. The guard closes the
  DNS-rebinding read that the existing GET endpoints allow today and is a hard prerequisite for
  a browser-reachable endpoint that streams whole transcripts.
- **Frontend:** selection mode + Export dialog in the runs pane; provenance/snapshot badge;
  copy-link affordance.
- **CLI:** `export` (with `--last`) and `open` subcommands, documented in `--help` and README,
  both `--json`-capable per the agent-first rule, plus the README Sharing section (§2).

## 8. Error handling & degradation

| failure | behavior |
|---|---|
| secrets found on export | block, exit 1, listing with per-finding location; `--json` carries the findings |
| secrets scanner throws | fail closed: export blocks with the error — outbound artifacts default to "did not leave" |
| corrupt / truncated bundle | named error banner for that file; other bundles still serve |
| bundle with newer `bundleVersion`/`irVersion` | refuse with a named-versions upgrade message, never partial render |
| dashboard export hits scan findings | dialog shows the findings and the three resolutions; no file leaves |
| re-export of a bundle-served run | refused: "send the original `.rungraph` file instead" |
| request with a non-local `Host` header | 403 on every endpoint |
| deep link to unknown run | `/api/locate` consults the registry: owning server found → jump offer; otherwise banner naming the runId; never blank |
| deep link node ids absent from graph | filter to known; if empty, clear focus and say so |
| registry entry for a dead server | liveness probe fails → skipped, opportunistically deleted |
| same runId on two live servers | route to the most recently started; identical IRs |
| MCP with zero live servers | tools answer with "no dashboard running" guidance, as today |
| unknown Codex line type | skip + count, surfaced as the existing banner |

## 9. Privacy posture

Export is the first rungraph feature whose purpose is moving data off the machine, so the posture
is stated in full:

- **rungraph itself never touches a network.** Export writes a local file; the transfer channel
  is the user's own. The server still binds `127.0.0.1`; no new write endpoints exist (`open`
  reads files named on its command line; registry entries hold a port and a pid).
- **Every request is `Host`-guarded** (§7), closing the DNS-rebinding read of transcript data
  that binding alone never prevented. The existing `Origin` check on `POST /api/focus` stays;
  the `Host` guard is the missing counterpart for reads, and `/api/export` does not ship
  without it.
- **Consent is structural**: export is an explicit command naming explicit runs, with the
  inventory printed every time and a hard stop on detected secrets.
- **`sharedBy` is an unverified display string.** A bundle asserts, not proves, its sender —
  trust it the way you trust any file from that channel. Stated in the docs so nobody assumes
  otherwise; identity/signing is deliberately out of scope.
- **Opened bundles are read-only** and vanish from the machine's rungraph state the moment the
  process exits.

## 10. Testing

Fixture-driven, per the house pattern:

- **Bundle round-trip:** export fixture runs → open → served IR identical to the source (modulo
  provenance on index entries); snapshot. A bundle containing a workflow `runRef` proves
  transitive inclusion by drilling into the workflow graph. A live-fixture export carries the
  `snapshot` timestamp. `GET /api/export` produces a bundle IR-equal to the CLI's for the same
  runs — the two-frontends-one-implementation guard — and returns findings, not a file, on a
  scan hit; a bundle-served run refuses re-export.
- **Host guard:** a request with a foreign `Host` gets 403 on a read endpoint and on
  `/api/export`; local hosts in all three spellings pass.
- **Locate:** with two live servers, `/api/locate/:runId` finds the owning server for a run the
  asked server does not have; unknown everywhere → empty answer, banner path.
- **Secrets scan:** a fixture per pattern kind blocks with exit 1 and correct locations;
  `--redact-secrets` output contains placeholders and nothing matching the pattern;
  `--allow-secrets` passes verbatim; **the clean corpus exports with zero findings** — the
  false-positive guard, same role as the clean-run signal test.
- **Structure-only:** snapshot proves detail payloads and authored labels are absent and
  mechanical fields survive; `matchNodes` still hits file paths in the stripped bundle.
- **Registry:** two live servers merge in `list_runs` with correct provenance; routing by runId
  reaches the owning server; stale entries are skipped and cleaned; same-runId collision routes
  to the newest.
- **Codex:** snapshot IR over the synthetic fixtures; the Codex clean run derives zero signals;
  cross-file subagent linking asserted on the subagent fixture; an unknown-line fixture asserts
  skip-and-count. The corpus yield measurement is recorded in the discovery report, like the
  threshold calibration was.
- **Deep links:** descriptor encode/decode round-trips unit-tested beside `viewmath`/`focus`;
  find- and signal-sourced descriptors re-execute rather than replay stored ids; absent-run and
  absent-node degradation tested at the helper level. Rendered UI stays manual + demo.
- **CLI:** `export`/`open` respect `--json`, stdout/stderr separation, and exit codes;
  `tests/cli.test.js` extends its existing signal-call-site guard to the `open` path, since a
  bundle server that skipped `attachSignals` would be exactly the agent/dashboard disagreement
  the rule exists to prevent.

## Phasing

| phase | ships | depends on |
|---|---|---|
| 1 | Host guard; bundle format; `export` (scan, redaction, inventory, `--last`); dashboard export; `open`; provenance badge; README Sharing section | — |
| 2 | port registry, aggregated MCP routing | 1 (motivation; mechanically independent) |
| 3 | Codex adapter: discovery report, then adapter + fixtures + yield measurement (suppression fallback per §5) | — |
| 4 | deep links: descriptor, restore, copy-link, `focus_nodes` URL; `/api/locate` + jump | — (core); 2 (the jump) |

Phase 1 is releasable alone: sharing works whenever the recipient runs one dashboard at a time,
with the old last-writer port file as the documented interim — and that interim is genuinely
degraded: with two dashboards up, the MCP answers about whichever server wrote the file last,
and either's clean shutdown can strand the MCP until a restart. Acceptable only because phase 2
follows immediately and single-dashboard users (everyone, during early adoption) never hit it.
Phase 2 removes the one silent wrong-answer mode. Phases 3 and 4 are independent of both and of
each other — parallelizable if wanted; only the deep-link jump waits for the registry. The
compounding order (bundles → aggregation → reach) is the recommended order.

## Open questions for implementation

1. **Secrets pattern census** — the final list of anchored patterns, calibrated against the real
   local corpus with the near-zero false-positive bar. Measured, not reasoned.
2. **Structure-only field census** — the full retained/dropped table against `SCHEMA.md`; the
   "derived survives, authored dies" rule decides each case, including `edge.reason` (derived
   narration, but may quote authored text — inspect real values before deciding).
3. **Inventory heuristics** — what counts as an env-looking or dotfile path worth calling out in
   the export inventory; precision-over-recall applies (a noisy inventory is skimmed, not read).
4. **Bundle size in practice** — gzip level and real-world sizes for large runs with eager detail;
   measure on the local corpus. If multi-hundred-MB bundles appear, that is data for a future
   decision, not a reason to complicate v1.
5. **Registry directory on multi-user machines** — `tmpdir()` is per-user on macOS but shared on
   some Linux setups; the directory may need a uid suffix. Decide when touching `portfile.js`.
6. **Codex liveness windows** — quiet-window constants were tuned for Claude Code's write
   cadence; Codex's cadence is discovery-report material and may need its own values via the
   adapter's existing liveness surface.
7. **Export dialog UX** — selection-mode gestures, dialog layout, and how the three resolutions
   render in the browser are frontend-pass details; the consent parity rule (§2) is the spec,
   the pixels are not.
