import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, toIndexEntry, findRun, ADAPTERS } from './scanner.js';
import { attachSignals } from './signals.js';
import { matchNodes } from './find.js';
import { liveServerUrl } from './portfile.js';
import { openInBrowser } from './open.js';

/**
 * `rungraph mcp` — JSON-RPC 2.0 over newline-delimited JSON on stdio,
 * hand-rolled because the package has zero runtime dependencies and that is
 * load-bearing for `npx rungraph`.
 *
 * STDOUT IS THE PROTOCOL CHANNEL. One JSON-RPC response per line and nothing
 * else, ever — a stray write corrupts the session for the whole conversation.
 * Every log, warning and diagnostic goes to stderr via log().
 *
 * The read-only tools call the library directly (scan / parse / signals / find)
 * instead of the HTTP API, so asking questions about a run works with no server
 * running. Only the two tools that need a *browser* — focus_nodes and
 * get_current_view — talk to a live server, and both degrade to "skipped"
 * rather than failing.
 */

const require = createRequire(import.meta.url);
const VERSION = require('../package.json').version;
const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rungraph.js');

const PROTOCOL_VERSION = '2025-06-18';
const DATE_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FIND_LIMIT = 100;
const SERVER_BOOT_MS = 8000;
const SERVER_CALL_MS = 3000;

// Compact projection: the fields that let a model reason about a run. Timings,
// token counts and ext are dropped — a large run in full is a whole session
// budget spent to answer one question.
//
// Measured, not assumed, over the largest real sessions on this machine: full
// ~20k tokens for 176 nodes, compact ~13.5k (a third off), and a find_nodes
// result for the same run ~1.1k. So the honest conclusion is that **narrowing
// beats projecting** — which is why every tool description here steers to
// find_nodes first, and why the projection is a cheap extra rather than the
// answer to run size.
//
// Edge `id` is dropped deliberately: at ~17% of a graph's bytes it is the
// single most expensive field, and it is unusable — no tool accepts an edge id,
// and it only ever concatenates two node ids that are already right there.
const COMPACT_NODE_KEYS = ['id', 'kind', 'label', 'status', 'errorCount', 'callCount', 'files', 'group', 'runRef'];
const COMPACT_EDGE_KEYS = ['kind', 'from', 'to', 'reason'];

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** An expected tool failure whose message is written for the model to read. */
class ToolError extends Error {}

/* ---------------------------------------------------------------- transport */

/**
 * Serve MCP over stdio until stdin closes.
 *
 * @param {{ json?: boolean, project?: string }} [opts] `json` is accepted and
 *   ignored — stdout is already machine-only here. `project` scopes every tool
 *   to one project, exactly as `--project` does elsewhere.
 * @returns {Promise<number>} exit code
 */
export async function runMcp(opts = {}) {
  const ctx = { project: opts.project };
  log(`ready — JSON-RPC over stdio, rungraph ${VERSION}${ctx.project ? ` (project ${ctx.project})` : ''}`);

  // Requests run concurrently: open_visualization can spend 8s waiting for a
  // server to boot, and a client ping should not queue behind it. Writes are
  // one atomic line each, so interleaving is safe.
  const pending = new Set();
  const dispatch = (line) => {
    const p = handleLine(line, ctx).finally(() => pending.delete(p));
    pending.add(p);
  };

  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      dispatch(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) dispatch(buf); // a last line with no trailing newline

  await Promise.allSettled([...pending]);
  return 0;
}

/** Never throws: a bad line costs a stderr note, never the process. */
async function handleLine(line, ctx) {
  const text = line.trim();
  if (!text) return;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log('skipped an unparseable line on stdin');
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    log('skipped a line on stdin that was not a JSON-RPC object');
    return;
  }

  const { id, method, params } = msg;
  // No id → notification. Notifications never get a response, not even errors.
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request: no method' } });
    return;
  }

  if (isNotification) {
    try {
      await route(method, params ?? {}, ctx);
    } catch (err) {
      log(`notification ${method}: ${err?.message ?? err}`);
    }
    return;
  }

  try {
    send({ jsonrpc: '2.0', id, result: await route(method, params ?? {}, ctx) });
  } catch (err) {
    if (!(err instanceof RpcError)) log(`${method}: ${err?.stack ?? err}`);
    send({
      jsonrpc: '2.0',
      id,
      error: { code: err instanceof RpcError ? err.code : -32603, message: String(err?.message ?? err) },
    });
  }
}

