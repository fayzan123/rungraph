import { join } from 'node:path';
import { emptyGraph, snippet } from '../../ir.js';
import { readJsonLines, statOrNull } from '../../util.js';
import { parseWorkflowRun, readManifest, parseAgentFile } from './workflow.js';
import { runStats } from './detect.js';
import {
  KNOWN_MAIN_TYPES,
  INTERRUPT_TEXTS,
  contentText,
  isPromptLine,
  promptLabel,
  parseTaskNotification,
  toolNodeLabel,
  UsageTally,
  cap,
  stripAnsi,
  msBetween,
  SESSION_QUIET_MS,
} from './helpers.js';

/**
 * parse(RunRef) → { ir, details }
 * Pure: reads only the run's own files. Unknown lines are counted, never fatal.
 *
 * @param {import('./detect.js').RunRef} ref
 * @param {{ collectDetails?: boolean }} [opts]
 */
export async function parse(ref, opts = {}) {
  if (ref.kind === 'workflow') return parseWorkflowRun(ref, opts);
  return parseSession(ref, opts);
}

async function parseSession(ref, opts) {
  const collect = opts.collectDetails ?? false;
  // Liveness comes from a FRESH stat of the run's whole file set — never
  // from the RunRef, which a long-lived watcher holds frozen.
  const { maxMtimeMs } = await runStats(ref);
  const live = Date.now() - maxMtimeMs < SESSION_QUIET_MS;
  const g = emptyGraph({
    runId: ref.runId,
    adapter: ref.adapter,
    kind: 'session',
    title: ref.title,
  });
  const details = new Map();

  let unrecognized = 0;
  const badLineNos = [];
  let maxLineNo = 0;
  const lines = [];
  for await (const { obj, lineNo } of readJsonLines(ref.sessionFile, {
    onBadLine: (_line, n) => badLineNos.push(n),
  })) {
    maxLineNo = Math.max(maxLineNo, lineNo);
    if (typeof obj?.type !== 'string' || !KNOWN_MAIN_TYPES.has(obj.type)) {
      unrecognized++;
      continue;
    }
    lines.push(obj);
  }
  // A malformed FINAL line is a mid-write truncation (normal during live
  // tail) — tolerated, retried next tick, never shown as format drift.
  maxLineNo = Math.max(maxLineNo, ...badLineNos, 0);
  unrecognized += badLineNos.filter((n) => n !== maxLineNo).length;

  // ---- pass 1: titles, notifications, timestamps -------------------------
  let aiTitle, agentName, lastPrompt;
  /** taskId → { status, summary, result, lineIdx } (last one wins; agents resume) */
  const notifications = new Map();
  let firstTs, lastTs;
  lines.forEach((obj, idx) => {
    if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle;
    else if (obj.type === 'agent-name' && obj.agentName) agentName = obj.agentName;
    else if (obj.type === 'last-prompt' && obj.lastPrompt) lastPrompt = obj.lastPrompt;
    if (typeof obj.timestamp === 'string') {
      firstTs ??= obj.timestamp;
      lastTs = obj.timestamp;
    }
    const text =
      obj.type === 'queue-operation' && obj.operation === 'enqueue'
        ? obj.content
        : obj.type === 'user' && typeof obj.message?.content === 'string'
          ? obj.message.content
          : null;
    const n = text ? parseTaskNotification(text) : null;
    if (n?.status) notifications.set(n.taskId, { ...n, lineIdx: idx });
  });
  g.meta.title = snippet(aiTitle ?? agentName ?? lastPrompt ?? ref.title, 100) || ref.title;
  if (firstTs) g.meta.startedAt = firstTs;
  if (lastTs && !live) g.meta.endedAt = lastTs;

  // ---- pass 2: walk the conversation, build the graph --------------------
  const b = new GraphBuilder(g, details, collect);
  for (let i = 0; i < lines.length; i++) {
    const obj = lines[i];
    if (obj.type === 'user') b.userLine(obj, i);
    else if (obj.type === 'assistant') b.assistantLine(obj, i);
    else if (obj.type === 'system' && obj.subtype === 'turn_duration') b.turnDuration(obj);
  }
  b.finish(live);

  // ---- agents: parse their transcripts for status/tokens/details ---------
  const subagentsDir = join(ref.projectDir, ref.sessionId, 'subagents');
  for (const spawn of b.agentSpawns.values()) {
    await materializeAgent(spawn, { g, details, collect, subagentsDir, notifications, b, live });
  }
  for (const spawn of b.workflowSpawns.values()) {
    await materializeWorkflow(spawn, { ref, g, details, notifications, b, live });
  }

  g.meta.unrecognizedLineCount = unrecognized;
  g.meta.totals = {
    tokens: sumTokens(g, b),
    toolCalls: b.toolCallCount,
    agents: g.nodes.filter((n) => n.kind === 'agent').length,
  };
  return { ir: g, details };
}

