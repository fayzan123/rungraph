import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, toIndexEntry, findRun, ADAPTERS } from './scanner.js';
import { attachSignals } from './signals.js';
import { matchNodes } from './find.js';
import { classifyCoverage, coverageNote } from './coverage.js';
import { redactTree, redactSecrets } from './secrets.js';
import { liveServers, liveServerUrl } from './registry.js';
import { buildFocusHash } from './deeplink.js';
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

// Server-level instructions exist because tool descriptions alone don't close
// the loop: hosts that lazy-load tool schemas show the model only bare tool
// names until it loads them, so the "call focus_nodes after you answer"
// contract in the focus_nodes description is invisible exactly when the model
// decides whether to use it. The initialize-result instructions field is
// surfaced up front even by those hosts — this is the one copy of the
// proactive-loop contract that is guaranteed to be in context.
const INSTRUCTIONS = `The user may have a rungraph dashboard open — a live graph view of the AI coding-agent runs on this machine. You and that dashboard are two ends of one loop: answer in the conversation first, then call focus_nodes so the graph lights up the nodes your answer is about. Do this proactively after answering any question about work done in a project — including code questions like "where was X built", where the right nodes live in the run that wrote the code (list_runs, then find_nodes, then focus_nodes). The highlight is a bonus, never the answer: with no dashboard watching, focus_nodes still succeeds with focused:false and you simply mention the highlight was skipped. The read tools return a \`coverage\` field, and a \`note\` whenever part of a run could not be parsed — state what it says before calling a run clean or complete, because a run rungraph could only partly read looks exactly like one where nothing went wrong.`;
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
  // runMap: runId → owning server URL, refreshed on every list_runs /
  // get_current_view and re-probed on a miss. This is how every tool routes
  // to the server — and the browser tab — actually showing that run, with
  // the user's own dashboard and an opened bundle live side by side.
  const ctx = { project: opts.project, runMap: new Map() };
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
    instructions: INSTRUCTIONS,
  };
}

