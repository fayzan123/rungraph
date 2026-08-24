import { isAbsolute, join } from 'node:path';
import { emptyGraph, snippet } from '../../ir.js';
import { readJsonLines, statOrNull } from '../../util.js';
import { mergeFiles } from '../claude-code/files.js';
import { ADAPTER_NAME, promptText, recordChildFiles, rolloutFileForThread, runStats } from './detect.js';
import { tallyUnknownType, mergeUnknownTypes } from '../../coverage.js';

/**
 * Codex rollout parser: lines in, IR out. No server imports; no I/O beyond
 * the run's own files (the parent rollout and its subagent rollouts).
 *
 * Grounded in the 74-file corpus discovery (2026-08-15):
 * - Every line is `{timestamp, type, payload}`; unknown types/subtypes are
 *   skipped and counted — Codex's format drifts across CLI versions and
 *   drift must degrade, never crash.
 * - The turn spine is task_started/task_complete/turn_aborted joined by
 *   turn_id; 25 of 306 corpus turns have no terminal event, so a new
 *   task_started implicitly closes the previous turn. The oldest files have
 *   no task events at all — there each user_message starts a turn.
 * - Tool calls pair with outputs strictly by call_id (parallel batches are
 *   real; adjacency pairing is wrong). Three exec generations exist
 *   (shell_command → exec_command → JS custom `exec`); exit codes and wall
 *   time live in the output TEXT except one generation's metadata.
 * - `patch_apply_end.changes` (absolute-path map) is the authoritative
 *   file-change record; in JS-exec sessions its call_id matches no call, so
 *   attribution falls back to the open tool group.
 * - Assistant text and user prompts are duplicated between event_msg and
 *   response_item streams; the event stream is canonical (user_message is
 *   clean of AGENTS.md/IDE-context injections) and the response_item
 *   duplicates are deliberately skipped.
 * - Reasoning bodies, inter-agent MESSAGE/NEW_TASK payloads and compaction
 *   summaries are encrypted at rest; FINAL_ANSWER is the readable artifact
 *   and doubles as the child's return edge.
 */

/**
 * Liveness fallback window. CALIBRATED, not guessed: the corpus shows
 * 8–10 minute provider-side stalls mid-turn (Claude's 5-minute window would
 * mislabel a running turn as dead in 13.5% of sessions; 10 minutes drops
 * that to 6.8%). It is only a FALLBACK: Codex marks turn ends explicitly, so
 * "over" is primarily "the last turn has a terminal event", and the window
 * applies only to crashed/unterminated turns — erring long is cheap there.
 */
export const CODEX_QUIET_MS = 10 * 60 * 1000;

const KNOWN_TYPES = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'world_state',
  'compacted',
  'inter_agent_communication_metadata',
]);
const KNOWN_EVENTS = new Set([
  'task_started',
  'task_complete',
  'turn_aborted',
  'user_message',
  'agent_message',
  'token_count',
  'patch_apply_end',
  'sub_agent_activity',
  'error',
  'context_compacted',
  'web_search_end',
  'exec_command_end',
  'agent_reasoning',
  'item_completed',
  'thread_name_updated',
  'thread_settings_applied',
]);
const KNOWN_ITEMS = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'agent_message',
  'web_search_call',
  'tool_search_call',
  'tool_search_output',
]);

/**
 * Multi-agent plumbing tools: they never become tool nodes — the agent nodes
 * and their spawn/return edges tell that story, and a lane of `wait_agent ×9`
 * chips would bury it.
 */
const COLLAB_TOOLS = new Set([
  'send_message',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'followup_task',
  'resume_agent',
  'close_agent',
  'send_input',
]);

/** The three exec generations plus their polling companions — one family. */
const SHELL_TOOLS = new Set(['exec_command', 'shell_command', 'exec', 'wait', 'write_stdin']);

const cap = (text, max) => {
  if (typeof text !== 'string') return text == null ? '' : JSON.stringify(text).slice(0, max);
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
};

