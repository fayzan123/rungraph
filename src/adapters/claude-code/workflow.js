import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { emptyGraph, snippet } from '../../ir.js';
import { readJsonLines, statOrNull, safeParseJson } from '../../util.js';
import {
  KNOWN_AGENT_TYPES,
  INTERRUPT_TEXTS,
  contentText,
  UsageTally,
  cap,
  msBetween,
  WORKFLOW_QUIET_MS,
} from './helpers.js';

/**
 * Run manifest written at <project>/<sessionId>/workflows/<wfId>.json when the
 * run finishes (absent while running — that absence IS the running signal).
 */
export async function readManifest(projectDir, sessionId, wfId) {
  try {
    const raw = await readFile(join(projectDir, sessionId, 'workflows', `${wfId}.json`), 'utf8');
    return safeParseJson(raw) ?? null;
  } catch {
    return null;
  }
}

/** Parse a workflow run into its own drill-in graph: phases as groups, agents inside. */
export async function parseWorkflowRun(ref, opts = {}) {
  const collect = opts.collectDetails ?? false;
  const g = emptyGraph({
    runId: ref.runId,
    adapter: ref.adapter,
    kind: 'workflow',
    title: ref.title,
  });
  const details = new Map();

  // ---- journal: attempts grouped by key ----------------------------------
  let unrecognized = 0;
  const badLineNos = [];
  let maxLineNo = 0;
  const attempts = []; // { agentId, key, order }
  const resultByAgent = new Map();
  for await (const { obj, lineNo } of readJsonLines(ref.journalFile, {
    onBadLine: (_line, n) => badLineNos.push(n),
  })) {
    maxLineNo = Math.max(maxLineNo, lineNo);
    if (obj?.type === 'started' && obj.agentId) {
      attempts.push({ agentId: obj.agentId, key: obj.key, order: attempts.length });
    } else if (obj?.type === 'result' && obj.agentId) {
      resultByAgent.set(obj.agentId, obj.result);
    } else {
      unrecognized++;
    }
  }
  // Malformed FINAL line = mid-write truncation, not format drift.
  maxLineNo = Math.max(maxLineNo, ...badLineNos, 0);
  unrecognized += badLineNos.filter((n) => n !== maxLineNo).length;

  const manifest = await readManifest(ref.projectDir, ref.sessionId, ref.wfId);
  const progressByAgent = new Map();
  const phases = new Map(); // index → title
  for (const p of manifest?.workflowProgress ?? []) {
    if (p.type === 'workflow_phase') phases.set(p.index, p.title);
    else if (p.type === 'workflow_agent' && p.agentId) progressByAgent.set(p.agentId, p);
  }

  // Pre-pass: stat + parse every attempt's transcript now, so liveness can
  // consider the freshest activity across ALL of the run's files. The
  // journal only moves at agent start/finish and goes quiet for whole
  // phases — a missing manifest is the primary "still running" signal.
  for (const att of attempts) {
    att.file = join(ref.wfDir, `agent-${att.agentId}.jsonl`);
    att.st = await statOrNull(att.file);
    att.parsed = att.st ? await parseAgentFile(att.file, { collectTranscript: collect }) : null;
    if (att.parsed) unrecognized += att.parsed.unrecognized;
  }
  const jst = await statOrNull(ref.journalFile);
  const maxMtimeMs = Math.max(
    jst?.mtimeMs ?? 0,
    ...attempts.map((a) => a.st?.mtimeMs ?? 0),
  );
  const runLive = !manifest && Date.now() - maxMtimeMs < WORKFLOW_QUIET_MS;

  g.meta.title = snippet(manifest?.workflowName ?? ref.title, 100);
  if (manifest?.startTime) g.meta.startedAt = new Date(manifest.startTime).toISOString();
  if (manifest?.timestamp) g.meta.endedAt = manifest.timestamp;

  // ---- root node: the run itself -----------------------------------------
  const rootId = 'w:root';
  const rootStatus = manifest
    ? manifest.status === 'failed'
      ? 'error'
      : 'completed'
    : runLive
      ? 'running'
      : 'error';
  g.nodes.push({
    id: rootId,
    kind: 'workflow',
    label: g.meta.title || ref.wfId,
    status: rootStatus,
    startedAt: g.meta.startedAt,
    endedAt: g.meta.endedAt,
    durationMs: manifest?.durationMs,
    hasDetail: true,
  });
  details.set(rootId, {
    kind: 'workflow',
    wfId: ref.wfId,
    returnValue: cap(
      manifest?.error ??
        (manifest?.result !== undefined ? JSON.stringify(manifest.result, null, 2) : '') ??
        '',
      8000,
    ),
  });

  // ---- groups: phases ----------------------------------------------------
  const usedPhases = new Set(
    [...progressByAgent.values()].map((p) => p.phaseIndex).filter((x) => x != null),
  );
  for (const [index, title] of [...phases.entries()].sort((a, b) => a[0] - b[0])) {
    if (usedPhases.has(index)) g.groups.push({ id: `p:${index}`, label: title });
  }

  // ---- agent nodes -------------------------------------------------------
  const byKey = new Map();
  let totalToolCalls = 0;
  let totalTokens = 0;

  for (const att of attempts) {
    const prog = progressByAgent.get(att.agentId);
    const result = resultByAgent.get(att.agentId);
    const { st, parsed } = att;

    const isFinalAttempt = attempts.filter((a) => a.key === att.key).at(-1) === att;
    let status;
    if (result !== undefined) status = 'completed';
    else if (prog?.state === 'error' || parsed?.terminal === 'error') status = 'error';
    else if (parsed?.terminal === 'completed') status = 'completed';
    else if (!isFinalAttempt) status = 'error'; // superseded attempt
    else status = runLive ? 'running' : 'error';

    const id = `a:${att.agentId}`;
    const label = snippet(
      prog?.label ?? parsed?.prompt ?? att.agentId,
      60,
    );
    const node = {
      id,
      kind: 'agent',
      label,
      status,
      agentId: att.agentId,
      hasDetail: true,
    };
    if (prog?.phaseIndex != null && phases.has(prog.phaseIndex)) node.group = `p:${prog.phaseIndex}`;
    if (prog?.model ?? parsed?.model) node.model = prog?.model ?? parsed?.model;
    if (parsed?.startedAt) node.startedAt = parsed.startedAt;
    if (parsed?.endedAt && status !== 'running') node.endedAt = parsed.endedAt;
    node.durationMs = prog?.durationMs ?? parsed?.durationMs;
    if (parsed && parsed.tokens.input + parsed.tokens.output > 0) node.tokens = parsed.tokens;
    else if (prog?.tokens) node.tokens = { input: 0, output: prog.tokens };
    if (!st) node.ext = { transcriptMissing: true };
    g.nodes.push(node);

    totalToolCalls += prog?.toolCalls ?? parsed?.toolCalls ?? 0;
    totalTokens += node.tokens ? node.tokens.input + node.tokens.output : 0;

    const resultText =
      result === undefined
        ? (prog?.error ?? parsed?.finalText ?? null)
        : typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
    details.set(id, {
      kind: 'agent',
      prompt: cap(parsed?.prompt ?? prog?.promptPreview ?? '', 8000),
      result: resultText ? cap(resultText, 8000) : null,
      transcript: parsed?.transcript ?? [],
    });

    // retry lineage within a key
    const prev = byKey.get(att.key);
    if (prev) {
      g.edges.push({
        id: `e:sequence:${prev}→${id}`,
        kind: 'sequence',
        from: prev,
        to: id,
        reason: 'retry after failure',
      });
    }
    byKey.set(att.key, id);
    att.nodeId = id;
    att.phaseIndex = prog?.phaseIndex ?? null;
  }

  // ---- edges: root → phase-1 fan; single transition edge between phases --
  const finalAttempts = [...byKey.values()];
  const byPhase = new Map();
  for (const att of attempts) {
    if (!finalAttempts.includes(att.nodeId)) continue;
    const idx = att.phaseIndex ?? 0;
    if (!byPhase.has(idx)) byPhase.set(idx, []);
    byPhase.get(idx).push(att.nodeId);
  }
  const phaseOrder = [...byPhase.keys()].sort((a, b) => a - b);
  const firstPhase = phaseOrder[0];
  for (const nodeId of byPhase.get(firstPhase) ?? []) {
    const node = g.nodes.find((n) => n.id === nodeId);
    g.edges.push({
      id: `e:spawn:${rootId}→${nodeId}`,
      kind: 'spawn',
      from: rootId,
      to: nodeId,
      label: node?.label,
    });
  }
  for (let i = 1; i < phaseOrder.length; i++) {
    const from = byPhase.get(phaseOrder[i - 1])[0];
    const to = byPhase.get(phaseOrder[i])[0];
    const title = phases.get(phaseOrder[i]);
    g.edges.push({
      id: `e:sequence:${from}→${to}`,
      kind: 'sequence',
      from,
      to,
      ...(title ? { reason: `phase: ${title}` } : {}),
    });
  }

  g.meta.unrecognizedLineCount = unrecognized;
  g.meta.totals = {
    tokens: manifest?.totalTokens ?? totalTokens,
    toolCalls: manifest?.totalToolCalls ?? totalToolCalls,
    agents: attempts.length,
  };
  return { ir: g, details };
}

