import { emptyGraph, snippet } from '../../../ir.js';
import { mergeFiles } from '../../claude-code/files.js';
import { tallyUnknownType } from '../../../coverage.js';
import {
  ADAPTER_NAME,
  MIN_COMPOSER_VERSION,
  instant,
  isoAny,
  num,
  openDb,
  parseJson,
  str,
} from '../db.js';
import { bubbleRows, checkpoint, childrenByParent, composerRecord, hasKvTable } from './read.js';
import { ideOutcome } from '../outcome.js';
import { isPath, toolFamily, toolFiles, toolHint } from '../tools.js';

/**
 * Cursor IDE parser: a composer record + its header array + its bubble rows
 * → IR. Pure — no server imports, no I/O beyond the run's own database.
 *
 * **Two tiers.** `fullConversationHeadersOnly` carries, per bubble,
 * `{bubbleId, type, grouping, createdAt}` — and `grouping` carries
 * renderability, thinking presence and duration, the tool id and the tool
 * status. The graph SKELETON (node count, kinds, ordering, timings) is built
 * from the headers; bubble bodies (one range scan) supply labels, payloads
 * and details. That is what lets a tombstoned bubble — Cursor NULLs rows the
 * header still references; 92 of 1 741 on the probe machine — render as a
 * node with a hole in it rather than as a missing node, and count as
 * `sourcesUnread` rather than silently vanish.
 *
 * Ordering is header order — authoritative, never key order or a `createdAt`
 * sort (spec §16 item 4: rewind behaviour is unknown).
 *
 * **Two time units.** Composer-level `createdAt`/`lastUpdatedAt` are epoch
 * ms; header- and bubble-level `createdAt` are ISO strings. Every comparison
 * goes through `instant()`, every emission through `isoAny()`.
 *
 * **Durations only from recorded fields.** A turn's `durationMs` is its
 * `turnDurationMs` (the final assistant bubble of the turn) and absent
 * otherwise; `thinkingDurationMs` goes to the turn's detail, never into
 * `durationMs`; IDE tool nodes carry none. Never a header-`createdAt` delta —
 * that includes the user's thinking time and would fire the duration outlier
 * on every pause for coffee.
 *
 * **Tokens are not reported.** `tokenCount` is `{0, 0}` on every bubble
 * measured, and the composer's `contextTokensUsed` is a context-window gauge,
 * not spend. It goes to `ext.cursor.contextUsage` where its meaning survives.
 */

/** Observed 0 levels of subagent nesting; the cap is a cycle backstop (Cursor's own parent walk carries one). */
export const CURSOR_MAX_DEPTH = 5;

/**
 * How long a run must be silent before it counts as over — the same 5
 * minutes every other adapter uses, and deliberately a separate constant
 * rather than a cross-adapter import.
 */
const CURSOR_QUIET_MS = 5 * 60 * 1000;

const safeStringify = (value, indent = 2) => {
  try {
    return JSON.stringify(value, null, indent) ?? '';
  } catch (err) {
    return `(could not render this payload: ${err?.name ?? 'error'})`;
  }
};

export const cap = (text, max) => {
  if (typeof text !== 'string') return text == null ? '' : safeStringify(text).slice(0, max);
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
};

/** The headers array, or []. */
export function headersOf(record) {
  return Array.isArray(record?.fullConversationHeadersOnly) ? record.fullConversationHeadersOnly : [];
}

/**
 * Cursor's own subagent test, verbatim from `workbench.desktop.main.js`
 * (`evg`), byte-identical on 3.14.7 and 3.16.29.
 */
export function isSubagentComposer(c) {
  if (c?.isBestOfNSubcomposer) return false;
  return Boolean(
    (typeof c?.composerId === 'string' && c.composerId.startsWith('task-')) ||
      c?.subagentInfo?.parentComposerId,
  );
}

/**
 * Cursor's own validity predicate, from its shipping conversation indexer.
 * `_v >= 2 && composerId is a string && headers is an array && !isDraft && !isEphemeral`.
 */
export function isValidComposer(c) {
  return (
    Number.isFinite(c?._v) &&
    c._v >= 2 &&
    typeof c.composerId === 'string' &&
    Array.isArray(c.fullConversationHeadersOnly) &&
    c.isDraft !== true &&
    c.isEphemeral !== true
  );
}

/** Cloud / background agents: excluded rather than half-supported. */
export function isCloudComposer(c) {
  return Boolean(c?.createdFromBackgroundAgent?.bcId) || String(c?.composerId ?? '').startsWith('bc-');
}