function sumTokens(g, b) {
  const own = b.sessionUsage.outputOnlyTotals();
  let t = own.input + own.output;
  for (const n of g.nodes) {
    if ((n.kind === 'agent' || n.kind === 'workflow') && n.tokens) {
      t += n.tokens.input + n.tokens.output;
    }
  }
  return t;
}

/** Builds turn/tool/human nodes and the sequence chain for one session. */
class GraphBuilder {
  constructor(g, details, collect) {
    this.g = g;
    this.details = details;
    this.collect = collect;
    this.turn = null; // { id, promptText, responseText, usage, errored, lastLineIdx }
    this.turnStarts = []; // [{ lineIdx, turnId }]
    this.chainTip = null; // node id the next sequence edge hangs from
    this.pendingReason = null; // decision lineage for the next sequence edge
    this.pendingToolUse = new Map(); // tool_use_id → record
    this.agentSpawns = new Map(); // tool_use_id → spawn record
    this.workflowSpawns = new Map(); // tool_use_id → spawn record
    this.sessionUsage = new UsageTally();
    this.toolCallCount = 0;
    this.lastHumanNodeId = null;
    this.toolNames = new Map(); // tool node id → plain tool name (labels are descriptive)
    this.narration = null; // assistant text since the last tool call, this turn
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

  // ---- user lines --------------------------------------------------------

  userLine(obj, idx) {
    const content = obj.message?.content;

    if (isPromptLine(obj)) return this.startTurn(obj, idx);

    if (obj.toolDenialKind === 'user-rejected') return this.humanDenial(obj);

    if (Array.isArray(content)) {
      const text = contentText(content).trim();
      if (INTERRUPT_TEXTS.has(text)) return this.humanInterrupt(obj, text);
      const tr = content.find((x) => x?.type === 'tool_result');
      if (tr) return this.toolResult(obj, tr, idx);
    }
  }

  startTurn(obj, idx) {
    this.closeTurn();
    this.narration = null;
    const id = `t:${obj.uuid}`;
    const label = snippet(promptLabel(obj)) || '(empty prompt)';
    const n = this.node({
      id,
      kind: 'turn',
      label,
      status: 'completed',
      startedAt: obj.timestamp,
      hasDetail: true,
    });
    this.chain(id);
    this.turn = {
      id,
      node: n,
      promptText: promptLabel(obj),
      responseText: '',
      usage: new UsageTally(),
      errored: false,
      startTs: obj.timestamp,
      endTs: obj.timestamp,
    };
    this.turnStarts.push({ lineIdx: idx, turnId: id });
  }

  humanDenial(obj) {
    const tr = Array.isArray(obj.message?.content)
      ? obj.message.content.find((x) => x?.type === 'tool_result')
      : null;
    const tu = tr ? this.pendingToolUse.get(tr.tool_use_id) : null;
    const what = tu?.name ?? 'tool use';
    if (tu?.kind === 'agent' || tu?.kind === 'workflow' || tu?.kind === 'question') {
      // A denied spawn never ran — the human "denied" node tells the story;
      // don't materialize a phantom agent/workflow node for it.
      this.agentSpawns.delete(tr.tool_use_id);
      this.workflowSpawns.delete(tr.tool_use_id);
      this.pendingToolUse.delete(tr.tool_use_id);
    }
    if (tu?.kind === 'tool' && tu.nodeId) {
      const group = this.g.nodes.find((n) => n.id === tu.nodeId);
      if (group) group.errorCount = (group.errorCount ?? 0) + 1;
      const call = this.details.get(tu.nodeId)?.calls.find((c) => c.toolUseId === tr.tool_use_id);
      if (call) {
        call.isError = true;
        call.output = '(rejected by user)';
      }
      this.pendingToolUse.delete(tr.tool_use_id);
    }
    // Consecutive denials (parallel batch) collapse into one human node.
    if (this.lastHumanNodeId && this.chainTip === this.lastHumanNodeId) {
      const prev = this.g.nodes.find((n) => n.id === this.lastHumanNodeId);
      if (prev?.interventionKind === 'denial') {
        prev.label = snippet(prev.label.replace(/^denied /, 'denied ') + `, ${what}`, 60);
        return;
      }
    }
    const id = `h:${obj.uuid}`;
    this.node({
      id,
      kind: 'human',
      label: `denied ${what}`,
      status: 'completed',
      interventionKind: 'denial',
      startedAt: obj.timestamp,
      hasDetail: true,
    });
    this.details.set(id, {
      kind: 'human',
      interventionKind: 'denial',
      context: tu ? cap(JSON.stringify(tu.input, null, 2), 3000) : '',
      answer: `The user rejected the ${what} call.`,
    });
    this.chain(id);
    this.lastHumanNodeId = id;
    this.pendingReason = 'after permission denial';
  }

  humanInterrupt(obj, text) {
    // The "for tool use" marker right after a denial is part of the same event.
    if (text === '[Request interrupted by user for tool use]' && this.lastHumanNodeId) {
      const prev = this.g.nodes.find((n) => n.id === this.lastHumanNodeId);
      if (prev?.interventionKind === 'denial' && this.chainTip === prev.id) return;
    }
    const id = `h:${obj.uuid}`;
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
      answer: 'The user interrupted the assistant mid-turn.',
    });
    this.chain(id);
    this.lastHumanNodeId = id;
    this.pendingReason = 'after user interrupt';
  }

  toolResult(obj, tr, idx) {
    const tu = this.pendingToolUse.get(tr.tool_use_id);
    if (!tu) return;
    this.pendingToolUse.delete(tr.tool_use_id);
    const tur = obj.toolUseResult;

    if (tu.kind === 'question') {
      // AskUserQuestion answered — a human course-change moment.
      const answers =
        tur && typeof tur === 'object' && !Array.isArray(tur) ? tur.answers : null;
      const answerText = answers
        ? Object.entries(answers)
            .map(([q, a]) => `${a}`)
            .join(' · ')
        : contentText(tr.content);
      const id = `h:${obj.uuid}`;
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
          (tu.input?.questions ?? []).map((q) => q.question).join('\n\n'),
          4000,
        ),
        answer: cap(
          answers
            ? Object.entries(answers)
                .map(([q, a]) => `Q: ${q}\nA: ${a}`)
                .join('\n\n')
            : contentText(tr.content),
          4000,
        ),
      });
      this.chain(id);
      this.lastHumanNodeId = id;
      this.pendingReason = `answer: ${snippet(answerText, 50)}`;
      return;
    }

    if (tu.kind === 'agent') {
      const spawn = this.agentSpawns.get(tr.tool_use_id);
      if (spawn) {
        spawn.result = tur && typeof tur === 'object' && !Array.isArray(tur) ? tur : null;
        spawn.resultTurnId = this.turn?.id ?? spawn.fromNodeId;
      }
      return;
    }

    if (tu.kind === 'workflow') {
      const spawn = this.workflowSpawns.get(tr.tool_use_id);
      if (spawn) {
        spawn.result = tur && typeof tur === 'object' && !Array.isArray(tur) ? tur : null;
      }
      return;
    }

    // Regular tool call result → attach to its tool group node.
    const isError =
      tr.is_error === true ||
      (typeof tur === 'string' && /^(Error|InputValidationError)/.test(tur));
    const group = this.g.nodes.find((n) => n.id === tu.nodeId);
    if (group) {
      if (isError) group.errorCount = (group.errorCount ?? 0) + 1;
      if (group.status !== 'error') group.status = 'completed';
    }
    if (this.collect) {
      const d = this.details.get(tu.nodeId);
      const call = d?.calls.find((c) => c.toolUseId === tr.tool_use_id);
      if (call) {
        call.isError = isError;
        call.output = cap(
          stripAnsi(
            typeof tur === 'string'
              ? tur
              : contentText(tr.content) || JSON.stringify(summarizeResult(tur))?.slice(0, 4000) || '',
          ),
          4000,
        );
        call.durationMs = msBetween(tu.ts, obj.timestamp);
      }
    }
    if (isError) this.pendingReason = `after ${tu.name} error`;
  }

  // ---- assistant lines ---------------------------------------------------

  assistantLine(obj, idx) {
    const msg = obj.message;
    if (!msg) return;
    if (this.turn) {
      this.turn.endTs = obj.timestamp ?? this.turn.endTs;
      this.turn.usage.add(msg);
    }
    this.sessionUsage.add(msg);

    if (obj.isApiErrorMessage || msg.model === '<synthetic>') {
      if (this.turn) {
        this.turn.errored = true;
        this.turn.node.status = 'error';
      }
      return;
    }
    if (msg.stop_reason === 'refusal' && this.turn) {
      this.turn.errored = true;
      this.turn.node.status = 'error';
    }

    const block = Array.isArray(msg.content) ? msg.content[0] : null;
    if (!block) return;

    if (block.type === 'text' && typeof block.text === 'string') {
      if (this.turn) {
        this.turn.responseText += (this.turn.responseText ? '\n\n' : '') + block.text;
      }
      if (block.text.trim()) this.narration = block.text;
    }

    if (block.type !== 'tool_use') return;
    this.toolCallCount++;
    const rec = {
      name: block.name,
      input: block.input,
      assistantUuid: obj.uuid,
      ts: obj.timestamp,
      kind: 'tool',
      nodeId: null,
    };

    if (block.name === 'Agent') {
      rec.kind = 'agent';
      this.agentSpawns.set(block.id, {
        toolUseId: block.id,
        input: block.input,
        ts: obj.timestamp,
        fromNodeId: this.chainTip,
        turnId: this.turn?.id,
        result: null,
        resultTurnId: null,
      });
    } else if (block.name === 'Workflow') {
      rec.kind = 'workflow';
      this.workflowSpawns.set(block.id, {
        toolUseId: block.id,
        input: block.input,
        ts: obj.timestamp,
        fromNodeId: this.chainTip,
        result: null,
      });
    } else if (block.name === 'AskUserQuestion') {
      rec.kind = 'question';
    } else {
      // Consecutive same-tool calls collapse into one node (anti-hairball).
      // Labels are descriptive ("Bash · npm test"), so match on the recorded
      // plain tool name, not the label.
      const tip = this.g.nodes.find((n) => n.id === this.chainTip);
      if (tip && tip.kind === 'tool' && this.toolNames.get(tip.id) === block.name) {
        tip.callCount += 1;
        rec.nodeId = tip.id;
      } else {
        const id = `g:${block.id}`;
        this.node({
          id,
          kind: 'tool',
          label: toolNodeLabel(block.name, block.input),
          status: 'running',
          callCount: 1,
          errorCount: 0,
          startedAt: obj.timestamp,
          hasDetail: true,
        });
        this.toolNames.set(id, block.name);
        if (this.collect) {
          // "why" context: the assistant narration immediately before this
          // group's first call ("Now I'll run the tests to check X").
          this.details.set(id, {
            kind: 'tool',
            name: block.name,
            ...(this.narration ? { context: cap(this.narration, 2000) } : {}),
            calls: [],
          });
        }
        this.chain(id);
        rec.nodeId = id;
      }
      if (this.collect) {
        this.details.get(rec.nodeId)?.calls.push({
          toolUseId: block.id,
          input: cap(JSON.stringify(block.input, null, 2), 3000),
          output: null,
          isError: false,
          startedAt: obj.timestamp,
        });
      }
    }
    // Any tool call consumes the pending narration — it was "immediately
    // before" only the very next call.
    this.narration = null;
    this.pendingToolUse.set(block.id, rec);
  }

  turnDuration(obj) {
    if (this.turn) {
      this.turn.node.durationMs = obj.durationMs;
      this.closeTurn();
    }
  }

  closeTurn() {
    if (!this.turn) return;
    // Narration is "same turn" by definition — a turn's sign-off text must
    // not become the why-context of a continuation tool call (e.g. after a
    // task notification arrives without a new human prompt).
    this.narration = null;
    const t = this.turn;
    const tokens = t.usage.outputOnlyTotals();
    if (tokens.input + tokens.output > 0) t.node.tokens = tokens;
    if (!t.node.durationMs) t.node.durationMs = msBetween(t.startTs, t.endTs);
    if (t.endTs) t.node.endedAt = t.endTs;
    if (this.collect) {
      this.details.set(t.id, {
        kind: 'turn',
        prompt: cap(t.promptText, 8000),
        responseText: cap(t.responseText, 8000),
      });
    }
    this.turn = null;
  }

  finish(live) {
    // Trailing tool groups with no result yet.
    for (const rec of this.pendingToolUse.values()) {
      if (rec.kind === 'tool' && rec.nodeId) {
        const n = this.g.nodes.find((x) => x.id === rec.nodeId);
        if (n && n.status === 'running' && !live) n.status = 'completed';
      }
    }
    // Last turn may still be in flight.
    if (this.turn) {
      if (live && !this.turn.errored) this.turn.node.status = 'running';
      this.closeTurn();
    }
    for (const n of this.g.nodes) {
      if (n.kind === 'tool' && n.status === 'running' && !live) n.status = 'completed';
      if (n.kind === 'tool' && (n.errorCount ?? 0) > 0 && n.errorCount >= n.callCount)
        n.status = 'error';
      if (n.kind === 'tool' && n.callCount > 1) n.label = `${n.label} ×${n.callCount}`;
    }
  }

  /** Which turn was active at a given line index (for async return edges). */
  turnAt(lineIdx) {
    let cur = null;
    for (const t of this.turnStarts) {
      if (t.lineIdx <= lineIdx) cur = t.turnId;
      else break;
    }
    return cur;
  }
}