async function callTool(params, ctx) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) throw new RpcError(-32602, `unknown tool "${params?.name}"`);
  try {
    const payload = await tool.run(params?.arguments ?? {}, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(withoutSecrets(payload)) }] };
  } catch (err) {
    // A failed tool is a result, not a protocol error: the model reads this
    // text and recovers (or tells the user), which an -32603 would deny it.
    log(`${tool.name}: ${err instanceof ToolError ? err.message : (err?.stack ?? err)}`);
    // Error text is a way out of the process too — a message that quotes a
    // failing command or an upstream body would otherwise skip the guard.
    const message = redactSecrets(String(err?.message ?? err)).text;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

/**
 * The export path's secrets block, applied to the OTHER way content leaves
 * this machine: an MCP tool result travels in an API request to a model
 * provider and is written into the calling session's own transcript, so a key
 * read once in one run would come to rest in a second one. `rungraph serve`
 * is deliberately NOT treated this way — it renders to the user's own browser
 * over 127.0.0.1, where the bytes never leave and where seeing the real value
 * is how you rotate it. The line is "redact wherever content leaves the
 * machine", and this is the only place in this process that it does.
 *
 * Applied at callTool rather than inside get_detail because every tool result
 * funnels through this one line. That is not just less code: node LABELS carry
 * secrets too (a prompt label at snippet()'s 80-char cap holds a whole GitHub
 * token), so find_nodes and get_graph leak without ever touching a payload.
 *
 * The count is reported for the same reason `coverage` is: a tool that
 * silently strips content leaves the reader believing it saw everything.
 */
function withoutSecrets(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const redacted = redactTree(payload);
  if (redacted > 0 && !Array.isArray(payload)) {
    const note =
      `${redacted} secret${redacted === 1 ? '' : 's'} in this payload ` +
      `${redacted === 1 ? 'was' : 'were'} replaced with [REDACTED:<kind>] before leaving the machine. ` +
      'Redacted is not missing or malformed — the real values are intact on the user\'s ' +
      'dashboard, which serves them locally and sends them nowhere.';
    payload.note = payload.note ? `${payload.note} ${note}` : note;
  }
  return payload;
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
      'Fetch the graph of one run: nodes (turns, agents, grouped tool calls, workflows, human interventions), edges, groups, derived signals (what went wrong) and per-node files[] (what was touched). Returns the COMPACT projection by default — ids, kinds, labels, status, error/call counts, files, edge reasons and all signals — which is what you want for almost every question. Pass detail:"full" only for timing or token questions; a large run in full is tens of thousands of tokens. On a big run, narrow with find_nodes first. Carries meta.coverage (records examined vs. unrecognized) — say what it says before calling a run clean or complete.',
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
      'Case-insensitive substring search over node labels and the file paths each node touched. Use this BEFORE get_graph on any run that is not small: it returns only the matching nodes, so you can locate "the Edit calls on token.js" or "the test runs" for a few hundred tokens instead of pulling the whole graph. Returns node ids you can pass straight to get_detail or focus_nodes. Carries coverage for the run — say what it says before calling a run clean or complete.',
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
      'Fetch the full payload behind one node: the prompt and response of a turn, the transcript of an agent, the individual inputs/outputs of a grouped tool node, the text of a human intervention. This is where the actual error messages live — reach for it once find_nodes or the signals have told you which node to open. Strings are pre-truncated for size. Carries coverage for the run — say what it says before calling a run clean or complete.',
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
      "Light up a set of nodes in the user's rungraph dashboard and pan the view to them. Call this AFTER you have answered in the terminal, so the graph shows what you just described — you answer, the canvas points. It takes the dashboard to the right run for them: a tab showing a different run follows the answer here (with one-click undo), and if nothing is open at all it opens a tab on this run. The highlight is a bonus, never the answer: with no server running the call still succeeds, with focused:false, and you simply mention the highlight was skipped.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        nodeIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The nodes your answer is about.' },
        label: { type: 'string', description: 'Short chip text, e.g. "6 failed edits".' },
        reason: { type: 'string', description: 'One line on why these nodes matter — shown in the inspector.' },
        open: {
          type: 'boolean',
          description:
            'Default true: if no dashboard is open at all, open one on this run. Pass false when the user has asked you not to open windows.',
        },
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
  const project = args.project ?? ctx.project;
  const { runs, warnings } = await scan({ project });
  const entries = runs.map((r) => toIndexEntry(r));
  const known = new Set(entries.map((e) => e.runId));
  // Merge in what the live servers serve — bundle-served runs exist ONLY
  // there. Each foreign entry keeps its provenance (who shared it, which
  // bundle) and gains the dashboard that owns it, which is how the model
  // matches "in the bundle Bilal sent me" to a runId.
  for (const s of await refreshServers(ctx)) {
    for (const r of s.index.runs) {
      if (known.has(r.runId)) continue;
      if (project && !projectMatches(r.project, project)) continue;
      known.add(r.runId);
      entries.push({ ...r, dashboard: s.url });
    }
  }
  // Same additive warnings the CLI and /api/index carry — an agent deserves
  // to know when an adapter is disabled rather than inferring "no runs".
  return { runs: entries, ...(warnings?.length ? { warnings } : {}) };
}

function projectMatches(runProject, project) {
  if (typeof runProject !== 'string' || !runProject) return false;
  const p = resolvePath(project);
  return runProject === p || runProject.startsWith(p + '/');
}

async function getGraph(args, ctx) {
  const ir = await loadIR(args.runId, ctx);
  if (args.detail !== undefined && args.detail !== 'full' && args.detail !== 'compact') {
    log(`get_graph: ignoring unknown detail "${args.detail}", using compact`);
  }
  const out = args.detail === 'full' ? { ...ir } : compactGraph(ir);
  return withCoverage(out, ir);
}

/**
 * Attach coverage — and, on the same verdicts as the canvas badge, the prose
 * note — to a read tool's result.
 *
 * The verdict comes from the ONE shared `classifyCoverage`, so the caveat the
 * model reads and the badge the user sees can never disagree about the same
 * run. Firing only on `loud` would mean a 95% run shows the human a caveat and
 * tells the agent nothing, which is exactly the terminal-vs-canvas split
 * server-side derivation exists to prevent.
 *
 * Absent coverage (a pre-coverage bundle) is omitted entirely — unknown is
 * never presented as complete, and never guessed at.
 */
function withCoverage(out, ir) {
  const meta = ir?.meta;
  if (meta?.coverage) out.coverage = meta.coverage;
  const note = coverageNote(meta, classifyCoverage(meta, ir?.signals?.length ?? 0));
  if (note) out.note = out.note ? `${out.note} ${note}` : note;
  return out;
}

async function findNodes(args, ctx) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new ToolError('find_nodes needs a non-empty query — a file name or tool name works well.');

  const ir = await loadIR(args.runId, ctx);
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
  return withCoverage(out, ir);
}

