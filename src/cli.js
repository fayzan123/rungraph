import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { scan, toIndexEntry, findRun, ADAPTERS } from './scanner.js';
import { startServer } from './server.js';
import { openInBrowser } from './open.js';

const require = createRequire(import.meta.url);

const HELP = `rungraph — see your agent runs as a graph

Reconstructs AI coding-agent sessions and workflow runs from the transcripts
already on disk (no hooks, no setup) and renders them as an interactive
directed graph. Everything is local; the server binds 127.0.0.1 only.

USAGE
  rungraph                       Scan, start the server, open the browser.
  rungraph list [--json]         Print the run index (newest first).
  rungraph graph <runId>         Print the Graph IR for one run (JSON, stdout).
  rungraph serve [--no-open]     Start the server without/with opening a browser.

OPTIONS
  --json             Machine output: compact JSON on stdout (logs stay on stderr).
  --project <path>   Only runs whose project cwd is (inside) this path.
  --port <n>         Preferred port (default 4321; auto-increments if taken).
  --no-open          serve: do not open a browser; the URL is always printed.
  -h, --help         This help.
  -v, --version      Version.

EXIT CODES
  0  success
  1  error
  2  no runs found (list/graph: nothing matched)

FOR AGENTS
  rungraph list --json                 → {"runs":[{"runId","kind","title","project","modifiedAt","active",…}]}
  rungraph graph <runId> --json        → Graph IR: {"irVersion":1,"meta":{…},"nodes":[…],"edges":[…],"groups":[…]}
                                         (schema: SCHEMA.md in the package / repo)
  rungraph serve --no-open --json      → {"url":"http://127.0.0.1:4321"}  (stays in foreground)
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
      case 'serve':
        return await cmdServe(opts);
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
  process.stdout.write(
    (opts.json ? JSON.stringify(ir) : JSON.stringify(ir, null, 2)) + '\n',
  );
  return 0;
}

async function cmdServe(opts) {
  const server = await startServer({
    preferredPort: opts.port ?? 4321,
    project: opts.project,
  });
  process.stdout.write(JSON.stringify({ url: server.url }) + '\n');
  process.stderr.write(`rungraph: serving on ${server.url} (Ctrl-C to stop)\n`);
  if (opts.open) {
    const ok = await openInBrowser(server.url);
    if (!ok) process.stderr.write(`rungraph: could not open a browser — visit ${server.url}\n`);
  }
  // Foreground until killed.
  await new Promise((resolveWait) => {
    const stop = () => server.close().finally(() => resolveWait());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}