function summarizeResult(tur) {
  if (!tur || typeof tur !== 'object') return tur;
  if (Array.isArray(tur)) return contentText(tur);
  const { stdout, stderr, content, result, ...rest } = tur;
  return {
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(typeof result === 'string' ? { result } : {}),
    ...rest,
  };
}

// ---- agent + workflow node materialization -------------------------------

async function materializeAgent(spawn, ctx) {
  const { g, details, collect, subagentsDir, notifications, b, live } = ctx;
  const input = spawn.input ?? {};
  const syncDone = spawn.result?.status === 'completed';
  const agentId = spawn.result?.agentId;
  // Id from the spawning tool_use — known from the first parse and stable
  // across incremental re-parses (SSE deltas merge by id).
  const id = `a:${spawn.toolUseId}`;
  const label = snippet(input.description ?? input.prompt ?? 'agent', 60) || 'agent';

  const node = {
    id,
    kind: 'agent',
    label,
    status: 'running',
    startedAt: spawn.ts,
    hasDetail: true,
  };
  if (agentId) node.agentId = agentId;
  if (spawn.result?.resolvedModel) node.model = spawn.result.resolvedModel;
  g.nodes.push(node);

  b.edge('spawn', spawn.fromNodeId, id, { label: snippet(input.prompt ?? '', 90) });

  const detail = {
    kind: 'agent',
    prompt: cap(input.prompt ?? '', 8000),
    result: null,
    transcript: [],
  };

  const notif = agentId ? notifications.get(agentId) : undefined;
  let resultText = null;
  let returnTurnId = spawn.resultTurnId;
  let terminal = null; // 'completed' | 'error' — only with actual evidence

  if (syncDone) {
    terminal = 'completed';
    node.durationMs = spawn.result.totalDurationMs;
    if (spawn.result.usage) {
      node.tokens = {
        input: spawn.result.usage.input_tokens ?? 0,
        output: spawn.result.usage.output_tokens ?? 0,
      };
    }
    resultText = contentText(spawn.result.content ?? []) || null;
  } else if (notif && notif.status !== 'running') {
    terminal = notif.status === 'completed' ? 'completed' : 'error';
    returnTurnId = b.turnAt(notif.lineIdx);
    resultText = notif.result ?? null;
    if (notif.status === 'killed' || notif.status === 'failed') {
      detail.result = notif.summary ?? null;
    }
  }

  // Enrich from the agent's own transcript (tokens, timing, transcript, status).
  const file = agentId ? join(subagentsDir, `agent-${agentId}.jsonl`) : null;
  const st = file ? await statOrNull(file) : null;
  if (st) {
    const parsed = await parseAgentFile(file, { collectTranscript: collect });
    if (parsed.tokens.input + parsed.tokens.output > 0) node.tokens = parsed.tokens;
    if (parsed.startedAt) node.startedAt = parsed.startedAt;
    if (parsed.durationMs != null && node.durationMs == null) node.durationMs = parsed.durationMs;
    if (parsed.model && !node.model) node.model = parsed.model;
    terminal ??= parsed.terminal;
    detail.transcript = parsed.transcript;
    resultText ??= parsed.finalText;
    g.meta.unrecognizedLineCount += parsed.unrecognized;
  } else if (agentId) {
    // Referenced but missing transcript → placeholder, never a crash.
    node.ext = { ...(node.ext ?? {}), transcriptMissing: true };
    detail.result = detail.result ?? '(transcript unavailable)';
  }

  // No terminal evidence: still running while the session is live; a dead
  // session with an unresolved agent is an error, but with no phantom
  // "failed" return edge (we don't actually know how it ended).
  node.status = terminal ?? (live ? 'running' : 'error');

  if (resultText) detail.result = cap(resultText, 8000);
  if (terminal) {
    b.edge('return', id, returnTurnId ?? spawn.turnId ?? spawn.fromNodeId, {
      label: resultText ? snippet(resultText, 90) : undefined,
      ...(terminal === 'error' ? { reason: 'agent failed' } : {}),
    });
  }
  details.set(id, detail);
}

