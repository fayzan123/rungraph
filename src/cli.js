import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { scan, toIndexEntry, findRun, ADAPTERS } from './scanner.js';
import { startServer } from './server.js';
import { openInBrowser } from './open.js';
import { attachSignals } from './signals.js';
import { matchNodes } from './find.js';
import { writeRegistryEntry, removeRegistryEntry } from './registry.js';
import { buildBundle, defaultBundleName, defaultSharedBy } from './bundle.js';

const require = createRequire(import.meta.url);

const HELP = `rungraph — see your agent runs as a graph

Reconstructs AI agent sessions and workflow runs from the transcripts
already on disk (no hooks, no setup) and renders them as an interactive
directed graph. Everything is local; the server binds 127.0.0.1 only.

USAGE
  rungraph                       Scan, start the server, open the browser.
  rungraph list [--json]         Print the run index (newest first).
  rungraph graph <runId>         Print the Graph IR for one run (JSON, stdout).
  rungraph find <runId> <query>  Print nodes whose label or files match a substring.
  rungraph serve [--no-open]     Start the server without/with opening a browser.
  rungraph export <runId…>       Write a shareable .rungraph bundle (see EXPORT).
  rungraph open <bundle…>        Serve .rungraph bundle files (ephemeral, read-only).
  rungraph mcp [--install]       Run the MCP server on stdio (--install registers it once,
                                 with claude, codex, hermes, opencode and cursor).
  rungraph mcp --check           Is the agent side set up and working? Prints what to fix.

OPTIONS
  --json             Machine output: compact JSON on stdout (logs stay on stderr).
  --project <path>   Only runs whose project cwd is (inside) this path.
  --port <n>         Preferred port (default 4321; auto-increments if taken).
  --no-open          serve/open: do not open a browser; the URL is always printed.
  --install          mcp: register rungraph with every agent whose runs are on this
                     machine, then exit. Anything that cannot be delegated to
                     prints a config block to paste; nothing is ever a prompt.
  --client <c>       mcp --install: claude | codex | hermes | opencode | cursor | all.
                     Default is every DETECTED agent (one whose transcripts
                     rungraph can read), never a guess. 'all' installs into all
                     four regardless of what was detected.
  --check            mcp: verify the agent side end to end, then exit. Reports one
                     row per detected agent; passes when at least one is wired up.
  --scope <s>        mcp --install --client claude: user (default) | project | local.
                     Claude-only; ignored with a note for the other agents.
  -h, --help         This help.
  -v, --version      Version.

EXPORT
  rungraph export <runId…> [--last <n>] [--out <file>] [--as <name>]
                  [--structure-only] [--redact-secrets] [--allow-secrets] [--json]
  --last <n>          The n most recent runs of the current project, instead of ids.
  --out <file>        Output path (default: <project>-<date>.rungraph here).
  --as <name>         The sharedBy display name (default: $USER).
  --structure-only    Strip all content; keep graph shape, tool names, files, timings.
  --redact-secrets    Replace each detected secret with a placeholder, keep the rest.
  --allow-secrets     Export verbatim despite scan findings (for false positives).
  Every export prints an inventory to stderr, and BLOCKS (exit 1) when the
  secrets scan finds a high-confidence match. Exit: 0 written, 1 blocked or
  failed, 2 usage. Recipients open the file with: rungraph open <file>

EXIT CODES
  0  success
  1  error (export: blocked or failed)
  2  no runs found (list/graph/find: nothing matched; export/open: usage)

FOR AGENTS
  rungraph list --json                 → {"runs":[{"runId","kind","title","project","modifiedAt","active",…}]}
  rungraph graph <runId> --json        → Graph IR: {"irVersion":1,"meta":{…},"nodes":[…],"edges":[…],
                                           "groups":[…],"signals":[…]}  (schema: SCHEMA.md)
  rungraph find <runId> <q> --json     → {"nodeIds":[…],"nodes":[…]}  — narrow before pulling a
                                         whole graph; a 500-node IR is 40–50k tokens of context.
  rungraph serve --no-open --json      → {"url":"http://127.0.0.1:4321"}  (stays in foreground)
  rungraph export --last 2 --json      → {"written","bytes","runs",…} on success;
                                         {"blocked":true,"findings":[…]} + exit 1 on a scan hit.
  rungraph open <file> --json          → {"url","runs","errors"}  (stays in foreground)
  rungraph mcp                         → MCP server on stdio: list_runs, get_graph, find_nodes,
                                         get_detail, focus_nodes, get_current_view,
                                         open_visualization. focus_nodes lights up the open
                                         dashboard while you answer in the terminal.
  rungraph mcp --install --json        → {"detected":[…],"installed":n,"already":n,"pasted":n,
                                           "failed":n,"launch":{"command","args","via"},
                                           "clients":[{"client","tier","status","installed",…}]}
                                         status: installed | already | pasted | failed.
                                         BREAKING at 0.4.x: this used to be one client's
                                         report at top level; it is now clients[].
  rungraph mcp --check --json          → {"ok":true,"checks":[{"name","ok","detail","fix"?,
                                           "client"?,"state"?,"advisory"?}]}
  All commands are non-interactive: no prompts, data on stdout, logs on stderr.

ENVIRONMENT
  RUNGRAPH_NO_NUDGE=1   Silence serve's "install the MCP half" note for good. Without it
                        the note repeats on every serve until an agent has actually
                        handshaked with the MCP server — installing is not enough,
                        deliberately: a registration that never loads is the case worth
                        still hearing about.
  RUNGRAPH_STATE_DIR    Where that handshake's breadcrumb lives (default: ~/.rungraph).`;