export function isSupportedVersion(c) {
  return Number.isFinite(c?._v) && c._v >= MIN_COMPOSER_VERSION;
}

/** `modifiedAt` source chain for ONE composer, in epoch ms: `lastUpdatedAt` → last header → `createdAt`. */
export function composerUpdatedAt(c) {
  const own = num(c?.lastUpdatedAt);
  if (own !== undefined) return own;
  const headers = headersOf(c);
  for (let i = headers.length - 1; i >= 0; i--) {
    const t = instant(headers[i]?.createdAt);
    if (t !== undefined) return t;
  }
  return num(c?.createdAt);
}

/** `startedAt` source chain, in epoch ms: `createdAt` → first header. */
export function composerStartedAt(c) {
  const own = num(c?.createdAt);
  if (own !== undefined) return own;
  for (const h of headersOf(c)) {
    const t = instant(h?.createdAt);
    if (t !== undefined) return t;
  }
  return undefined;
}

// ---------------------------------------------------------------------------

export async function parseIde(ref, opts = {}) {
  const collect = opts.collectDetails ?? false;
  const { db, close } = await openDb(ref.dbPath);
  try {
    if (!hasKvTable(db)) throw new Error(`no cursorDiskKV table — not a Cursor state.vscdb`);
    const q = makeQueries(db);
    const record = q.composer(ref.composerId);
    if (!record) throw new Error(`composer ${ref.composerId} not found in ${ref.dbPath}`);

    const g = emptyGraph({
      runId: ref.runId,
      adapter: ADAPTER_NAME,
      kind: 'session',
      title: ref.title,
    });
    const ctx = {
      g,
      details: new Map(),
      collect,
      q,
      seen: new Set([ref.composerId]),
      stats: {
        // `records` is this adapter's IDE coverage unit: HEADERS walked, root
        // composer and every child lane. Adapter-defined, never compared
        // across adapters.
        records: 0,
        unrecognized: 0,
        sourcesUnread: 0,
        agents: 0,
        toolCalls: 0,
        skipped: 0,
        orphanBubbles: 0,
        missingChildren: [],
        unknownTypes: {},
        unknownToolStatuses: {},
        lastAt: 0,
      },
    };

    if (!isSupportedVersion(record)) {
      // Listed, never parsed. Every header is counted as a record the adapter
      // could not interpret, under a type name that says WHY, so the badge
      // reads "only 0% of this run could be parsed (composer-v3 ×60)" rather
      // than the 99% a `sourcesUnread`-only count would have produced — a
      // conversation that is visibly there must also be visibly unread.
      const headers = headersOf(record);
      for (const _ of headers) {
        ctx.stats.records++;
        ctx.stats.unrecognized++;
        tallyUnknownType(ctx.stats.unknownTypes, `composer-v${Number.isFinite(record._v) ? record._v : 'unknown'}`);
      }
      const startedAt = isoAny(composerStartedAt(record));
      if (startedAt) g.meta.startedAt = startedAt;
      finishMeta(g, ctx, ref, record, { unsupportedVersion: true });
      return { ir: g, details: ctx.details };
    }

    const walker = new ComposerWalker(ctx, { groupId: undefined, startTip: null });
    walker.walk(record);
    materializeChildren(ctx, walker, record, 1);

    const startedAt = isoAny(composerStartedAt(record));
    if (startedAt) g.meta.startedAt = startedAt;
    finishMeta(g, ctx, ref, record, {});
    return { ir: g, details: ctx.details };
  } finally {
    await close();
  }
}

function finishMeta(g, ctx, ref, record, extra) {
  // Cursor records no session end, so `endedAt` is the last thing that
  // happened — but ONLY once the run has gone quiet (SCHEMA.md: "absent while
  // the run looks live", which bundle.js reads to stamp a live export).
  // The quiet gate reads the LATEST of the record's `lastUpdatedAt` and the
  // last header time (conservative: a record write is still a sign of life),
  // but the stamp itself is the conversation's last instant — `lastUpdatedAt`
  // moves on archive and window close, which are not things the run did.
  const latest = Math.max(ctx.stats.lastAt, composerUpdatedAt(record) ?? 0);
  if (latest > 0 && Date.now() - latest >= CURSOR_QUIET_MS) {
    const endedAt = isoAny(ctx.stats.lastAt > 0 ? ctx.stats.lastAt : latest);
    if (endedAt) g.meta.endedAt = endedAt;
  }
  g.meta.unrecognizedLineCount = ctx.stats.unrecognized;
  g.meta.coverage = {
    records: ctx.stats.records,
    unrecognized: ctx.stats.unrecognized,
    sourcesUnread: ctx.stats.sourcesUnread,
  };
  g.meta.totals = {
    // Always 0 — see the header comment. A wrong number is worse than an absent one.
    tokens: 0,
    toolCalls: ctx.stats.toolCalls,
    agents: ctx.stats.agents,
  };
  g.meta.ext = { [ADAPTER_NAME]: runExt(ctx, ref, record, extra) };
}