async function materializeWorkflow(spawn, ctx) {
  const { ref, g, details, notifications, b, live } = ctx;
  const tur = spawn.result;
  const wfId = tur?.runId;
  // Id from the spawning tool_use — stable from the very first parse, before
  // the tool_result carrying the wf runId has even been written.
  const id = `w:${spawn.toolUseId}`;
  const name = tur?.workflowName ?? metaNameFromScript(spawn.input) ?? 'workflow';

  // A resumed workflow (resumeFromRunId) reuses the same wf_ runId — merge
  // into the node of the original launch instead of duplicating the run.
  const existing =
    wfId && g.nodes.find((n) => n.kind === 'workflow' && n.runRef === `${ref.runId}:${wfId}`);
  if (existing) {
    b.edge('spawn', spawn.fromNodeId, existing.id, {
      label: 'resumed',
      reason: 'resumed after failure',
    });
    return;
  }

  const node = {
    id,
    kind: 'workflow',
    label: snippet(name, 60),
    status: 'running',
    startedAt: spawn.ts,
    hasDetail: true,
  };
  if (wfId) node.runRef = `${ref.runId}:${wfId}`;
  g.nodes.push(node);
  b.edge('spawn', spawn.fromNodeId, id, { label: snippet(tur?.summary ?? '', 90) });

  const detail = { kind: 'workflow', wfId: wfId ?? null, returnValue: null };
  const notif = tur?.taskId ? notifications.get(tur.taskId) : undefined;
  let returnTurnId = null;

  // Manifest (written at session level when the run finishes) is authoritative.
  const manifest = wfId ? await readManifest(ref.projectDir, ref.sessionId, wfId) : null;
  if (manifest) {
    node.status = manifest.status === 'failed' ? 'error' : 'completed';
    node.durationMs = manifest.durationMs;
    if (manifest.totalTokens) node.tokens = { input: 0, output: manifest.totalTokens };
    detail.returnValue = cap(
      manifest.error ?? JSON.stringify(manifest.result, null, 2) ?? '',
      8000,
    );
  } else if (notif) {
    node.status =
      notif.status === 'completed' ? 'completed' : notif.status === 'running' ? 'running' : 'error';
    if (notif.status !== 'running') returnTurnId = b.turnAt(notif.lineIdx);
    detail.returnValue = cap(notif.result ?? '', 8000);
  } else if (!live) {
    node.status = 'error'; // no manifest, no notification, session over
  }

  if (node.status !== 'running') {
    b.edge('return', id, returnTurnId ?? spawn.fromNodeId, {
      ...(node.status === 'error' ? { reason: 'workflow failed' } : {}),
    });
  }
  details.set(id, detail);
}

function metaNameFromScript(input) {
  const src = input?.script;
  if (typeof src !== 'string') return undefined;
  const m = src.match(/name:\s*['"`]([^'"`]+)['"`]/);
  return m?.[1];
}