export async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        project: { type: 'string' },
        port: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        install: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        scope: { type: 'string' },
        client: { type: 'string' },
        last: { type: 'string' },
        out: { type: 'string' },
        as: { type: 'string' },
        'structure-only': { type: 'boolean', default: false },
        'redact-secrets': { type: 'boolean', default: false },
        'allow-secrets': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`rungraph: ${err.message}\n`);
    return 1;
  }

  if (args.values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (args.values.version) {
    process.stdout.write(require('../package.json').version + '\n');
    return 0;
  }

  const [command = 'serve', ...rest] = args.positionals;
  const opts = {
    json: args.values.json,
    project: args.values.project,
    port: args.values.port ? Number(args.values.port) : undefined,
    open: !['serve', 'open'].includes(command) || !args.values['no-open'],
    install: args.values.install,
    check: args.values.check,
    scope: args.values.scope,
    client: args.values.client,
    last: args.values.last,
    out: args.values.out,
    as: args.values.as,
    structureOnly: args.values['structure-only'],
    redactSecrets: args.values['redact-secrets'],
    allowSecrets: args.values['allow-secrets'],
  };
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
    process.stderr.write(`rungraph: invalid --port ${args.values.port}\n`);
    return 1;
  }

  try {
    switch (command) {
      case 'list':
        return await cmdList(opts);
      case 'graph':
        return await cmdGraph(rest[0], opts);
      case 'find':
        return await cmdFind(rest[0], rest.slice(1).join(' '), opts);
      case 'serve':
        return await cmdServe(opts);
      case 'export':
        return await cmdExport(rest, opts);
      case 'open':
        return await cmdOpen(rest, opts);
      case 'mcp':
        return await cmdMcp(opts);
      default:
        process.stderr.write(`rungraph: unknown command "${command}" (see rungraph --help)\n`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`rungraph: ${err?.stack ?? err}\n`);
    return 1;
  }
}

async function cmdList(opts) {
  const { runs, warnings } = await scan({ project: opts.project });
  const entries = runs.map((r) => toIndexEntry(r));
  // Adapter-level degradations (e.g. Hermes disabled on a pre-22.13 Node)
  // ride the same JSON agents already read; humans get them on stderr.
  for (const w of warnings ?? []) process.stderr.write(`rungraph: ⚠ ${w.adapter}: ${w.reason}\n`);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ runs: entries, ...(warnings?.length ? { warnings } : {}) }) + '\n',
    );
  } else {
    if (entries.length === 0) {
      process.stderr.write('rungraph: no runs found\n');
      return 2;
    }
    for (const e of entries) {
      const live = e.active ? ' ● live' : '';
      const kind = e.kind === 'workflow' ? 'wf ' : 'ses';
      process.stdout.write(
        `${e.modifiedAt}  ${kind}  ${e.title}${live}\n           ${e.runId}\n`,
      );
    }
  }
  return entries.length === 0 ? 2 : 0;
}