async function getDetail(args, ctx) {
  if (typeof args.nodeId !== 'string' || !args.nodeId) {
    throw new ToolError('get_detail needs a nodeId — get one from find_nodes or get_graph.');
  }
  const id = requireRunId(args.runId);
  const ref = await findRun(id, { project: ctx.project });
  if (ref) {
    const { ir, details } = await loadRun(id, ctx, { collectDetails: true });
    const detail = details?.get(args.nodeId);
    if (!detail) {
      const known = (ir.nodes ?? []).some((n) => n.id === args.nodeId);
      throw new ToolError(
        known
          ? `Node "${args.nodeId}" has no detail payload — everything it carries is already in the graph.`
          : `No node "${args.nodeId}" in run "${args.runId}". Node ids come from get_graph or find_nodes.`,
      );
    }
    return withCoverage({ runId: id, nodeId: args.nodeId, detail }, ir);
  }
  // Not on disk — a bundle-served run. Its details live only on the server
  // that opened the bundle, so route by runId.
  const detail = await fetchRunResource(
    ctx,
    id,
    (url) => `${url}/api/detail/${encodeURIComponent(args.nodeId)}?run=${encodeURIComponent(id)}`,
  );
  if (!detail || detail.error) {
    throw new ToolError(
      detail?.error
        ? `${detail.error} (run "${id}" is served by a dashboard, not by files on this machine)`
        : `No run found with id "${id}". Call list_runs for the current ids.`,
    );
  }
  // The run's coverage lives with its graph, which this path does not need —
  // one extra localhost fetch buys the same caveat a local run gets, and a
  // failure just leaves coverage unknown rather than failing the detail call.
  const ir = await loadIR(id, ctx).catch(() => null);
  return withCoverage({ runId: id, nodeId: args.nodeId, detail }, ir);
}

async function focusNodes(args, ctx) {
  const runId = requireRunId(args.runId);
  const nodeIds = (Array.isArray(args.nodeIds) ? args.nodeIds : []).filter((id) => typeof id === 'string' && id);
  if (nodeIds.length === 0) throw new ToolError('focus_nodes needs at least one nodeId.');

  // Route to the server actually showing this run — with a dashboard and an
  // opened bundle both live, landing the focus on the wrong one would be a
  // silent lie. The fallback for runs no server has loaded yet is a LOCAL
  // server only (it can serve local runs on demand); a bundle viewer can
  // never show a run outside its bundle, so falling back to one would drag
  // the user's tab to a graph that cannot load.
  let server = (await ownerServer(ctx, runId)) ?? (await localServerUrl());
  // No server is the expected case, not a failure: the answer already happened
  // in the terminal, so say the highlight was skipped and move on.
  if (!server) {
    return {
      focused: false,
      reason: 'no rungraph server is running that could show this run',
      hint: 'Tell the user the dashboard highlight was skipped; `rungraph` (or open_visualization) starts it.',
    };
  }

  const body = {
    runId,
    nodeIds,
    label: typeof args.label === 'string' ? args.label : '',
    reason: typeof args.reason === 'string' ? args.reason : '',
  };
  let res = await callServer(`${server}/api/focus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // The mapped server may have died since the last refresh (its port can
    // even be reused by something else). One full re-probe, one retry.
    ctx.runMap.delete(runId);
    const retry = (await ownerServer(ctx, runId)) ?? (await localServerUrl());
    if (retry && retry !== server) {
      server = retry;
      res = await callServer(`${server}/api/focus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
  }
  // A deep link, not just a landing page: pasted into a PR or an issue, it
  // restores this exact focus — run, node set, label, reason — via the hash.
  const url = `${server}/${buildFocusHash({
    runId,
    descriptor: { source: 'agent', nodeIds, label: body.label, reason: body.reason },
  })}`;
  if (!res.ok) {
    return { focused: false, reason: res.body?.error ?? `the rungraph server would not take the focus (${res.why})`, url };
  }

  const clientCount = Number.isInteger(res.body?.clientCount) ? res.body.clientCount : 0;
  const otherClients = Number.isInteger(res.body?.otherClients) ? res.body.otherClients : 0;

  // A tab already on this run lights up in place; a tab on a different run
  // follows the answer here, and offers the user one click back.
  if (clientCount > 0 || otherClients > 0) {
    return {
      focused: true,
      clientCount,
      switchedAnotherTab: clientCount === 0 && otherClients > 0,
      url,
    };
  }

  // Nothing is open anywhere. The server holds the focus for a few minutes, so
  // a tab opened now still arrives already pointed at the answer.
  if (args.open === false) {
    return {
      focused: false,
      clientCount: 0,
      url,
      reason: 'no dashboard is open, and opening one was not requested',
      hint: 'Give the user this url — the highlight is waiting for them there.',
    };
  }
  const opened = await openInBrowser(url);
  return {
    focused: opened,
    clientCount: 0,
    openedDashboard: opened,
    url,
    ...(opened
      ? { hint: 'Say that you opened the dashboard on this run, so they know where to look.' }
      : { reason: 'no dashboard was open and no browser could be opened', hint: 'Give the user this url.' }),
  };
}

