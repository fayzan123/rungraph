import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { scan, toIndexEntry, findRun, ADAPTERS } from './scanner.js';
import { startServer } from './server.js';
import { openInBrowser } from './open.js';
import { attachSignals } from './signals.js';
import { matchNodes } from './find.js';
import { writePortFile, removePortFile } from './portfile.js';

const require = createRequire(import.meta.url);

const HELP = `rungraph — see your agent runs as a graph

Reconstructs AI coding-agent sessions and workflow runs from the transcripts
already on disk (no hooks, no setup) and renders them as an interactive
directed graph. Everything is local; the server binds 127.0.0.1 only.

USAGE
  rungraph                       Scan, start the server, open the browser.
  rungraph list [--json]         Print the run index (newest first).
  rungraph graph <runId>         Print the Graph IR for one run (JSON, stdout).
  rungraph find <runId> <query>  Print nodes whose label or files match a substring.
  rungraph serve [--no-open]     Start the server without/with opening a browser.
  rungraph mcp [--install]       Run the MCP server on stdio (--install registers it once).
  rungraph mcp --check           Is the agent side set up and working? Prints what to fix.

OPTIONS
  --json             Machine output: compact JSON on stdout (logs stay on stderr).
  --project <path>   Only runs whose project cwd is (inside) this path.
  --port <n>         Preferred port (default 4321; auto-increments if taken).
  --no-open          serve: do not open a browser; the URL is always printed.
  --install          mcp: register rungraph with Claude Code, then exit.
  --check            mcp: verify the agent side end to end, then exit.
  --scope <s>        mcp --install: user (default) | project | local.
  -h, --help         This help.
  -v, --version      Version.

EXIT CODES
  0  success
  1  error
  2  no runs found (list/graph/find: nothing matched)

FOR AGENTS
  rungraph list --json                 → {"runs":[{"runId","kind","title","project","modifiedAt","active",…}]}
  rungraph graph <runId> --json        → Graph IR: {"irVersion":1,"meta":{…},"nodes":[…],"edges":[…],
                                           "groups":[…],"signals":[…]}  (schema: SCHEMA.md)
  rungraph find <runId> <q> --json     → {"nodeIds":[…],"nodes":[…]}  — narrow before pulling a
                                         whole graph; a 500-node IR is 40–50k tokens of context.
  rungraph serve --no-open --json      → {"url":"http://127.0.0.1:4321"}  (stays in foreground)
  rungraph mcp                         → MCP server on stdio: list_runs, get_graph, find_nodes,
                                         get_detail, focus_nodes, get_current_view,
                                         open_visualization. focus_nodes lights up the open
                                         dashboard while you answer in the terminal.
  All commands are non-interactive: no prompts, data on stdout, logs on stderr.`;

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
    open: command !== 'serve' || !args.values['no-open'],
    install: args.values.install,
    check: args.values.check,
    scope: args.values.scope,
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
  const { runs } = await scan({ project: opts.project });
  const entries = runs.map((r) => toIndexEntry(r));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ runs: entries }) + '\n');
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
  // The MCP process is a separate process with no way to learn the port; this
  // is how it finds us. Removed on clean shutdown — a crash leaves it behind,
  // which readers handle with a liveness probe rather than trusting the file.
  await writePortFile(server.port);
  if (opts.open) {
    const ok = await openInBrowser(server.url);
    if (!ok) process.stderr.write(`rungraph: could not open a browser — visit ${server.url}\n`);
  }
  // Foreground until killed.
  await new Promise((resolveWait) => {
    const stop = () =>
      Promise.resolve(removePortFile())
        .then(() => server.close())
        .finally(() => resolveWait());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