async function cmdGraph(runId, opts) {
  if (!runId) {
    process.stderr.write('rungraph: usage: rungraph graph <runId> [--json]\n');
    return 1;
  }
  const ref = await findRun(runId, { project: opts.project });
  if (!ref) {
    process.stderr.write(`rungraph: no run found with id "${runId}"\n`);
    return 2;
  }
  const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
  const { ir } = await adapter.parse(ref);
  // Third and last call site. An agent reading `rungraph graph --json` and a
  // human reading the dashboard must be told the same things are wrong.
  attachSignals(ir);
  process.stdout.write(
    (opts.json ? JSON.stringify(ir) : JSON.stringify(ir, null, 2)) + '\n',
  );
  return 0;
}

async function cmdFind(runId, query, opts) {
  if (!runId || !query) {
    process.stderr.write('rungraph: usage: rungraph find <runId> <query> [--json]\n');
    return 1;
  }
  const ref = await findRun(runId, { project: opts.project });
  if (!ref) {
    process.stderr.write(`rungraph: no run found with id "${runId}"\n`);
    return 2;
  }
  const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
  const { ir } = await adapter.parse(ref);
  attachSignals(ir);
  const nodeIds = matchNodes(ir, query);
  const want = new Set(nodeIds);
  const nodes = ir.nodes.filter((n) => want.has(n.id));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ runId, query, matched: nodes.length, nodeIds, nodes }) + '\n');
  } else {
    for (const n of nodes) {
      process.stdout.write(`${n.id}  ${n.kind.padEnd(8)}  ${n.label}\n`);
    }
  }
  if (nodes.length === 0) {
    process.stderr.write(`rungraph: nothing matched "${query}"\n`);
    return 2;
  }
  return 0;
}

async function cmdMcp(opts) {
  const { runMcp, installMcp, checkMcp } = await import('./mcp.js');
  if (opts.install) return installMcp(opts);
  if (opts.check) return checkMcp(opts);
  return runMcp(opts);
}

async function cmdServe(opts) {
  const server = await startServer({
    preferredPort: opts.port ?? 4321,
    project: opts.project,
  });
  process.stdout.write(JSON.stringify({ url: server.url }) + '\n');
  process.stderr.write(`rungraph: serving on ${server.url} (Ctrl-C to stop)\n`);
  // Deliberately NOT awaited. Deciding whether to nudge is a stat, but naming
  // the detected agents costs a full scan — measured at ~250ms over 252 runs
  // on the author's machine, and it grows with the corpus. Awaiting it here
  // would delay the browser opening for exactly the users who have the most
  // runs. serveForeground blocks until SIGINT, so the line always lands.
  void nudgeIfUninstalled();
  return serveForeground(server, ['local'], opts);
}

/**
 * The other half of the loop, introduced.
 *
 * `npx rungraph` is the entire documented entry point, and it used to say
 * nothing about MCP: a user could run rungraph every day for a month and
 * never learn that half the product exists. The only mentions lived in
 * `--help`, the README, and one sidebar panel.
 *
 * Deliberately narrow:
 *
 * - **`serve` only.** Not `list`, `graph`, `find` or `export` — those are the
 *   agent-facing commands, where unsolicited stderr is noise in someone's
 *   tool output.
 * - **Never `rungraph open`.** A recipient viewing a colleague's bundle has no
 *   runs of their own and no use for the MCP server. (Which is why this lives
 *   in cmdServe rather than in the serveForeground both commands share.)
 * - **stderr, always**, including under `--json`. It is a log, and logs go to
 *   stderr; the data contract on stdout is untouched.
 * - `RUNGRAPH_NO_NUDGE=1` silences it permanently, for the user who has
 *   decided against MCP. Documented in `--help`, not in the nudge itself — a
 *   nudge that spends a line explaining how to dismiss itself is a worse nudge.
 *
 * Suppression is breadcrumb-based: it goes quiet once an agent has actually
 * handshaked with the MCP server, not once someone has run `--install`. That
 * costs a repeat for a user who installed into a config that never loads, and
 * that is the right cost — they are exactly the user who most needs to keep
 * seeing it.
 *
 * Never throws and never blocks the server: a scan that fails costs the
 * "Detected" line, nothing more, and the whole function is fire-and-forget.
 */
async function nudgeIfUninstalled() {
  try {
    await printNudge();
  } catch {
    /* a nudge is the least important thing this process does */
  }
}