async function getCurrentView(args, ctx) {
  const servers = await refreshServers(ctx);
  if (servers.length === 0) return { runs: [], reason: 'no rungraph server is running' };
  const runs = [];
  for (const s of servers) {
    const res = await callServer(`${s.url}/api/view`);
    if (!res.ok || !Array.isArray(res.body?.runs)) continue;
    for (const r of res.body.runs) runs.push({ ...r, serverUrl: s.url, sources: s.sources });
  }
  // Most recently opened first, ACROSS servers — runs[0] is what the user
  // means by "this run" even with a dashboard and a bundle viewer both open.
  runs.sort((a, b) => (a.connectedAt < b.connectedAt ? 1 : -1));
  return {
    runs,
    serverUrl: servers[0].url,
    servers: servers.map((s) => ({ url: s.url, sources: s.sources })),
  };
}

async function openVisualization(args, ctx) {
  // A run already served somewhere opens on ITS server — the one whose
  // browser tab can actually show it. The no-owner fallback is local-only:
  // a bundle viewer cannot show anything outside its bundle.
  let server = args.runId ? await ownerServer(ctx, args.runId) : null;
  server ??= args.runId ? await localServerUrl() : await liveServerUrl();
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

/**
 * Probe every registry entry and refresh the runId → server routing map.
 * Servers come back most recently started first, so writing the map in
 * REVERSE order makes the newest server win a runId served by two (identical
 * reconstructions of the same files — route to the newest).
 */
async function refreshServers(ctx) {
  const servers = await liveServers();
  for (const s of [...servers].reverse()) {
    for (const r of s.index.runs) ctx.runMap.set(r.runId, s.url);
  }
  return servers;
}

/** The URL of the server serving this run — re-probing all servers on a miss. */
async function ownerServer(ctx, runId) {
  if (!ctx.runMap.has(runId)) await refreshServers(ctx);
  return ctx.runMap.get(runId) ?? null;
}

/**
 * The most recently started live server that serves LOCAL runs — the only
 * kind that can load a run it has not seen yet. Registry sources make the
 * distinction: 'local' vs 'bundle:<file>'.
 */
async function localServerUrl() {
  const servers = await liveServers();
  return servers.find((s) => s.sources?.includes('local'))?.url ?? null;
}

/**
 * Fetch a run-scoped resource from whichever server owns the run. A stale map
 * entry (server gone, bundle closed) gets one full re-probe before giving up.
 * Returns the JSON body, or null when no live server owns the run.
 */
async function fetchRunResource(ctx, runId, pathFor) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = attempt === 0 ? await ownerServer(ctx, runId) : ctx.runMap.get(runId);
    if (!url) {
      if (attempt === 0) continue; // ownerServer already re-probed; one more map read
      break;
    }
    const res = await callServer(pathFor(url));
    if (res.ok) return res.body;
    lastError = typeof res.body?.error === 'string' ? res.body.error : null;
    ctx.runMap.delete(runId);
    await refreshServers(ctx);
  }
  return lastError ? { error: lastError } : null;
}

/**
 * The graph for a run, signals attached, wherever it lives: parsed straight
 * from disk when the run is local (no server required — the point), fetched
 * from the owning server when it is bundle-served (the server derived the
 * signals; same one implementation).
 */
async function loadIR(runId, ctx) {
  const id = requireRunId(runId);
  const ref = await findRun(id, { project: ctx.project });
  if (ref) {
    const { ir } = await loadRun(id, ctx);
    return ir;
  }
  const body = await fetchRunResource(ctx, id, (url) => `${url}/api/graph/${encodeURIComponent(id)}`);
  if (body && Number.isInteger(body.irVersion)) return body;
  throw new ToolError(
    `No run found with id "${id}" — not on disk here, and no live dashboard serves it. Call list_runs for the current ids.`,
  );
}

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