const msBetween = (a, b) => {
  if (!a || !b) return undefined;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

export async function parse(ref, opts = {}) {
  const collect = opts.collectDetails ?? false;
  const g = emptyGraph({
    runId: ref.runId,
    adapter: ADAPTER_NAME,
    kind: 'session',
    title: ref.title,
  });
  const details = new Map();

  let unrecognized = 0;
  // Coverage: records EXAMINED, in this adapter's unit — non-blank lines in
  // every rollout file the run owns. Counted in the same loops as the
  // unreadable ones; no new reads, no second pass.
  let records = 0;
  const unknownTypes = {};
  const badLineNos = [];
  let maxLineNo = 0;
  const lines = [];
  for await (const { obj, lineNo } of readJsonLines(ref.sessionFile, {
    onBadLine: (_line, n) => badLineNos.push(n),
  })) {
    maxLineNo = Math.max(maxLineNo, lineNo);
    records++;
    if (typeof obj?.type !== 'string' || !KNOWN_TYPES.has(obj.type)) {
      unrecognized++;
      tallyUnknownType(unknownTypes, obj?.type);
      continue;
    }
    lines.push(obj);
  }
  // A malformed FINAL line is mid-write truncation (live tail), not drift —
  // still a record examined, so it counts in `records`, not `unrecognized`.
  maxLineNo = Math.max(maxLineNo, ...badLineNos, 0);
  records += badLineNos.length;
  const badMidFile = badLineNos.filter((n) => n !== maxLineNo);
  unrecognized += badMidFile.length;
  for (let i = 0; i < badMidFile.length; i++) tallyUnknownType(unknownTypes, undefined);

  const b = new RolloutBuilder(g, details, collect);
  // A line whose ENVELOPE parsed but whose payload type is unknown is still one
  // record already counted above — the builder only adds to `unrecognized`.
  for (const line of lines) unrecognized += b.line(line);
  mergeUnknownTypes(unknownTypes, b.unknownTypes);

  // Resolve the spawn TREE breadth-first, before deciding liveness: a run is
  // a file set, a child still writing keeps it alive — and children spawn
  // their own children (depth-2 agents in the real corpus), each in its own
  // rollout, which would otherwise be invisible everywhere.
  const MAX_SPAWN_DEPTH = 5; // observed 1–2; the cap is a cycle backstop
  let frontier = [...b.spawns.values()].map((s) => ({
    ...s,
    threadId: b.threadBySpawn.get(s.callId) ?? null,
  }));
  const resolved = [];
  const seenFiles = new Set();
  for (let depth = 0; depth < MAX_SPAWN_DEPTH && frontier.length > 0; depth++) {
    const next = [];
    for (const spawn of frontier) {
      spawn.file = spawn.threadId ? await rolloutFileForThread(ref.root, spawn.threadId) : null;
      if (spawn.file && seenFiles.has(spawn.file)) spawn.file = null; // cycle guard
      if (spawn.file) seenFiles.add(spawn.file);
      spawn.parsed = spawn.file
        ? await parseChildRollout(spawn.file, { collectTranscript: collect })
        : null;
      if (spawn.parsed) {
        unrecognized += spawn.parsed.unrecognized;
        records += spawn.parsed.records;
        mergeUnknownTypes(unknownTypes, spawn.parsed.unknownTypes);
        for (const gs of spawn.parsed.spawns) {
          next.push({
            callId: gs.callId,
            taskName: gs.taskName,
            ts: gs.ts,
            threadId: spawn.parsed.threadBySpawn.get(gs.callId) ?? null,
            // A grandchild hangs off its spawning agent's node, not a turn.
            fromNodeId: `a:${spawn.callId}`,
            turnId: null,
            failed: false,
          });
        }
      }
      resolved.push(spawn);
    }
    frontier = next;
  }
  ref.childFiles = resolved.map((s) => s.file).filter(Boolean);
  recordChildFiles(ref.runId, ref.childFiles);

  const { maxMtimeMs } = await runStats(ref);
  const quiet = Date.now() - maxMtimeMs >= CODEX_QUIET_MS;
  // Marker-first: an explicitly closed last turn means over, regardless of
  // mtime. The quiet window only adjudicates the crashed-turn shape.
  const live = b.turn !== null && !quiet;

  for (const spawn of resolved) {
    // A child can outlive its parent's turn — its liveness comes from its OWN
    // file's freshness, not just the parent's open-turn state.
    const cst = spawn.file ? await statOrNull(spawn.file) : null;
    const childLive = cst ? Date.now() - cst.mtimeMs < CODEX_QUIET_MS : false;
    materializeAgent(spawn, spawn.parsed, { g, details, b, live: live || childLive });
  }

  b.finish(live);

  g.meta.unrecognizedLineCount = unrecognized;
  g.meta.coverage.records = records;
  g.meta.coverage.unrecognized = unrecognized;
  if (Object.keys(unknownTypes).length > 0) {
    // Vendor vocabulary lives in the namespaced `ext` bag, never in the IR's
    // shared fields.
    g.meta.ext = { ...(g.meta.ext ?? {}), codex: { ...(g.meta.ext?.codex ?? {}), unknownTypes } };
  }
  if (b.firstTs) g.meta.startedAt = b.firstTs;
  if (b.lastTs && !live) g.meta.endedAt = b.lastTs;
  const childTokens = g.nodes
    .filter((n) => n.kind === 'agent' && n.tokens)
    .reduce((t, n) => t + n.tokens.input + n.tokens.output, 0);
  g.meta.totals = {
    tokens: b.cumTokens.input + b.cumTokens.output + childTokens,
    toolCalls: b.toolCallCount,
    agents: resolved.length,
  };
  if (b.title) g.meta.title = snippet(b.title, 100);
  return { ir: g, details };
}

/** Builds turn/tool/human nodes and the sequence chain for one rollout. */
class RolloutBuilder {
  constructor(g, details, collect) {
    this.g = g;
    this.details = details;
    this.collect = collect;
    this.chainTip = null;
    this.pendingReason = null;
    this.turn = null; // { id, node, prompt, responseText, tokens, startTs, endTs }
    this.turnIndex = 0;
    this.metaSeen = new Set(); // session_meta dedupe (resume re-emission)
    this.cwd = undefined;
    this.pendingCalls = new Map(); // call_id → { kind, family, nodeId, ts, timing }
    this.toolNames = new Map(); // tool node id → family (labels are descriptive)
    this.toolFiles = new Map(); // tool node id → union of touched paths
    // tool node id → [{ startTs, endTs }] in call order. Tracked in the
    // builder's own state (like toolFiles), NOT read back from details.calls:
    // `rungraph graph --json` collects no details and must still carry
    // callOffsets / endedAt, and the two must come from the same instants.
    this.toolTimes = new Map();
    this.spawns = new Map(); // call_id → spawn record
    this.threadBySpawn = new Map(); // spawn call_id → child thread id
    this.seenThreads = new Set(); // sub_agent_activity dedupe (fork copies re-emit)
    this.finalAnswers = new Map(); // agent_path → { text, turnId }
    this.narration = null; // commentary agent_message since the last tool call
    this.cumTokens = { input: 0, output: 0 };
    this.toolCallCount = 0;
    this.title = '';
    this.firstTs = undefined;
    this.lastTs = undefined;
    this.unknownTypes = {}; // payload types this grammar does not know
  }

  node(n) {
    this.g.nodes.push(n);
    return n;
  }

  edge(kind, from, to, extra = {}) {
    if (!from || !to || from === to) return;
    const e = { id: `e:${kind}:${from}→${to}`, kind, from, to, ...extra };
    if (this.pendingReason && kind === 'sequence' && !e.reason) {
      e.reason = this.pendingReason;
      this.pendingReason = null;
    }
    if (!this.g.edges.some((x) => x.id === e.id)) this.g.edges.push(e);
    return e;
  }

  chain(nodeId) {
    this.edge('sequence', this.chainTip, nodeId);
    this.chainTip = nodeId;
  }

  /** @returns {number} unrecognized lines consumed by this line (0 or 1) */
  line(obj) {
    if (typeof obj.timestamp === 'string') {
      this.firstTs ??= obj.timestamp;
      this.lastTs = obj.timestamp;
    }
    const p = obj.payload;
    switch (obj.type) {
      case 'session_meta': {
        if (p && typeof p === 'object' && !this.metaSeen.has(p.id)) {
          this.metaSeen.add(p.id);
          if (this.metaSeen.size === 1 && typeof p.cwd === 'string') this.cwd ??= p.cwd;
        }
        return 0;
      }
      case 'turn_context': {
        if (typeof p?.cwd === 'string') this.cwd = p.cwd;
        return 0;
      }
      case 'compacted':
        // History was rewritten under the model — decision lineage worth a
        // reason on the next move, but not a node of its own.
        this.pendingReason = 'after context compaction';
        return 0;
      case 'world_state':
      case 'inter_agent_communication_metadata':
        return 0;
      case 'event_msg':
        return this.event(obj, p);
      case 'response_item':
        return this.item(obj, p);
      default:
        tallyUnknownType(this.unknownTypes, obj.type);
        return 1;
    }
  }

  event(obj, p) {
    const type = p?.type;
    if (typeof type !== 'string' || !KNOWN_EVENTS.has(type)) {
      // Qualified by stream, so `event_msg:foo` and `response_item:foo` never
      // collapse into one indistinguishable bucket.
      tallyUnknownType(this.unknownTypes, typeof type === 'string' ? `event_msg:${type}` : undefined);
      return 1;
    }
    switch (type) {
      case 'task_started':
        // A new task implicitly closes an unterminated one (crash/kill shape).
        this.closeTurn({ crashed: true });
        this.startTurn(p.turn_id, obj.timestamp);
        break;
      case 'task_complete':
        if (this.turn) {
          this.turn.endTs = obj.timestamp;
          if (Number.isFinite(p.duration_ms)) this.turn.node.durationMs = p.duration_ms;
          if (!this.turn.responseText && typeof p.last_agent_message === 'string') {
            this.turn.responseText = p.last_agent_message;
          }
        }
        this.closeTurn({});
        break;
      case 'turn_aborted':
        this.humanInterrupt(obj);
        this.closeTurn({});
        break;
      case 'user_message':
        this.userPrompt(p.message, obj.timestamp);
        break;
      case 'agent_message':
        if (typeof p.message === 'string' && p.message.trim()) {
          if (this.turn) {
            this.turn.responseText +=
              (this.turn.responseText ? '\n\n' : '') + p.message;
            this.turn.endTs = obj.timestamp;
          }
          if (p.phase !== 'final_answer') this.narration = p.message;
        }
        break;
      case 'token_count': {
        const info = p.info;
        if (info?.last_token_usage && this.turn) {
          this.turn.tokens.input += info.last_token_usage.input_tokens ?? 0;
          this.turn.tokens.output += info.last_token_usage.output_tokens ?? 0;
        }
        if (info?.total_token_usage) {
          this.cumTokens = {
            input: info.total_token_usage.input_tokens ?? 0,
            output: info.total_token_usage.output_tokens ?? 0,
          };
        }
        break;
      }
      case 'patch_apply_end':
        this.patchApplied(p);
        break;
      case 'sub_agent_activity':
        if (p.kind === 'started' && typeof p.agent_thread_id === 'string') {
          // Fork copies re-emit spawn events — dedupe by child thread id.
          if (!this.seenThreads.has(p.agent_thread_id)) {
            this.seenThreads.add(p.agent_thread_id);
            if (typeof p.event_id === 'string') this.threadBySpawn.set(p.event_id, p.agent_thread_id);
          }
        }
        break;
      case 'error':
        if (this.turn) {
          this.turn.node.status = 'error';
          this.turn.errored = true;
          this.turn.responseText +=
            (this.turn.responseText ? '\n\n' : '') + `[error] ${cap(p.message ?? '', 500)}`;
        }
        this.pendingReason = 'after API error';
        break;
      case 'web_search_end':
        this.toolCall({
          callId: typeof p.call_id === 'string' ? p.call_id : `ws-${this.g.nodes.length}`,
          family: 'WebSearch',
          hint: typeof p.query === 'string' ? p.query : undefined,
          ts: obj.timestamp,
          input: p.query,
          instantOk: true,
        });
        break;
      // Redundant echoes and cosmetic events — known, deliberately unused.
      case 'context_compacted':
      case 'agent_reasoning':
      case 'item_completed':
      case 'thread_name_updated':
      case 'thread_settings_applied':
      case 'exec_command_end':
        break;
    }
    return 0;
  }

  item(obj, p) {
    const type = p?.type;
    if (typeof type !== 'string' || !KNOWN_ITEMS.has(type)) {
      tallyUnknownType(this.unknownTypes, typeof type === 'string' ? `response_item:${type}` : undefined);
      return 1;
    }
    switch (type) {
      // The response_item stream duplicates every prompt and assistant
      // message the event stream already carries — and its user role mixes in
      // AGENTS.md / IDE-context / <turn_aborted> injections. Skip; the event
      // stream is canonical.
      case 'message':
      case 'reasoning':
      case 'web_search_call':
      case 'tool_search_call':
      case 'tool_search_output':
        break;
      case 'function_call':
        this.functionCall(obj, p);
        break;
      case 'custom_tool_call':
        this.customToolCall(obj, p);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        this.toolOutput(obj, p);
        break;
      case 'agent_message':
        this.interAgentMessage(p);
        break;
    }
    return 0;
  }

  // ---- turns --------------------------------------------------------------

  startTurn(turnId, ts) {
    const id = `t:${turnId ?? `i${this.turnIndex}`}`;
    this.turnIndex++;
    this.narration = null;
    const node = this.node({
      id,
      kind: 'turn',
      label: '(turn)',
      status: 'completed',
      startedAt: ts,
      hasDetail: true,
    });
    this.chain(id);
    this.turn = {
      id,
      node,
      prompt: '',
      responseText: '',
      tokens: { input: 0, output: 0 },
      startTs: ts,
      endTs: ts,
      errored: false,
      // Old-format files (0.78/0.89) have no task events; turns started by a
      // prompt close at the next prompt or EOF, and ending unmarked is their
      // NORMAL shape, not the crashed-turn shape.
      implicit: turnId == null,
    };
  }

  userPrompt(message, ts) {
    const text = promptText(message);
    if (!text.trim()) return;
    // Old-format files have no task events: a prompt landing on a turn that
    // already has one CLOSES it (normally — the response boundary is the old
    // format's terminator) and starts the next.
    if (!this.turn || this.turn.prompt) {
      this.closeTurn({});
      this.startTurn(undefined, ts);
    }
    this.turn.prompt = text;
    this.turn.node.label = snippet(text) || '(empty prompt)';
    if (!this.title) this.title = text;
  }

  closeTurn({ crashed = false } = {}) {
    if (!this.turn) return;
    this.narration = null;
    const t = this.turn;
    if (crashed && !t.errored) t.node.status = 'error'; // ended with no terminal event
    if (t.tokens.input + t.tokens.output > 0) t.node.tokens = t.tokens;
    if (t.node.durationMs == null) t.node.durationMs = msBetween(t.startTs, t.endTs);
    if (t.endTs) t.node.endedAt = t.endTs;
    if (this.collect) {
      this.details.set(t.id, {
        kind: 'turn',
        prompt: cap(t.prompt, 8000),
        responseText: cap(t.responseText, 8000),
      });
    }
    this.turn = null;
  }

  humanInterrupt(obj) {
    const id = `h:${obj.payload?.turn_id ?? `i${this.turnIndex}`}:interrupt`;
    if (this.g.nodes.some((n) => n.id === id)) return;
    this.node({
      id,
      kind: 'human',
      label: 'interrupted',
      status: 'completed',
      interventionKind: 'interrupt',
      startedAt: obj.timestamp,
      hasDetail: true,
    });
    this.details.set(id, {
      kind: 'human',
      interventionKind: 'interrupt',
      context: '',
      answer: 'The user interrupted the turn.',
    });
    this.chain(id);
    this.pendingReason = 'after user interrupt';
  }

  // ---- tool calls ---------------------------------------------------------

  functionCall(obj, p) {
    this.toolCallCount++;
    const args = safeJson(p.arguments) ?? {};
    if (p.name === 'spawn_agent') {
      this.spawns.set(p.call_id, {
        callId: p.call_id,
        taskName: typeof args.task_name === 'string' ? args.task_name : 'agent',
        ts: obj.timestamp,
        fromNodeId: this.chainTip,
        turnId: this.turn?.id ?? null,
        failed: false,
      });
      this.pendingCalls.set(p.call_id, { kind: 'spawn', ts: obj.timestamp });
      this.narration = null;
      return;
    }
    if (p.name === 'request_user_input') {
      this.pendingCalls.set(p.call_id, { kind: 'question', ts: obj.timestamp, input: args });
      this.narration = null;
      return;
    }
    if (COLLAB_TOOLS.has(p.name)) {
      this.pendingCalls.set(p.call_id, { kind: 'collab', ts: obj.timestamp });
      return; // plumbing — the agent nodes tell this story
    }
    const family = SHELL_TOOLS.has(p.name) ? 'Shell' : p.name;
    const hint =
      typeof args.cmd === 'string'
        ? args.cmd
        : typeof args.command === 'string'
          ? args.command
          : p.name === 'update_plan'
            ? planHint(args)
            : typeof args.path === 'string'
              ? baseName(args.path)
              : undefined;
    this.toolCall({ callId: p.call_id, family, hint, ts: obj.timestamp, input: p.arguments });
    if (p.name === 'view_image' && typeof args.path === 'string') {
      this.attachFiles(this.pendingCalls.get(p.call_id)?.nodeId, [args.path]);
    }
  }

  customToolCall(obj, p) {
    this.toolCallCount++;
    const input = typeof p.input === 'string' ? p.input : '';
    let family;
    let hint;
    if (p.name === 'apply_patch') {
      family = 'Patch';
      hint = baseName(patchPaths(input, this.cwd)[0]);
    } else if (SHELL_TOOLS.has(p.name)) {
      family = 'Shell';
      hint = jsCmdHint(input) ?? (input.includes('apply_patch') ? 'apply patch' : undefined);
    } else {
      family = p.name;
    }
    this.toolCall({ callId: p.call_id, family, hint, ts: obj.timestamp, input });
    // Patches embedded in JS exec scripts name absolute paths; classic
    // apply_patch inputs are relative to the turn cwd. Both are attributed at
    // CALL time so a failed apply still shows what it was aimed at.
    const paths = patchPaths(input, this.cwd);
    if (paths.length) this.attachFiles(this.pendingCalls.get(p.call_id)?.nodeId, paths);
  }

  /** Create or extend a collapsed tool-group node. */
  toolCall({ callId, family, hint, ts, input, instantOk = false }) {
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    let nodeId;
    if (tip && tip.kind === 'tool' && this.toolNames.get(tip.id) === family) {
      tip.callCount += 1;
      nodeId = tip.id;
    } else {
      nodeId = `g:${callId}`;
      const label =
        typeof hint === 'string' && hint.trim() ? snippet(`${family} · ${hint}`, 40) : family;
      this.node({
        id: nodeId,
        kind: 'tool',
        label,
        status: instantOk ? 'completed' : 'running',
        callCount: 1,
        errorCount: 0,
        startedAt: ts,
        hasDetail: true,
      });
      this.toolNames.set(nodeId, family);
      if (this.collect) {
        this.details.set(nodeId, {
          kind: 'tool',
          name: family,
          ...(this.narration ? { context: cap(this.narration, 2000) } : {}),
          calls: [],
        });
      }
      this.chain(nodeId);
    }
    if (this.collect) {
      this.details.get(nodeId)?.calls.push({
        toolUseId: callId,
        input: cap(typeof input === 'string' ? input : JSON.stringify(input ?? ''), 3000),
        output: instantOk ? '' : null,
        isError: false,
        startedAt: ts,
      });
    }
    // Same `ts` as the detail call's startedAt, pushed in the same order, so
    // callOffsets[i] and calls[i].startedAt can never disagree. An instant
    // call (web_search_end is its own result) resolves at its own timestamp.
    const timing = { startTs: ts, endTs: instantOk ? ts : undefined };
    const times = this.toolTimes.get(nodeId);
    if (times) times.push(timing);
    else this.toolTimes.set(nodeId, [timing]);
    if (!instantOk) this.pendingCalls.set(callId, { kind: 'tool', family, nodeId, ts, timing });
    this.narration = null;
  }

  toolOutput(obj, p) {
    const rec = this.pendingCalls.get(p.call_id);
    if (!rec) return;
    this.pendingCalls.delete(p.call_id);
    const text = outputText(p.output);

    if (rec.kind === 'question') return this.questionAnswered(obj, p.call_id, rec, text);
    if (rec.kind === 'spawn') {
      const spawn = this.spawns.get(p.call_id);
      if (spawn && /spawn failed/i.test(text)) {
        spawn.failed = true;
        spawn.failure = snippet(text, 90);
      }
      return;
    }
    if (rec.kind === 'collab') return;

    const { isError, durationMs } = execVerdict(p.output, text);
    const group = this.g.nodes.find((n) => n.id === rec.nodeId);
    if (group) {
      if (isError) group.errorCount = (group.errorCount ?? 0) + 1;
      if (group.status !== 'error') group.status = 'completed';
    }
    // The output line IS the call's resolution — success, failure and a
    // refused command all arrive as one function_call_output, so there is no
    // separate denial path to time. A line without a timestamp resolves the
    // call but leaves it untimed, which withholds the group's endedAt.
    if (rec.timing) rec.timing.endTs = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
    if (this.collect) {
      const call = this.details.get(rec.nodeId)?.calls.find((c) => c.toolUseId === p.call_id);
      if (call) {
        call.isError = isError;
        call.output = cap(text, 4000);
        call.durationMs = durationMs ?? msBetween(rec.ts, obj.timestamp);
      }
    }
    if (isError) this.pendingReason = `after ${rec.family} error`;
  }

  questionAnswered(obj, callId, rec, text) {
    const parsed = safeJson(text);
    const answerText = parsed?.answers
      ? Object.values(parsed.answers)
          .map((a) => (Array.isArray(a?.answers) ? a.answers.join(', ') : String(a)))
          .join(' · ')
      : snippet(text, 70);
    const id = `h:${callId}`;
    this.node({
      id,
      kind: 'human',
      label: snippet(`answered: ${answerText}`, 70),
      status: 'completed',
      interventionKind: 'answer',
      startedAt: obj.timestamp,
      hasDetail: true,
    });
    this.details.set(id, {
      kind: 'human',
      interventionKind: 'answer',
      context: cap(
        (rec.input?.questions ?? []).map((q) => q?.header ?? q?.id ?? '').filter(Boolean).join('\n'),
        4000,
      ),
      answer: cap(answerText, 4000),
    });
    this.chain(id);
    this.pendingReason = `answer: ${snippet(answerText, 50)}`;
  }

  patchApplied(p) {
    const paths = p?.changes && typeof p.changes === 'object' ? Object.keys(p.changes) : [];
    const rec = this.pendingCalls.get(p.call_id);
    // JS-exec patches carry an `exec-<uuid>` call_id matching no call — fall
    // back to the open tool group, which is the script that applied it.
    const nodeId = rec?.nodeId ?? this.openToolGroupId();
    if (paths.length) this.attachFiles(nodeId, paths);
    if (p.success === false && !rec) {
      // Classic failures surface in the call output; only the JS-mode ones
      // would otherwise go unseen.
      const group = this.g.nodes.find((n) => n.id === nodeId);
      if (group) group.errorCount = (group.errorCount ?? 0) + 1;
    }
  }

  openToolGroupId() {
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    return tip?.kind === 'tool' ? tip.id : null;
  }

  attachFiles(nodeId, paths) {
    if (!nodeId || !paths?.length) return;
    this.toolFiles.set(nodeId, mergeFiles(this.toolFiles.get(nodeId), paths));
  }

  // ---- inter-agent messages ----------------------------------------------

  interAgentMessage(p) {
    const text = Array.isArray(p?.content)
      ? p.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : '';
    if (!text.startsWith('Message Type: FINAL_ANSWER')) return; // MESSAGE/NEW_TASK are encrypted
    const author = typeof p.author === 'string' ? p.author : '';
    const payload = text.split(/^Payload:\s*$/m)[1]?.trim() ?? '';
    if (author) this.finalAnswers.set(author, { text: payload, turnId: this.turn?.id ?? null });
  }

  // ---- finish -------------------------------------------------------------

  finish(live) {
    if (this.turn) {
      // The last turn never closed. Marker-format: running while live, an
      // error otherwise (the crashed-turn shape the quiet window exists to
      // catch). Implicit old-format turns end unmarked NORMALLY — 6 of the 7
      // corpus 0.78/0.89 files end cleanly at a response boundary — so one
      // that produced a response closes as completed.
      const endedCleanly = this.turn.implicit && this.turn.responseText;
      if (live && !this.turn.errored) this.turn.node.status = 'running';
      else if (!this.turn.errored && !endedCleanly) this.turn.node.status = 'error';
      this.closeTurn({});
    }
    for (const n of this.g.nodes) {
      if (n.kind === 'tool' && n.status === 'running' && !live) n.status = 'completed';
      if (n.kind === 'tool' && (n.errorCount ?? 0) > 0 && n.errorCount >= n.callCount)
        n.status = 'error';
      if (n.kind === 'tool' && n.callCount > 1) n.label = `${n.label} ×${n.callCount}`;
      if (n.kind === 'tool') groupTimings(n, this.toolTimes.get(n.id) ?? []);
      const files = this.toolFiles.get(n.id);
      if (files?.length) n.files = files;
    }
  }
}

/**
 * `callOffsets` and `endedAt` for one collapsed group, from the per-call
 * timings the builder tracked beside it. Both are withheld rather than
 * approximated — precision over recall, and the consumer treats a malformed
 * list as absent, which this must never lean on:
 * - callOffsets only on groups of 2+ calls (call 0 IS the node's start, so a
 *   `[0]` would be information-free bytes on most tool nodes), only when
 *   EVERY call is timed, only when the list is `[0, …]` non-decreasing with
 *   one entry per call. One untimed or out-of-order call → no list at all.
 * - endedAt only once EVERY call has a timed resolution (a live group carries
 *   none, exactly like a live turn), never earlier than startedAt. It is the
 *   source's own string for the latest resolution, not a re-serialisation.
 * - Deliberately NOT durationMs: the outlier signal reads durationMs, and
 *   handing ~40% of a session's nodes a duration would move a calibrated
 *   threshold as a side effect (spec §1; the signals snapshot pins this).
 */
function groupTimings(node, times) {
  const start = Date.parse(node.startedAt);
  if (!Number.isFinite(start) || times.length !== node.callCount) return;

  if (times.length >= 2) {
    const offsets = [];
    for (const t of times) {
      const ms = Date.parse(t.startTs) - start; // NaN for an untimed call
      const prev = offsets.length ? offsets[offsets.length - 1] : 0;
      if (!Number.isFinite(ms) || ms < prev) {
        offsets.length = 0;
        break;
      }
      offsets.push(ms);
    }
    if (offsets.length === times.length && offsets[0] === 0) node.callOffsets = offsets;
  }

  let lastMs = -Infinity;
  let lastTs;
  for (const t of times) {
    const ms = Date.parse(t.endTs);
    if (!Number.isFinite(ms)) return; // unresolved, or resolved untimed
    if (ms >= lastMs) {
      lastMs = ms;
      lastTs = t.endTs;
    }
  }
  if (lastMs >= start) node.endedAt = lastTs;
}

/** Materialize one spawned agent from its own rollout file. */
function materializeAgent(spawn, parsed, { g, details, b, live }) {
  const id = `a:${spawn.callId}`;
  const node = {
    id,
    kind: 'agent',
    label: snippet(spawn.taskName, 60) || 'agent',
    status: 'running',
    startedAt: spawn.ts,
    hasDetail: true,
  };
  if (spawn.threadId) node.agentId = spawn.threadId;
  g.nodes.push(node);
  b.edge('spawn', spawn.fromNodeId, id, { label: snippet(spawn.taskName, 90) });

  const detail = {
    kind: 'agent',
    prompt: `task ${spawn.taskName} (the task payload is encrypted at rest — Codex stores inter-agent traffic unreadably)`,
    result: null,
    transcript: parsed?.transcript ?? [],
  };

  // The child's FINAL_ANSWER back to this parent is the readable artifact
  // and the return edge. agent_path = parent path + "/" + task name.
  const final = [...b.finalAnswers.entries()].find(([path]) =>
    path.endsWith(`/${spawn.taskName}`),
  )?.[1];

  let terminal = null;
  if (spawn.failed) {
    terminal = 'error';
    detail.result = spawn.failure ?? 'spawn failed';
  } else if (final) {
    terminal = 'completed';
    detail.result = cap(final.text, 8000);
  } else if (parsed?.terminal) {
    terminal = parsed.terminal;
  }

  if (parsed) {
    if (parsed.tokens.input + parsed.tokens.output > 0) node.tokens = parsed.tokens;
    if (parsed.startedAt) node.startedAt = parsed.startedAt;
    if (parsed.durationMs != null) node.durationMs = parsed.durationMs;
    if (parsed.model) node.model = parsed.model;
    if (parsed.files.length) node.files = parsed.files;
    detail.result ??= parsed.finalText ? cap(parsed.finalText, 8000) : null;
    if (parsed.nickname || parsed.agentPath || parsed.depth != null) {
      node.ext = {
        codex: {
          ...(parsed.nickname ? { nickname: parsed.nickname } : {}),
          ...(parsed.agentPath ? { agentPath: parsed.agentPath } : {}),
          ...(parsed.depth != null ? { depth: parsed.depth } : {}),
        },
      };
    }
  } else if (!spawn.failed) {
    node.ext = { transcriptMissing: true };
    detail.result = detail.result ?? '(subagent rollout not found)';
    // A rollout nobody opened contributes to neither counter — without this,
    // an entirely unreadable subagent would still score 100%.
    g.meta.coverage.sourcesUnread++;
  }

  node.status = terminal ?? (live ? 'running' : 'error');
  if (terminal) {
    const resultText = final?.text ?? parsed?.finalText;
    b.edge('return', id, final?.turnId ?? spawn.turnId ?? spawn.fromNodeId, {
      label: resultText ? snippet(resultText, 90) : undefined,
      ...(terminal === 'error' ? { reason: 'agent failed' } : {}),
    });
  }
  details.set(id, detail);
}

/**
 * Stream one subagent rollout for the parent's agent node.
 *
 * Fork-inherited history is physically copied into child files — but
 * RE-STAMPED at fork time (verified on real 0.144.x children: the parent's
 * session_meta lands 1ms after line 1, the inherited turn a few ms later),
 * so a timestamp filter cannot separate it. The cut is structural instead:
 * inherited mode begins at the second session_meta (the parent's, embedded
 * ancestor-chain style) and ends at the NEW_TASK delivery — the first
 * `inter_agent_communication_metadata` / inter-agent `agent_message` line —
 * which is the reason the child exists and, in every observed child, the
 * first such line in the file. Config lines (turn_context) are honored in
 * either mode; they carry cwd/model, not attribution.
 */
export async function parseChildRollout(file, { collectTranscript = false } = {}) {
  const out = {
    tokens: { input: 0, output: 0 },
    files: [],
    terminal: null,
    finalText: null,
    transcript: [],
    model: undefined,
    nickname: undefined,
    agentPath: undefined,
    depth: undefined,
    startedAt: undefined,
    endedAt: undefined,
    durationMs: undefined,
    toolCalls: 0,
    unrecognized: 0,
    records: 0,
    unknownTypes: {},
    // The child's OWN spawns — depth-2 agents live in their own rollouts and
    // would otherwise be invisible everywhere.
    spawns: [],
    threadBySpawn: new Map(),
  };
  let ownId = null;
  let inherited = false;
  let cwd;
  let lastEvent = null;
  let first = true;
  const seenThreads = new Set();
  const badLineNos = [];
  let maxLineNo = 0;

  for await (const { obj, lineNo } of readJsonLines(file, {
    onBadLine: (_line, n) => badLineNos.push(n),
  })) {
    maxLineNo = Math.max(maxLineNo, lineNo);
    out.records++;
    if (typeof obj?.type !== 'string' || !KNOWN_TYPES.has(obj.type)) {
      out.unrecognized++;
      tallyUnknownType(out.unknownTypes, obj?.type);
      continue;
    }
    if (first) {
      first = false;
      const meta = obj.type === 'session_meta' ? obj.payload : null;
      ownId = meta?.id ?? null;
      const spawnMeta = meta?.source?.subagent?.thread_spawn;
      out.nickname = meta?.agent_nickname ?? spawnMeta?.agent_nickname;
      out.agentPath = meta?.agent_path ?? spawnMeta?.agent_path;
      out.depth = spawnMeta?.depth;
      if (typeof meta?.cwd === 'string') cwd = meta.cwd;
      continue;
    }

    const p = obj.payload;
    // A session_meta that is not ours → the fork-inherited block begins.
    if (obj.type === 'session_meta') {
      if (p?.id !== ownId) inherited = true;
      continue;
    }
    // The NEW_TASK delivery ends it: the child's own story starts here.
    if (
      obj.type === 'inter_agent_communication_metadata' ||
      (obj.type === 'response_item' && p?.type === 'agent_message')
    ) {
      inherited = false;
    }

    if (obj.type === 'turn_context') {
      if (typeof p?.cwd === 'string') cwd = p.cwd;
      if (typeof p?.model === 'string') out.model ??= p.model;
      continue;
    }
    if (inherited) continue;

    if (typeof obj.timestamp === 'string') {
      out.startedAt ??= obj.timestamp;
      out.endedAt = obj.timestamp;
    }

    if (obj.type === 'response_item' && p?.type === 'function_call' && p.name === 'spawn_agent') {
      const args = safeJson(p.arguments) ?? {};
      out.spawns.push({
        callId: p.call_id,
        taskName: typeof args.task_name === 'string' ? args.task_name : 'agent',
        ts: obj.timestamp,
      });
    }

    if (obj.type === 'event_msg') {
      if (p?.type === 'sub_agent_activity' && p.kind === 'started' && typeof p.agent_thread_id === 'string') {
        if (!seenThreads.has(p.agent_thread_id)) {
          seenThreads.add(p.agent_thread_id);
          if (typeof p.event_id === 'string') out.threadBySpawn.set(p.event_id, p.agent_thread_id);
        }
      }
      switch (p?.type) {
        case 'task_complete':
          lastEvent = 'complete';
          if (typeof p.last_agent_message === 'string') out.finalText = p.last_agent_message;
          break;
        case 'turn_aborted':
          lastEvent = 'aborted';
          break;
        case 'task_started':
          lastEvent = 'started';
          break;
        case 'error':
          lastEvent = 'error';
          break;
        case 'user_message':
          if (collectTranscript) {
            push(out.transcript, { role: 'user', text: cap(promptText(p.message), 1500) });
          }
          break;
        case 'agent_message':
          if (typeof p.message === 'string' && p.message.trim()) {
            if (p.phase === 'final_answer') out.finalText = p.message;
            if (collectTranscript) push(out.transcript, { role: 'assistant', text: cap(p.message, 1500) });
          }
          break;
        case 'token_count':
          if (p.info?.total_token_usage) {
            out.tokens = {
              input: p.info.total_token_usage.input_tokens ?? 0,
              output: p.info.total_token_usage.output_tokens ?? 0,
            };
          }
          break;
        case 'patch_apply_end':
          if (p.changes && typeof p.changes === 'object') {
            out.files = mergeFiles(out.files, Object.keys(p.changes));
          }
          break;
      }
    } else if (obj.type === 'response_item') {
      const type = p?.type;
      if (type === 'function_call' || type === 'custom_tool_call') {
        out.toolCalls++;
        const input = typeof p.input === 'string' ? p.input : (p.arguments ?? '');
        const paths = patchPaths(typeof input === 'string' ? input : '', cwd);
        if (paths.length) out.files = mergeFiles(out.files, paths);
        if (collectTranscript) {
          push(out.transcript, {
            role: 'assistant',
            toolName: p.name ?? type,
            text: cap(typeof input === 'string' ? input : JSON.stringify(input), 600),
          });
        }
      }
    }
  }

  maxLineNo = Math.max(maxLineNo, ...badLineNos, 0);
  out.records += badLineNos.length;
  const badMid = badLineNos.filter((n) => n !== maxLineNo);
  out.unrecognized += badMid.length;
  for (let i = 0; i < badMid.length; i++) tallyUnknownType(out.unknownTypes, undefined);
  out.durationMs = msBetween(out.startedAt, out.endedAt);
  out.terminal =
    lastEvent === 'complete' ? 'completed' : lastEvent === 'aborted' || lastEvent === 'error' ? 'error' : null;
  return out;
}

const MAX_TRANSCRIPT_ENTRIES = 300;
function push(arr, entry) {
  if (arr.length < MAX_TRANSCRIPT_ENTRIES) arr.push(entry);
}

// ----------------------------------------------------------------- helpers

function safeJson(text) {
  if (typeof text !== 'string') return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tool output text. Corpus census (3,727 / 534 / 118 of 4,379): a REAL JSON
 * array of content parts (the dominant 0.144.x JS-exec shape), a plain
 * string, or a JSON-object string with output+metadata — plus, tolerated,
 * the array serialized as a string.
 */
function outputText(output) {
  if (Array.isArray(output)) {
    return output.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  if (typeof output !== 'string') return '';
  const parsed = safeJson(output);
  if (Array.isArray(parsed)) {
    return parsed.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  if (parsed && typeof parsed.output === 'string') return parsed.output;
  return output;
}

/**
 * Error + duration verdict for an exec-ish output. Exit codes live in the
 * output TEXT (`Process exited with code N` / `Exit code: N`) except the one
 * custom generation with `metadata.exit_code`. Exit 130 is a SIGINT — the
 * user's interrupt, not the tool failing; the interrupt node says the true
 * thing, so it does not count as an error here.
 */
export function execVerdict(rawOutput, text) {
  let exit = null;
  const meta = safeJson(rawOutput);
  if (Number.isFinite(meta?.metadata?.exit_code)) exit = meta.metadata.exit_code;
  if (exit === null) {
    const m = text.match(/(?:Process exited with code|Exit code:)\s+(\d+)/);
    if (m) exit = Number(m[1]);
  }
  const failedPatch = /apply_patch verification failed/.test(text);
  const isError = failedPatch || (exit !== null && exit !== 0 && exit !== 130);
  let durationMs;
  const meta2 = meta?.metadata;
  if (Number.isFinite(meta2?.duration_seconds)) durationMs = Math.round(meta2.duration_seconds * 1000);
  else {
    const w = text.match(/Wall time:?\s+([\d.]+) seconds/);
    if (w) durationMs = Math.round(Number(w[1]) * 1000);
  }
  return { isError, durationMs };
}

/**
 * File paths named by a patch envelope — classic inputs are relative to the
 * turn cwd, JS-embedded ones absolute. Both roads end in absolute paths so
 * the files lane and `find_nodes` see one spelling.
 */
export function patchPaths(input, cwd) {
  if (typeof input !== 'string' || !input.includes('*** ')) return [];
  const out = [];
  // Inside JS scripts the envelope newlines are literal \n; accept both.
  const re = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g;
  for (const m of input.matchAll(re)) {
    const raw = m[1].trim();
    if (!raw || raw.length > 512) continue;
    const abs = isAbsolute(raw) ? raw : cwd ? join(cwd, raw) : raw;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** First `cmd:`/`cmd =` string inside a JS unified-exec script. */
function jsCmdHint(input) {
  const m = input.match(/\bcmd:\s*(?:"((?:[^"\\]|\\.)*)"|`([^`\n]*)`|'((?:[^'\\]|\\.)*)')/);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  return raw ? raw.replace(/\\n[\s\S]*$/, '').replace(/\\(["'`\\])/g, '$1') : undefined;
}

function planHint(args) {
  const steps = Array.isArray(args?.plan) ? args.plan : [];
  const active = steps.find((s) => s?.status === 'in_progress') ?? steps[0];
  return typeof active?.step === 'string' ? active.step : `${steps.length} steps`;
}

function baseName(p) {
  if (typeof p !== 'string' || !p) return undefined;
  return p.split(/[\\/]/).filter(Boolean).pop();
}