async function printNudge() {
  if (process.env.RUNGRAPH_NO_NUDGE === '1') return;
  const { readBreadcrumb, detectClients } = await import('./clients.js');
  if (await readBreadcrumb()) return;

  // Machine-wide, not `--project`-scoped: the nudge names what agents are on
  // this machine, and the install it points at is machine-wide too.
  let detected = [];
  try {
    detected = detectClients(await scan());
  } catch {
    /* the nudge names what it can prove, and here it can prove nothing */
  }
  process.stderr.write(
    '\nrungraph: ⚠ the other half of rungraph is not installed.\n' +
      '  Your agent can drive this dashboard over MCP — you ask in your terminal,\n' +
      '  the graph lights up here.\n' +
      '    npx rungraph mcp --install\n' +
      (detected.length ? `  Detected on this machine: ${detected.join(', ')}\n` : '') +
      '  Already set up?  npx rungraph mcp --check\n',
  );
}

/**
 * `rungraph open` — serve bundle files, ephemerally. Nothing is copied
 * anywhere; closing the process leaves no trace. The file itself is the
 * library: keep it, re-open it, delete it when done.
 */
async function cmdOpen(paths, opts) {
  if (paths.length === 0) {
    process.stderr.write('rungraph: usage: rungraph open <bundle…> [--port <n>]\n');
    return 2;
  }
  const server = await startServer({
    preferredPort: opts.port ?? 4321,
    bundles: paths.map((p) => resolve(p)),
  });
  // A corrupt bundle degrades, never crashes: name the file, serve the rest.
  for (const e of server.bundleErrors) {
    process.stderr.write(`rungraph: ${e.file}: ${e.error}\n`);
  }
  if (server.bundleRunCount === 0) {
    process.stderr.write('rungraph: no runs could be loaded from the given bundle(s)\n');
    await server.close();
    return 1;
  }
  process.stdout.write(
    JSON.stringify({ url: server.url, runs: server.bundleRunCount, errors: server.bundleErrors }) + '\n',
  );
  process.stderr.write(
    `rungraph: serving ${server.bundleRunCount} shared run${server.bundleRunCount === 1 ? '' : 's'} on ${server.url} (Ctrl-C to stop)\n`,
  );
  return serveForeground(server, paths.map((p) => `bundle:${basename(p)}`), opts);
}