/* -------------------------------------------------------------------- check */

/**
 * `rungraph mcp --check` — "is this actually working?"
 *
 * The question the author of this tool could not answer about his own machine,
 * which is a fair sign nobody else could either. Four checks, each with the one
 * next step that fixes it, and an end-to-end handshake rather than a guess: it
 * spawns the real MCP server over real stdio and asks it for its tool list.
 *
 * @returns {Promise<number>} 0 when the loop is usable, 1 when something needs doing
 */
export async function checkMcp(opts = {}) {
  const checks = [];
  const push = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(fix ? { fix } : {}) });

  // 1. Are there runs to ask about at all?
  let runCount = 0;
  try {
    runCount = (await scan({ project: opts.project })).runs.length;
  } catch {
    /* reported as zero below */
  }
  push(
    'runs on disk',
    runCount > 0,
    runCount > 0 ? `${runCount} run${runCount === 1 ? '' : 's'} found` : 'no runs found',
    'Run a coding-agent session, then try again — rungraph reads transcripts already on disk.',
  );

  // 2. Does the MCP server itself start and speak the protocol?
  const handshake = await selfHandshake();
  push(
    'mcp server',
    handshake.ok,
    handshake.ok ? `answers over stdio, ${handshake.tools} tools` : handshake.error,
    'This is a bug in rungraph itself — please report it.',
  );

  // 3. Is it registered with Claude Code?
  const registered = await isRegistered();
  push(
    'registered with claude',
    registered.ok,
    registered.detail,
    'Run `rungraph mcp --install`, then restart Claude Code.',
  );

  // 4. Is a dashboard server up? Optional — read-only tools work without it.
  const server = await liveServerUrl();
  push(
    'dashboard server',
    Boolean(server),
    server ? `serving on ${server}` : 'not running (optional — only focus_nodes needs it)',
    'Run `rungraph` in a terminal to start it and open the dashboard.',
  );

  const essential = checks.filter((c) => c.name !== 'dashboard server');
  const ok = essential.every((c) => c.ok);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok, checks }) + '\n');
    return ok ? 0 : 1;
  }

  for (const c of checks) {
    process.stdout.write(`${c.ok ? '✔' : '✖'} ${c.name.padEnd(24)} ${c.detail}\n`);
  }
  const todo = checks.filter((c) => !c.ok && c.fix);
  if (todo.length) {
    process.stdout.write('\n');
    for (const c of todo) process.stdout.write(`  → ${c.fix}\n`);
  }
  if (ok) {
    process.stdout.write(
      '\nAsk Claude Code, in a project with runs:\n' +
        '  "what went wrong in my last run?"\n' +
        '  "which steps touched <a file you edited>?"\n' +
        '\nNot Claude Code? Any MCP-capable agent can use the same server over stdio:\n' +
        '  Hermes: hermes mcp add rungraph --command npx --args -y rungraph mcp\n' +
        '  then start a new session (see README, "Ask your agent about a run").\n',
    );
  }
  return ok ? 0 : 1;
}

/** Start our own MCP server over real stdio and ask it for its tools. */
function selfHandshake(timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [BIN_PATH, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      return resolve({ ok: false, error: String(err?.message ?? err) });
    }
    let buf = '';
    let tools = 0;
    const done = (result) => {
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'no response over stdio' }), timeoutMs);
    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return done({ ok: false, error: 'wrote something that was not JSON-RPC to stdout' });
        }
        if (msg.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        if (msg.id === 2) {
          tools = msg.result?.tools?.length ?? 0;
          return done(tools > 0 ? { ok: true, tools } : { ok: false, error: 'listed no tools' });
        }
      }
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rungraph-check', version: VERSION } },
      }) + '\n',
    );
  });
}

/** Ask the `claude` CLI whether we are in its MCP config. */
async function isRegistered() {
  const res = await runClaude(['mcp', 'list']);
  if (res.spawnError) {
    return { ok: false, detail: 'the `claude` CLI is not on PATH' };
  }
  const out = `${res.stdout}\n${res.stderr}`;
  if (!/^\s*rungraph:/m.test(out)) return { ok: false, detail: 'not registered' };
  const line = out.split('\n').find((l) => /^\s*rungraph:/.test(l)) ?? '';
  // `claude mcp list` health-checks as it goes, so its own verdict is better
  // evidence than ours.
  const failed = /✗|failed/i.test(line);
  return { ok: !failed, detail: failed ? 'registered, but claude cannot connect to it' : 'registered and connected' };
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