/** The namespaced bag. Nothing Cursor-named leaves it, and neither encryption key ever enters it. */
function runExt(ctx, ref, record, extra) {
  const s = ctx.stats;
  const model = str(record?.modelConfig?.modelName);
  const used = num(record?.contextTokensUsed);
  const limit = num(record?.contextTokenLimit);
  return {
    surface: 'ide',
    ...(Number.isFinite(record?._v) ? { _v: record._v } : {}),
    ...extra,
    ...(str(record?.status) && record.status !== 'none' ? { status: record.status } : {}),
    ...(str(record?.unifiedMode) ? { unifiedMode: record.unifiedMode } : {}),
    ...(str(record?.forceMode) ? { forceMode: record.forceMode } : {}),
    ...(typeof record?.isAgentic === 'boolean' ? { isAgentic: record.isAgentic } : {}),
    ...(str(record?.agentBackend) ? { agentBackend: record.agentBackend } : {}),
    ...(model ? { model } : {}),
    // A context-window GAUGE, not spend: `contextTokensUsed / contextTokenLimit`.
    // Reporting it as totals would overstate cost by an unknowable factor.
    ...(used !== undefined || limit !== undefined
      ? {
          contextUsage: {
            ...(used !== undefined ? { tokensUsed: used } : {}),
            ...(limit !== undefined ? { tokenLimit: limit } : {}),
            ...(num(record?.contextUsagePercent) !== undefined ? { percent: record.contextUsagePercent } : {}),
          },
        }
      : {}),
    ...(num(record?.totalLinesAdded) !== undefined ? { totalLinesAdded: record.totalLinesAdded } : {}),
    ...(num(record?.totalLinesRemoved) !== undefined ? { totalLinesRemoved: record.totalLinesRemoved } : {}),
    ...(num(record?.filesChangedCount) !== undefined ? { filesChangedCount: record.filesChangedCount } : {}),
    ...(record?.isArchived === true ? { isArchived: true } : {}),
    ...(s.skipped > 0 ? { skippedBubbles: s.skipped } : {}),
    ...(s.orphanBubbles > 0 ? { orphanBubbles: s.orphanBubbles } : {}),
    ...(s.missingChildren.length > 0 ? { missingChildComposers: s.missingChildren } : {}),
    ...(Object.keys(s.unknownTypes).length > 0 ? { unknownTypes: s.unknownTypes } : {}),
    ...(Object.keys(s.unknownToolStatuses).length > 0 ? { unknownToolStatuses: s.unknownToolStatuses } : {}),
  };
}

/**
 * Point reads over the open handle. `composer(id)` is a primary-key lookup;
 * `children` is never a scan here — the child ids come from the parent
 * record's `subComposerIds` and from the ref (detect() holds every record
 * and resolves `subagentInfo.parentComposerId` matches there, so parse()
 * need not rescan the whole store on every live-tail tick).
 */