/** Registry entry + browser + foreground-until-killed, shared by serve/open. */
async function serveForeground(server, sources, opts) {
  // The MCP process is separate, with no way to learn the port; the registry
  // is how it finds every live server. Removed on clean shutdown — a crash
  // leaves the entry behind, which readers handle with a liveness probe.
  await writeRegistryEntry(server.port, sources);
  if (opts.open) {
    const ok = await openInBrowser(server.url);
    if (!ok) process.stderr.write(`rungraph: could not open a browser — visit ${server.url}\n`);
  }
  await new Promise((resolveWait) => {
    const stop = () =>
      Promise.resolve(removeRegistryEntry(server.port))
        .then(() => server.close())
        .finally(() => resolveWait());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/**
 * `rungraph export` — write a shareable `.rungraph` bundle. The inventory
 * prints to stderr on EVERY export, blocked or not: people do not realize how
 * much lives in a transcript, so the tool makes it visible before it leaves
 * the machine. Exit codes: 0 written, 1 blocked or failed, 2 usage.
 */
async function cmdExport(runIdArgs, opts) {
  let runIds = runIdArgs;
  if (opts.last !== undefined) {
    const n = Number(opts.last);
    if (!Number.isInteger(n) || n <= 0 || runIdArgs.length > 0) {
      process.stderr.write(
        'rungraph: usage: rungraph export <runId…> | --last <n>  (one or the other)\n',
      );
      return 2;
    }
    // The dominant human path — "export what I just did": the n most recent
    // sessions of the current project; their workflow runs ride along via
    // runRef inclusion.
    const { runs } = await scan({ project: opts.project ?? process.cwd() });
    runIds = runs.filter((r) => r.kind === 'session').slice(0, n).map((r) => r.runId);
    if (runIds.length === 0) {
      process.stderr.write('rungraph: no runs found for this project — see rungraph list\n');
      return 1;
    }
  }
  if (runIds.length === 0) {
    process.stderr.write('rungraph: usage: rungraph export <runId…> [--last <n>] [--out <file>]\n');
    return 2;
  }
  if (opts.structureOnly && opts.redactSecrets) {
    process.stderr.write('rungraph: --structure-only already strips content; drop --redact-secrets\n');
    return 2;
  }
  const redaction = opts.structureOnly
    ? 'structure-only'
    : opts.redactSecrets
      ? 'redact-secrets'
      : 'full';

  // buildBundle fails closed: a scanner error throws, main() reports exit 1 —
  // the safe default for an outbound artifact is "did not leave".
  const result = await buildBundle(runIds, {
    sharedBy: opts.as || defaultSharedBy(),
    redaction,
    allowSecrets: opts.allowSecrets,
  });
  printInventory(result.inventory);

  if (result.blocked) {
    const total = result.findings.reduce((t, f) => t + f.count, 0);
    process.stderr.write(
      `rungraph: ✗ export blocked: ${total} high-confidence secret${total === 1 ? '' : 's'} found\n`,
    );
    for (const f of result.findings) {
      const runShort = (f.runId ?? '?').split(':').pop();
      const where = f.nodeId ? `node ${f.nodeId} · ${f.where}` : f.where;
      process.stderr.write(`    run ${runShort} · ${where} · ${f.name} (${f.hint})${f.count > 1 ? ` ×${f.count}` : ''}\n`);
    }
    process.stderr.write(
      '  re-run with one of:\n' +
        '    --redact-secrets    replace each match with a placeholder, keep everything else\n' +
        '    --structure-only    strip all content, keep graph shape / tool names / timings\n' +
        "    --allow-secrets     export verbatim (you've confirmed these are fine to share)\n",
    );
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ blocked: true, findings: result.findings, inventory: result.inventory }) + '\n',
      );
    }
    return 1;
  }

  const out = resolve(opts.out ?? defaultBundleName(result.envelope));
  await writeFile(out, result.buffer);
  const redactedCount = redaction === 'redact-secrets'
    ? result.findings.reduce((t, f) => t + f.count, 0)
    : 0;
  if (redactedCount > 0) {
    process.stderr.write(`rungraph: redacted ${redactedCount} secret${redactedCount === 1 ? '' : 's'} in place\n`);
  }
  process.stderr.write(
    `rungraph: wrote ${out} (${result.buffer.length.toLocaleString('en-US')} bytes) — recipients: rungraph open ${basename(out)}\n`,
  );
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        written: out,
        bytes: result.buffer.length,
        redaction,
        runs: result.inventory.runCount,
        nodeCount: result.inventory.nodeCount,
        findings: result.findings,
        inventory: result.inventory,
      }) + '\n',
    );
  } else {
    process.stdout.write(out + '\n');
  }
  return 0;
}

/** The consent surface: what is about to leave, on stderr, every time. */
function printInventory(inv) {
  const tier =
    inv.redaction === 'full'
      ? 'full content'
      : inv.redaction === 'redact-secrets'
        ? 'full content, secrets redacted'
        : 'structure only — no prompts, no outputs';
  process.stderr.write(
    `rungraph: export inventory (${tier}):\n` +
      `  ${inv.runCount} run${inv.runCount === 1 ? '' : 's'} · ${inv.nodeCount} nodes · ${inv.promptCount} of your prompts included\n`,
  );
  for (const r of inv.runs) {
    const kind = r.kind === 'workflow' ? 'wf ' : 'ses';
    process.stderr.write(`    ${kind}  ${r.title}${r.snapshot ? '  [live — exported as a snapshot]' : ''}\n`);
  }
  if (inv.files.length > 0) {
    process.stderr.write(`  files touched: ${inv.files.length}\n`);
    for (const f of inv.sensitiveFiles) {
      process.stderr.write(`    ! ${f}  ← credential-looking path\n`);
    }
  }
  for (const w of inv.warnings) process.stderr.write(`  ⚠ ${w}\n`);
}

/** Process bootstrap, shared by bin/rungraph.js and direct `node src/cli.js`. */
export async function runCli() {
  // `rungraph list --json | head -1` closes stdout early — exit quietly.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') process.exit(0);
  });
  process.exitCode = await main(process.argv.slice(2));
}

// Run `node src/cli.js …` without this guard and the module loads, nothing
// calls main(), the event loop drains, and node exits 0 in silence — which an
// agent reads as success.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