/**
 * Stream one agent transcript. Returns tokens (deduped by message.id),
 * timing, model, terminal state, prompt, final text, and (optionally) a
 * display transcript.
 */
export async function parseAgentFile(file, { collectTranscript = false } = {}) {
  const usage = new UsageTally();
  const out = {
    tokens: { input: 0, output: 0 },
    startedAt: undefined,
    endedAt: undefined,
    durationMs: undefined,
    model: undefined,
    terminal: null, // 'completed' | 'error' | null (running/unknown)
    prompt: undefined,
    finalText: null,
    transcript: [],
    toolCalls: 0,
    unrecognized: 0,
  };
  const models = new Map();
  let lastAssistant = null;
  let lastLine = null;
  let structuredEnd = false;
  const badLineNos = [];
  let maxLineNo = 0;

  for await (const { obj, lineNo } of readJsonLines(file, {
    onBadLine: (_line, n) => badLineNos.push(n),
  })) {
    maxLineNo = Math.max(maxLineNo, lineNo);
    if (typeof obj?.type !== 'string' || !KNOWN_AGENT_TYPES.has(obj.type)) {
      out.unrecognized++;
      continue;
    }
    lastLine = obj;
    if (typeof obj.timestamp === 'string') {
      out.startedAt ??= obj.timestamp;
      out.endedAt = obj.timestamp;
    }

    if (obj.type === 'user') {
      const c = obj.message?.content;
      if (typeof c === 'string') {
        out.prompt ??= c;
        if (collectTranscript && !obj.isMeta) push(out.transcript, { role: 'user', text: cap(c, 1500) });
      } else if (Array.isArray(c)) {
        if (obj.toolEndsTurn === true) structuredEnd = true;
        if (collectTranscript) {
          const tr = c.find((x) => x?.type === 'tool_result');
          if (tr && (tr.is_error === true || typeof obj.toolUseResult === 'string')) {
            push(out.transcript, {
              role: 'user',
              toolName: 'result',
              text: cap(
                typeof obj.toolUseResult === 'string' ? obj.toolUseResult : contentText(tr.content),
                800,
              ),
            });
          }
        }
      }
    } else if (obj.type === 'assistant') {
      const msg = obj.message;
      if (!msg) continue;
      usage.add(msg);
      if (msg.model && msg.model !== '<synthetic>') {
        models.set(msg.model, (models.get(msg.model) ?? 0) + 1);
      }
      lastAssistant = obj;
      const block = Array.isArray(msg.content) ? msg.content[0] : null;
      if (!block) continue;
      if (block.type === 'text' && block.text?.trim()) {
        out.finalText = block.text;
        if (collectTranscript) push(out.transcript, { role: 'assistant', text: cap(block.text, 1500) });
      } else if (block.type === 'tool_use') {
        out.toolCalls++;
        if (block.name === 'StructuredOutput') {
          out.finalText = JSON.stringify(block.input, null, 2);
        }
        if (collectTranscript) {
          push(out.transcript, {
            role: 'assistant',
            toolName: block.name,
            text: cap(JSON.stringify(block.input), 600),
          });
        }
      }
    }
  }

  // Malformed FINAL line = mid-write truncation, tolerated silently.
  maxLineNo = Math.max(maxLineNo, ...badLineNos, 0);
  out.unrecognized += badLineNos.filter((n) => n !== maxLineNo).length;

  out.tokens = usage.outputOnlyTotals();
  out.durationMs = msBetween(out.startedAt, out.endedAt);
  out.model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // Terminal state, in evidence order.
  const lastText =
    lastLine?.type === 'user' ? contentText(lastLine.message?.content).trim() : '';
  if (INTERRUPT_TEXTS.has(lastText)) out.terminal = 'error';
  else if (
    lastAssistant &&
    (lastAssistant.message.model === '<synthetic>' || lastAssistant.isApiErrorMessage) &&
    lastLine === lastAssistant
  )
    out.terminal = 'error';
  else if (lastAssistant?.message?.stop_reason === 'refusal') out.terminal = 'error';
  else if (structuredEnd) out.terminal = 'completed';
  else if (lastLine === lastAssistant && lastAssistant?.message?.stop_reason === 'end_turn')
    out.terminal = 'completed';

  return out;
}

const MAX_TRANSCRIPT_ENTRIES = 300;
function push(arr, entry) {
  if (arr.length < MAX_TRANSCRIPT_ENTRIES) arr.push(entry);
}