function makeQueries(db) {
  let byParent = null;
  return {
    composer: (id) => composerRecord(db, id)?.json ?? null,
    bubbles: (id) => bubbleRows(db, id),
    checkpoint: (cid, id) => checkpoint(db, cid, id),
    // Lazily, once per parse, and only when a lane is materialized: a run
    // with no subagents never pays for the scan.
    childrenOf: (parentId) => {
      if (!byParent) byParent = childrenByParent(db);
      return byParent.get(parentId) ?? [];
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Walks one composer's headers (with their bubbles) into turn/tool/human
 * nodes on a sequence chain. The root backbone and every subagent lane use
 * the same walker — a lane is a walk with a `groupId` and the agent node as
 * its root.
 */
class ComposerWalker {
  constructor(ctx, { groupId, startTip }) {
    this.ctx = ctx;
    this.g = ctx.g;
    this.details = ctx.details;
    this.collect = ctx.collect;
    this.groupId = groupId;
    this.chainTip = startTip;
    this.pendingReason = null;
    this.turn = null;
    this.turns = []; // [{ id, at }] — spawn/return fallbacks
    this.toolKey = new Map(); // tool node id → family
    this.toolFiles = new Map(); // tool node id → union of touched paths
    this.toolPrev = new Map(); // tool node id → the node it chained off
    this.lastToolNodeId = null;
    this.lastHumanId = null;
    this.assistantSinceDenial = false; // any non-tool assistant bubble since the last denial
    this.lastText = ''; // last ASSISTANT text — the lane's return label
    this.firstPrompt = ''; // first HUMAN text — the lane's prompt
    this.narration = null;
    this.live = new Set();
    this.created = [];
    this.composerId = null;
  }

  // ---- graph plumbing -----------------------------------------------------

  node(n) {
    if (this.groupId) n.group = this.groupId;
    this.g.nodes.push(n);
    this.created.push(n);
    return n;
  }

  edge(kind, from, to, extra = {}) {
    if (!from || !to || from === to) return undefined;
    const e = { id: `e:${kind}:${from}→${to}`, kind, from, to, ...extra };
    if (!this.g.edges.some((x) => x.id === e.id)) this.g.edges.push(e);
    return e;
  }

  chain(nodeId) {
    const e = this.edge('sequence', this.chainTip, nodeId);
    if (e && this.pendingReason && !e.reason) {
      e.reason = this.pendingReason;
      this.pendingReason = null;
    }
    this.chainTip = nodeId;
  }

  unknown(type) {
    this.ctx.stats.unrecognized++;
    tallyUnknownType(this.ctx.stats.unknownTypes, type);
  }

  touch(at) {
    const ms = instant(at);
    if (ms !== undefined && ms > this.ctx.stats.lastAt) this.ctx.stats.lastAt = ms;
  }

  // ---- the walk -----------------------------------------------------------

  walk(record, keyId) {
    this.composerId = typeof record.composerId === 'string' && record.composerId ? record.composerId : keyId;
    const headers = headersOf(record);
    const rows = this.ctx.q.bubbles(this.composerId);
    const referenced = new Set();

    for (const h of headers) {
      if (!h || typeof h !== 'object' || typeof h.bubbleId !== 'string') {
        this.ctx.stats.records++;
        this.unknown('header');
        continue;
      }
      referenced.add(h.bubbleId);
      const row = rows.get(h.bubbleId);
      const bubble = row?.json;
      // Skip flags are honoured BEFORE counting: a display-only or ephemeral
      // bubble is not content, and counting it as read would inflate coverage.
      if (bubble && (bubble.isDisplayOnly === true || bubble.isEphemeral === true)) {
        this.ctx.stats.skipped++;
        continue;
      }
      this.ctx.stats.records++;
      if (!row) this.ctx.stats.sourcesUnread++;
      else if (row.miss === 'null' || row.miss === 'oversized') this.ctx.stats.sourcesUnread++;
      else if (row.miss) this.unknown('bubble');
      this.header(h, bubble);
    }
    // Rows the headers do not reference. Examined, unplaceable; not a
    // coverage event (the unit is headers) but named in ext, because a
    // rewind that leaves rows behind is exactly the unknown in §16 item 4.
    for (const id of rows.keys()) if (!referenced.has(id)) this.ctx.stats.orphanBubbles++;

    this.finish();
    if (record.status === 'aborted') this.interrupted(record);
  }

  header(h, bubble) {
    const type = Number.isInteger(h.type) ? h.type : bubble?.type;
    this.touch(h.createdAt ?? bubble?.createdAt);
    if (type === 1) return this.human(h, bubble);
    if (type === 2) {
      if (isToolBubble(h, bubble)) return this.tool(h, bubble);
      return this.assistant(h, bubble);
    }
    this.unknown(`bubble-type:${Number.isInteger(type) ? type : 'unknown'}`);
  }

  // ---- type 1 = turns -----------------------------------------------------

  human(h, bubble) {
    this.closeTurn();
    this.narration = null;
    const prompt = str(bubble?.text) ?? '';
    if (!this.firstPrompt && prompt) this.firstPrompt = prompt;
    const id = `t:${h.bubbleId}`;
    const startedAt = isoAny(h.createdAt ?? bubble?.createdAt);
    const node = this.node({
      id,
      kind: 'turn',
      label: bubble ? snippet(prompt) || '(empty prompt)' : '(prompt not retained)',
      status: 'completed',
      ...(startedAt ? { startedAt } : {}),
      hasDetail: true,
    });
    this.chain(id);
    const turn = {
      id,
      node,
      prompt,
      unread: !bubble,
      responseText: '',
      thinking: '',
      thinkingMs: 0,
      durationMs: undefined,
      lastAt: h.createdAt ?? bubble?.createdAt,
      running: false,
    };
    this.turn = turn;
    this.turns.push({ id, at: instant(h.createdAt ?? bubble?.createdAt) });
  }

  closeTurn() {
    const t = this.turn;
    this.turn = null;
    if (!t) return;
    if (Number.isFinite(t.durationMs) && t.durationMs > 0) t.node.durationMs = t.durationMs;
    const ended = isoAny(t.lastAt);
    if (ended) t.node.endedAt = ended;
    if (t.running) t.node.status = 'running';
    if (this.collect) {
      this.details.set(t.id, {
        kind: 'turn',
        prompt: t.unread ? '(this prompt\'s bubble is no longer in the store — Cursor tombstoned it)' : cap(t.prompt, 8000),
        responseText: cap(t.responseText, 8000),
        ...(t.thinking ? { thinking: cap(t.thinking, 4000) } : {}),
        ...(t.thinkingMs > 0 ? { thinkingDurationMs: t.thinkingMs } : {}),
      });
    }
  }

  // ---- type 2, no tool = assistant text / thinking ------------------------

  assistant(h, bubble) {
    const turn = this.turn;
    const at = h.createdAt ?? bubble?.createdAt;
    if (turn && instant(at) !== undefined) turn.lastAt = at;
    this.assistantSinceDenial = true;
    if (!bubble) return; // a hole: the header said "assistant", the body is gone
    const text = str(bubble.text);
    if (text) {
      if (turn) turn.responseText += (turn.responseText ? '\n\n' : '') + text;
      this.lastText = text;
      this.narration = text;
    }
    const thinking = str(bubble.thinking?.text) ?? (typeof bubble.thinking === 'string' ? bubble.thinking : '');
    if (turn && thinking) turn.thinking += (turn.thinking ? '\n\n' : '') + thinking;
    const thinkMs = num(bubble.thinkingDurationMs) ?? num(h.grouping?.thinkingDurationMs);
    if (turn && thinkMs !== undefined) turn.thinkingMs += thinkMs;
    // The final assistant bubble of a turn carries the turn's duration — the
    // ONE recorded duration an IDE turn has.
    const turnMs = num(bubble.turnDurationMs) ?? num(h.grouping?.turnDurationMs);
    if (turn && turnMs !== undefined) turn.durationMs = turnMs;
    if (typeof bubble.checkpointId === 'string') this.checkpointFiles(bubble.checkpointId);
  }

  // ---- type 2 with toolFormerData = tool calls ----------------------------

  tool(h, bubble) {
    const tf = bubble?.toolFormerData ?? skeletonTool(h);
    const params = parseJson(tf.params);
    const result = parseJson(tf.result);
    const error = parseJson(tf.error);
    const ad = tf.additionalData && typeof tf.additionalData === 'object' ? tf.additionalData : {};
    const family = toolFamily(tf, params);
    // The drift tally is for statuses Cursor WROTE; a skeleton record (the
    // bubble is gone and the header carries no status) is a hole, not drift.
    const outcome = ideOutcome(
      tf,
      result,
      bubble ? (status) => tallyUnknownType(this.ctx.stats.unknownToolStatuses, status) : undefined,
    );
    const failed = outcome === 'error' || outcome === 'rejected';
    const running = outcome === 'running';
    const at = h.createdAt ?? bubble?.createdAt;
    if (this.turn && instant(at) !== undefined) this.turn.lastAt = at;

    // Consecutive same-family calls collapse into one node — the canvas
    // convention (`Read · find.js ×2`). Keyed on the FAMILY, which is what
    // `toolFamily()` in signals.js recovers from the label's head segment.
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    let nodeId;
    if (tip && tip.kind === 'tool' && this.toolKey.get(tip.id) === family) {
      tip.callCount += 1;
      nodeId = tip.id;
    } else {
      nodeId = `g:${h.bubbleId}`;
      const startedAt = isoAny(at);
      this.node({
        id: nodeId,
        kind: 'tool',
        label: toolLabel(family, toolHint(tf, params)),
        // Settled by finish(), which alone sees the whole collapsed group.
        status: 'completed',
        callCount: 1,
        errorCount: 0,
        ...(startedAt ? { startedAt } : {}),
        hasDetail: true,
      });
      this.toolKey.set(nodeId, family);
      this.toolPrev.set(nodeId, this.chainTip);
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
    this.lastToolNodeId = nodeId;
    this.narration = null;
    this.ctx.stats.toolCalls++;

    const group = this.g.nodes.find((n) => n.id === nodeId);
    if (group) {
      if (failed) group.errorCount += 1;
      if (running) {
        this.live.add(nodeId);
        if (this.turn) this.turn.running = true;
      }
    }
    const paths = toolFiles(tf, params);
    if (paths.length) this.attachFiles(nodeId, paths);
    if (typeof bubble?.checkpointId === 'string') this.checkpointFiles(bubble.checkpointId);

    if (this.collect) {
      const startedAtMs = num(ad.startedAtMs);
      const errorText = str(error?.clientVisibleErrorMessage) ?? str(error?.modelVisibleErrorMessage);
      const output = bubble
        ? errorText && !result
          ? errorText
          : result !== undefined
            ? safeStringify(result)
            : (str(tf.result) ?? '')
        : '(this call\'s bubble is no longer in the store — Cursor tombstoned it)';
      this.details.get(nodeId)?.calls.push({
        toolUseId: str(tf.toolCallId) ?? h.bubbleId,
        input: cap(params !== undefined ? safeStringify(params) : (str(tf.params) ?? str(tf.rawArgs) ?? ''), 3000),
        output: cap(errorText && result ? `${errorText}\n\n${output}` : output, 4000),
        isError: failed,
        ...(startedAtMs !== undefined ? { startedAt: isoAny(startedAtMs) } : {}),
      });
    }

    if (outcome === 'rejected') return this.denial(h, family, params, result, error, nodeId);
    if (outcome === 'error') this.pendingReason = `after ${family} error`;
  }

  /**
   * A refused (or skipped, or cancelled) call. The human node right after it,
   * WITH its tool→human `sequence` edge, is what tells signals.js this
   * "error" was a person saying no rather than a retry to flag. Emit the node
   * without the edge and the exclusion silently never happens — rev 2 of the
   * spec made exactly that mistake.
   */
  denial(h, family, params, result, error, toolNodeId) {
    // A refused parallel BATCH collapses into one human node: the denied tool
    // bubbles sit back to back in header order. A retry the model issued
    // AFTER the refusal has at least one thinking/text bubble before it, and
    // a second refusal of that is a second decision — two nodes, two edges.
    // The test is "the tool node just denied chained DIRECTLY off the
    // previous denial, with no assistant bubble in between".
    const prev = this.g.nodes.find((n) => n.id === this.lastHumanId);
    if (
      prev?.interventionKind === 'denial' &&
      !this.assistantSinceDenial &&
      this.toolPrev.get(toolNodeId) === prev.id
    ) {
      prev.label = snippet(`${prev.label}, ${family}`, 60);
      this.edge('sequence', toolNodeId, prev.id);
      // The whole batch hangs off its one denial node, so a third refused
      // call of yet another family chains off it too and collapses as well.
      this.chainTip = prev.id;
      return;
    }
    const id = `h:${h.bubbleId}`;
    const startedAt = isoAny(h.createdAt);
    this.node({
      id,
      kind: 'human',
      label: `denied ${family}`,
      status: 'completed',
      interventionKind: 'denial',
      ...(startedAt ? { startedAt } : {}),
      hasDetail: true,
    });
    if (this.collect) {
      this.details.set(id, {
        kind: 'human',
        interventionKind: 'denial',
        context: cap(params !== undefined ? safeStringify(params) : '', 3000),
        answer: cap(
          str(error?.clientVisibleErrorMessage) ?? str(result?.output) ?? 'The user did not allow this call.',
          2000,
        ),
      });
    }
    this.chain(id);
    this.edge('sequence', toolNodeId, id);
    this.lastHumanId = id;
    this.assistantSinceDenial = false;
    this.pendingReason = 'after permission denial';
  }

  /**
   * `status: 'aborted'` is a COMPOSER-level field and reflects only the
   * latest turn, so one interrupt node goes after the run's last node, with
   * the sequence edge from it. When that node is a tool node the exclusion
   * applies; when it is a turn, there is nothing to exclude. An abort
   * followed by further turns is not recoverable from this field — recall is
   * sacrificed, precision is not.
   */
  interrupted(record) {
    const id = `h:${this.composerId ?? record.composerId}:interrupt`;
    if (this.g.nodes.some((n) => n.id === id)) return;
    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    // Stamped from the CONVERSATION (the last header's time), not from the
    // composer's `lastUpdatedAt`: Cursor bumps that on archive and on window
    // close, which would place the interrupt minutes or days after the last
    // thing that happened. The record is the fallback only.
    const startedAt = isoAny(this.ctx.stats.lastAt > 0 ? this.ctx.stats.lastAt : composerUpdatedAt(record));
    this.node({
      id,
      kind: 'human',
      label: 'interrupted the run',
      status: 'completed',
      interventionKind: 'interrupt',
      ...(startedAt ? { startedAt } : {}),
      hasDetail: true,
    });
    if (this.collect) {
      this.details.set(id, {
        kind: 'human',
        interventionKind: 'interrupt',
        context: 'The user stopped Cursor mid-generation.',
        answer: 'Aborted',
      });
    }
    this.chain(id);
    if (tip?.kind === 'tool') this.edge('sequence', tip.id, id);
    this.pendingReason = 'after the user interrupted';
  }

  // ---- files --------------------------------------------------------------

  attachFiles(nodeId, paths) {
    if (!nodeId || !paths?.length) return;
    this.toolFiles.set(nodeId, mergeFiles(this.toolFiles.get(nodeId), paths));
  }

  /**
   * A checkpoint referenced from an ASSISTANT bubble is the post-edit
   * snapshot: its `files[].uri.fsPath` attribute to the most recent Edit
   * node. Only an Edit — a checkpoint after a read-only turn names files the
   * run merely looked at, and precision over recall says those stay off the
   * node. Inference (no applied IDE edit has been observed — spec §16 item 2),
   * bounded by that one rule.
   */
  checkpointFiles(checkpointId) {
    const last = this.lastToolNodeId;
    if (!last || this.toolKey.get(last) !== 'Edit') return;
    const cp = this.ctx.q.checkpoint(this.composerId, checkpointId);
    const files = Array.isArray(cp?.files) ? cp.files : [];
    const paths = files.map((f) => f?.uri?.fsPath ?? f?.fsPath ?? f?.path).filter(isPath);
    if (paths.length) this.attachFiles(last, paths);
  }

  laneFiles() {
    let out = [];
    for (const files of this.toolFiles.values()) out = mergeFiles(out, files);
    return out;
  }

  /** Which turn was open at a given instant — the lane's spawn fallback. */
  turnAt(at) {
    let cur = null;
    for (const t of this.turns) {
      if (Number.isFinite(t.at) && Number.isFinite(at) && t.at <= at) cur = t.id;
      else if (cur) break;
    }
    return cur;
  }

  finish() {
    this.closeTurn();
    for (const n of this.created) {
      if (n.kind !== 'tool') continue;
      // THE CROSS-ADAPTER INVARIANT: a collapsed node is `error` only when
      // EVERY collapsed call failed; `running` when any call is in flight.
      if (this.live.has(n.id)) n.status = 'running';
      else if (n.errorCount > 0 && n.errorCount >= n.callCount) n.status = 'error';
      if (n.callCount > 1) n.label = `${n.label} ×${n.callCount}`;
      const files = this.toolFiles.get(n.id);
      if (files?.length) n.files = files;
    }
  }
}

/** A header-only tool record — what the skeleton tier has when the bubble is gone. */
function skeletonTool(h) {
  const gp = h?.grouping && typeof h.grouping === 'object' ? h.grouping : {};
  return {
    ...(Number.isInteger(gp.toolFormerTool) ? { tool: gp.toolFormerTool } : {}),
    ...(typeof gp.toolFormerStatus === 'string' ? { status: gp.toolFormerStatus } : {}),
    ...(typeof gp.toolCallId === 'string' ? { toolCallId: gp.toolCallId } : {}),
    // Terminal headers carry the command's verdict in `shellStatus` (observed
    // vocabulary: success / error / rejected). The two failure values ride
    // into the skeleton under the field ideOutcome() already reads, so a
    // tombstoned refused command still yields its denial; anything else —
    // success, or a value this build has not seen — is left out, because
    // unknown vocabulary must never become a false flag.
    ...(gp.shellStatus === 'rejected' || gp.shellStatus === 'error'
      ? { additionalData: { status: gp.shellStatus } }
      : {}),
  };
}

function isToolBubble(h, bubble) {
  if (bubble?.toolFormerData && typeof bubble.toolFormerData === 'object') return true;
  if (bubble) return false;
  const gp = h?.grouping;
  return Boolean(gp && (Number.isInteger(gp.toolFormerTool) || typeof gp.toolCallId === 'string'));
}

/** `<Family> · <hint>` — the canvas convention `toolFamily()` in signals.js reads back. */
export function toolLabel(family, hint, max = 40) {
  const subject = typeof hint === 'string' && hint.trim() ? hint.trim() : '';
  if (!subject) return family;
  return snippet(`${family} · ${subject}`, max);
}

// ---- subagent lanes --------------------------------------------------------

/**
 * Materialize a composer's subagent children: an agent node per child
 * composer, spawn/return edges, and the child's own headers walked into a
 * lane. Children are the union of the record's `subComposerIds` and the ids
 * detect() matched by `subagentInfo.parentComposerId` (carried on the ref).
 * A child whose record is missing is `sourcesUnread` +1 on the parent —
 * the IR's definition of a referenced source that could not be opened.
 */
function materializeChildren(ctx, walker, record, depth) {
  if (depth > CURSOR_MAX_DEPTH) return;
  const parentId = typeof record.composerId === 'string' ? record.composerId : '';
  const ids = [];
  // Both routes, at EVERY depth: the parent's own list, and every composer
  // whose `subagentInfo.parentComposerId` names this one (resolved live
  // against the store, so a child Cursor spawned since the ref was built —
  // or a grandchild its parent never listed — is found on this parse).
  for (const id of [
    ...(Array.isArray(record.subComposerIds) ? record.subComposerIds : []),
    ...(parentId ? ctx.q.childrenOf(parentId) : []),
  ]) {
    if (typeof id === 'string' && id && id !== parentId && !ids.includes(id)) ids.push(id);
  }
  for (const id of ids) {
    if (ctx.seen.has(id)) continue;
    const child = ctx.q.composer(id);
    if (!child) {
      ctx.stats.sourcesUnread++;
      ctx.stats.missingChildren.push(id);
      continue;
    }
    lane(ctx, walker, child, depth, id);
  }
}

function lane(ctx, walker, child, depth, keyId) {
  // The KEY's id is authoritative — it is what the parent referenced and what
  // the row is filed under; a body whose `composerId` is absent or not a
  // string is still that child, not a record to drop without accounting.
  const childId = typeof child.composerId === 'string' && child.composerId ? child.composerId : keyId;
  if (typeof childId !== 'string' || !childId || ctx.seen.has(childId)) return;
  ctx.seen.add(childId);
  ctx.stats.agents++;

  const agentId = `a:${childId}`;
  const groupId = `lane:${agentId}`;
  const childWalker = new ComposerWalker(ctx, { groupId, startTip: agentId });
  const startMs = composerStartedAt(child);
  const fromId = walker.turnAt(startMs) ?? walker.chainTip;

  const node = {
    id: agentId,
    kind: 'agent',
    label: '',
    status: 'completed',
    agentId: childId,
    group: groupId,
    hasDetail: true,
  };
  const model = str(child.modelConfig?.modelName);
  if (model) node.model = model;
  const startedAt = isoAny(startMs);
  if (startedAt) node.startedAt = startedAt;
  ctx.g.nodes.push(node);
  // The group label is settled after the walk (it may need the child's
  // first prompt), but the group row must exist before the lane's nodes do.
  const group = { id: groupId, label: '' };
  ctx.g.groups.push(group);

  if (!isSupportedVersion(child)) {
    for (const _ of headersOf(child)) {
      ctx.stats.records++;
      ctx.stats.unrecognized++;
      tallyUnknownType(ctx.stats.unknownTypes, `composer-v${Number.isFinite(child._v) ? child._v : 'unknown'}`);
    }
  } else {
    childWalker.walk(child, childId);
  }

  const label = snippet(str(child.name) ?? childWalker.firstPrompt ?? '', 60) || childId;
  node.label = label;
  group.label = label;
  if (childWalker.live.size > 0) node.status = 'running';
  const endMs = child.status === 'completed' || child.status === 'aborted' ? composerUpdatedAt(child) : undefined;
  const endedAt = isoAny(endMs);
  if (endedAt) node.endedAt = endedAt;
  const files = childWalker.laneFiles();
  if (files.length) node.files = files;
  if (str(child.status) && child.status !== 'none') node.ext = { [ADAPTER_NAME]: { status: child.status } };

  walker.edge('spawn', fromId, agentId, {
    ...(childWalker.firstPrompt ? { label: snippet(childWalker.firstPrompt, 90) } : {}),
  });
  walker.edge('return', agentId, walker.turnAt(startMs) ?? fromId, {
    ...(childWalker.lastText ? { label: snippet(childWalker.lastText, 90) } : {}),
  });

  ctx.details.set(agentId, {
    kind: 'agent',
    prompt: cap(childWalker.firstPrompt || label, 8000),
    result: childWalker.lastText ? cap(childWalker.lastText, 8000) : null,
    transcript: [],
  });

  materializeChildren(ctx, childWalker, { ...child, composerId: childId }, depth + 1);
}