async function route(method, params, ctx) {
  switch (method) {
    case 'initialize':
      return initializeResult(params);
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) };
    case 'tools/call':
      return await callTool(params, ctx);
    default:
      // Unknown notifications (cancelled, progress, …) are simply ignored;
      // handleLine already suppresses the response for those.
      if (method.startsWith('notifications/')) return {};
      throw new RpcError(-32601, `unknown method "${method}"`);
  }
}

function initializeResult(params) {
  const asked = params?.protocolVersion;
  return {
    // Echo the client's version when it looks like one — the client knows which
    // dialect it speaks better than we do.
    protocolVersion: typeof asked === 'string' && DATE_VERSION.test(asked) ? asked : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'rungraph', version: VERSION },
  };
}

async function callTool(params, ctx) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) throw new RpcError(-32602, `unknown tool "${params?.name}"`);
  try {
    const payload = await tool.run(params?.arguments ?? {}, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  } catch (err) {
    // A failed tool is a result, not a protocol error: the model reads this
    // text and recovers (or tells the user), which an -32603 would deny it.
    log(`${tool.name}: ${err instanceof ToolError ? err.message : (err?.stack ?? err)}`);
    return { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true };
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(message) {
  process.stderr.write(`rungraph mcp: ${message}\n`);
}

/* -------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'list_runs',
    title: 'List agent runs',
    description:
      'List the AI coding-agent runs on this machine, newest first, with runId, title, project, kind (session or workflow) and whether the run is still live. Start here whenever you need a runId and the user has not given you one; runIds are stable, so quote them back verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Absolute path: only runs whose project cwd is at or inside it.' },
      },
      required: [],
      additionalProperties: false,
    },
    run: listRuns,
  },
  {
    name: 'get_graph',
    title: 'Get a run graph',
    description:
      'Fetch the graph of one run: nodes (turns, agents, grouped tool calls, workflows, human interventions), edges, groups, derived signals (what went wrong) and per-node files[] (what was touched). Returns the COMPACT projection by default — ids, kinds, labels, status, error/call counts, files, edge reasons and all signals — which is what you want for almost every question. Pass detail:"full" only for timing or token questions; a large run in full is tens of thousands of tokens. On a big run, narrow with find_nodes first.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'From list_runs or get_current_view.' },
        detail: {
          type: 'string',
          enum: ['compact', 'full'],
          description: 'compact (default) drops timings, token counts and ext. full adds them back.',
        },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    run: getGraph,
  },
  {
    name: 'find_nodes',
    title: 'Find nodes in a run',
    description:
      'Case-insensitive substring search over node labels and the file paths each node touched. Use this BEFORE get_graph on any run that is not small: it returns only the matching nodes, so you can locate "the Edit calls on token.js" or "the test runs" for a few hundred tokens instead of pulling the whole graph. Returns node ids you can pass straight to get_detail or focus_nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        query: { type: 'string', description: 'Plain substring — no globs, no regex. A file name or a tool name works well.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: `Max nodes returned (default ${DEFAULT_FIND_LIMIT}).` },
      },
      required: ['runId', 'query'],
      additionalProperties: false,
    },
    run: findNodes,
  },
  {
    name: 'get_detail',
    title: 'Get node detail',
    description:
      'Fetch the full payload behind one node: the prompt and response of a turn, the transcript of an agent, the individual inputs/outputs of a grouped tool node, the text of a human intervention. This is where the actual error messages live — reach for it once find_nodes or the signals have told you which node to open. Strings are pre-truncated for size.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        nodeId: { type: 'string', description: 'A node id from get_graph or find_nodes, quoted verbatim.' },
      },
      required: ['runId', 'nodeId'],
      additionalProperties: false,
    },
    run: getDetail,
  },
  {
    name: 'focus_nodes',
    title: 'Highlight nodes in the dashboard',
    description:
      'Light up a set of nodes in the user\'s open rungraph dashboard and pan the view to them. Call this AFTER you have answered in the terminal, so the graph shows what you just described — you answer, the canvas points. The highlight is a bonus, never the answer: if no server is running or no tab is open on that run, the call succeeds with focused:false and you simply mention the highlight was skipped (and hand over the url it returns).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The nodes your answer is about.' },
        label: { type: 'string', description: 'Short chip text, e.g. "6 failed edits".' },
        reason: { type: 'string', description: 'One line on why these nodes matter — shown in the inspector.' },
      },
      required: ['runId', 'nodeIds', 'label', 'reason'],
      additionalProperties: false,
    },
    run: focusNodes,
  },
  {
    name: 'get_current_view',
    title: 'What the dashboard is showing',
    description:
      'Report which runs the user currently has open in a rungraph dashboard, with how many browser tabs are watching each and when each was opened. Runs come back MOST RECENTLY OPENED FIRST, so runs[0] is what the user means by "this run" when they have several tabs. Use it to resolve "this run" without asking them to paste a runId, and to learn whether focus_nodes is worth calling at all — an empty runs list means no browser is connected.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    run: getCurrentView,
  },
  {
    name: 'open_visualization',
    title: 'Open the dashboard',
    description:
      'Open the rungraph dashboard in the user\'s browser, on a specific run when given one. Reuses the running server if there is one; otherwise it starts a detached `rungraph serve` in the background. Use it when the user asks to see a run, or when focus_nodes reported that nothing was watching.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Open straight onto this run.' } },
      required: [],
      additionalProperties: false,
    },
    run: openVisualization,
  },
];

async function listRuns(args, ctx) {
  const { runs } = await scan({ project: args.project ?? ctx.project });
  return { runs: runs.map((r) => toIndexEntry(r)) };
}

async function getGraph(args, ctx) {
  const { ir } = await loadRun(args.runId, ctx);
  if (args.detail === 'full') return ir;
  if (args.detail !== undefined && args.detail !== 'compact') {
    log(`get_graph: ignoring unknown detail "${args.detail}", using compact`);
  }
  return compactGraph(ir);
}

async function findNodes(args, ctx) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new ToolError('find_nodes needs a non-empty query — a file name or tool name works well.');

  const { ir } = await loadRun(args.runId, ctx);
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : DEFAULT_FIND_LIMIT;
  const ids = matchNodes(ir, query);
  const kept = ids.slice(0, limit);
  const byId = new Map((ir.nodes ?? []).map((n) => [n.id, n]));

  const out = {
    runId: ir.meta?.runId ?? args.runId,
    query,
    matched: ids.length,
    nodeIds: kept,
    nodes: kept.map((id) => compactNode(byId.get(id))).filter(Boolean),
  };
  if (ids.length > kept.length) {
    out.truncated = true;
    out.note = `${ids.length} nodes matched; showing the first ${kept.length}. Narrow the query or raise limit.`;
  }
  return out;
}

async function getDetail(args, ctx) {
  if (typeof args.nodeId !== 'string' || !args.nodeId) {
    throw new ToolError('get_detail needs a nodeId — get one from find_nodes or get_graph.');
  }
  const { ir, details } = await loadRun(args.runId, ctx, { collectDetails: true });
  const detail = details?.get(args.nodeId);
  if (!detail) {
    const known = (ir.nodes ?? []).some((n) => n.id === args.nodeId);
    throw new ToolError(
      known
        ? `Node "${args.nodeId}" has no detail payload — everything it carries is already in the graph.`
        : `No node "${args.nodeId}" in run "${args.runId}". Node ids come from get_graph or find_nodes.`,
    );
  }
  return { runId: args.runId, nodeId: args.nodeId, detail };
}

async function focusNodes(args) {
  const runId = requireRunId(args.runId);
  const nodeIds = (Array.isArray(args.nodeIds) ? args.nodeIds : []).filter((id) => typeof id === 'string' && id);
  if (nodeIds.length === 0) throw new ToolError('focus_nodes needs at least one nodeId.');

  const server = await liveServerUrl();
  // No server is the expected case, not a failure: the answer already happened
  // in the terminal, so say the highlight was skipped and move on.
  if (!server) {
    return {
      focused: false,
      reason: 'no rungraph server is running',
      hint: 'Tell the user the dashboard highlight was skipped; `rungraph` (or open_visualization) starts it.',
    };
  }

  const body = {
    runId,
    nodeIds,
    label: typeof args.label === 'string' ? args.label : '',
    reason: typeof args.reason === 'string' ? args.reason : '',
  };
  const res = await callServer(`${server}/api/focus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const url = `${server}/?run=${encodeURIComponent(runId)}`;
  if (!res.ok) {
    return { focused: false, reason: res.body?.error ?? `the rungraph server would not take the focus (${res.why})`, url };
  }

  const clientCount = Number.isInteger(res.body?.clientCount) ? res.body.clientCount : 0;
  const out = { focused: clientCount > 0, clientCount, url };
  if (clientCount === 0) {
    out.reason = 'the dashboard is not open on this run';
    out.hint = 'Tell the user the highlight is waiting and give them this url.';
  }
  return out;
}

async function getCurrentView() {
  const server = await liveServerUrl();
  if (!server) return { runs: [], reason: 'no rungraph server is running' };
  const res = await callServer(`${server}/api/view`);
  if (!res.ok || !Array.isArray(res.body?.runs)) {
    return { runs: [], reason: `the rungraph server did not report its view (${res.why})`, serverUrl: server };
  }
  return { runs: res.body.runs, serverUrl: server };
}

async function openVisualization(args, ctx) {
  let server = await liveServerUrl();
  let pid = null;

  if (!server) {
    const child = spawnServer(ctx.project);
    if (!child) throw new ToolError('Could not start `rungraph serve`. Ask the user to run `rungraph` in a terminal.');
    pid = child.pid ?? null;
    server = await waitForServer(SERVER_BOOT_MS);
    if (!server) {
      throw new ToolError(
        `Started \`rungraph serve\` (pid ${pid}) but it did not answer within ${SERVER_BOOT_MS / 1000}s. Ask the user to run \`rungraph\` in a terminal.`,
      );
    }
  }

  const url = args.runId ? `${server}/?run=${encodeURIComponent(args.runId)}` : server;
  const opened = await openInBrowser(url);
  const out = { opened, url, serverUrl: server, pid, detached: pid !== null };
  out.note = pid
    ? `The rungraph server is running detached as pid ${pid} and outlives this tool call; stop it with \`kill ${pid}\`.`
    : 'Reused the rungraph server that was already running.';
  if (!opened) out.note += ' No browser could be opened automatically — give the user the url.';
  return out;
}

/* ------------------------------------------------------------------ helpers */

/** Parse a run straight from disk — no server required, which is the point. */
async function loadRun(runId, ctx, parseOpts) {
  const id = requireRunId(runId);
  const ref = await findRun(id, { project: ctx.project });
  if (!ref) throw new ToolError(`No run found with id "${id}". Call list_runs for the current ids.`);
  const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
  if (!adapter) throw new ToolError(`No adapter for "${ref.adapter}" — this rungraph cannot read that run.`);
  const { ir, details } = await adapter.parse(ref, parseOpts);
  // Same derivation as the server's, so the terminal answer and the canvas can
  // never disagree about what went wrong.
  attachSignals(ir);
  return { ref, ir, details };
}

function requireRunId(runId) {
  if (typeof runId !== 'string' || !runId) throw new ToolError('runId is required — call list_runs or get_current_view to get one.');
  return runId;
}

function compactGraph(ir) {
  return {
    irVersion: ir.irVersion,
    detail: 'compact',
    meta: ir.meta,
    nodes: (ir.nodes ?? []).map(compactNode).filter(Boolean),
    edges: (ir.edges ?? []).map((e) => pick(e, COMPACT_EDGE_KEYS)),
    groups: ir.groups ?? [],
    signals: ir.signals ?? [],
  };
}

function compactNode(node) {
  return node ? pick(node, COMPACT_NODE_KEYS) : null;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * Talk to the live server. Never throws: a server that passed the liveness
 * probe and then died is the same user-visible situation as no server at all —
 * the highlight is skipped, the answer already happened in the terminal.
 */
async function callServer(url, init = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(SERVER_CALL_MS), ...init });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* an empty or non-JSON body is not worth failing over */
    }
    return { ok: res.ok, why: `HTTP ${res.status}`, body };
  } catch (err) {
    log(`${url}: ${err?.message ?? err}`);
    return { ok: false, why: 'it stopped answering', body: null };
  }
}

/**
 * Start `rungraph serve` detached: it must outlive this MCP process, which dies
 * with the user's Claude Code session.
 */
function spawnServer(project) {
  const args = [BIN_PATH, 'serve', '--no-open'];
  if (project) args.push('--project', project);
  try {
    const child = spawn(process.execPath, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => log(`serve failed to spawn: ${err.message}`)); // an unhandled 'error' would kill us
    child.unref();
    return child;
  } catch (err) {
    log(`serve failed to spawn: ${err?.message ?? err}`);
    return null;
  }
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await liveServerUrl({ timeoutMs: 500 });
    if (url) return url;
    await sleep(200);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ install */

const SCOPES = new Set(['user', 'project', 'local']);

/**
 * `rungraph mcp --install` — the one-time registration that is otherwise a real
 * dent in the zero-setup promise.
 *
 * Delegates to the `claude` CLI because it owns the config format and will keep
 * owning it; writing ~/.claude.json ourselves would be a standing bet against
 * that. Every failure path ends in a command and a JSON block the user can
 * paste — never a prompt, never an editor.
 *
 * @param {{ json?: boolean, scope?: 'user'|'project'|'local' }} [opts]
 * @returns {Promise<number>} exit code
 */
export async function installMcp(opts = {}) {
  // Default 'user': rungraph is a machine-wide tool, and per-project
  // registration would have to be repeated in every repo forever.
  const scope = opts.scope ?? 'user';
  if (!SCOPES.has(scope)) {
    process.stderr.write(`rungraph: invalid --scope "${scope}" (user, project or local)\n`);
    return 1;
  }

  const args = ['mcp', 'add', '--scope', scope, 'rungraph', '--', process.execPath, BIN_PATH, 'mcp'];
  const command = ['claude', ...args].map(shellQuote).join(' ');
  const config = { mcpServers: { rungraph: { command: process.execPath, args: [BIN_PATH, 'mcp'] } } };

  const result = await runClaude(args);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const already = /already exists|already configured/i.test(output);
  const installed = result.code === 0;

  const report = {
    installed,
    alreadyInstalled: already && !installed,
    scope,
    command,
    config,
  };
  if (!installed) {
    report.reason = result.spawnError
      ? 'the `claude` CLI is not on PATH'
      : already
        ? 'an MCP server named "rungraph" is already registered'
        : output || `claude exited ${result.code}`;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + '\n');
  } else if (installed) {
    process.stdout.write(`registered rungraph as an MCP server (scope: ${scope})\n`);
  }

  if (installed) {
    process.stderr.write('rungraph: restart Claude Code to pick up the new server\n');
    return 0;
  }

  if (report.alreadyInstalled) {
    // The user's goal is already met, so this is not a failure — and the
    // "run it yourself" remedy below is the very command that just refused,
    // which would send them round the same loop.
    if (!opts.json) {
      process.stdout.write(`rungraph is already registered as an MCP server (scope: ${scope})\n`);
      process.stderr.write(
        'rungraph: nothing to do — `claude mcp remove rungraph` first to re-register\n',
      );
    }
    return 0;
  }

  process.stderr.write(`rungraph: could not register automatically — ${report.reason}\n`);
  if (!opts.json) {
    process.stderr.write(`\nRun this yourself:\n  ${command}\n`);
    process.stderr.write(`\nOr paste this into your MCP config:\n${JSON.stringify(config, null, 2)}\n`);
  }
  return 1; // the already-registered case returned above
}

/** Run `claude`, capturing output. A missing binary is a result, not a throw. */
function runClaude(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(err?.message ?? err), spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message, spawnError: true }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr, spawnError: false }));
  });
}

/** Quote a path for the copy-pasteable command line. */
function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
