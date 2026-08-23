import { emptyGraph, snippet } from '../../../ir.js';
import { mergeFiles } from '../../claude-code/files.js';
import { tallyUnknownType } from '../../../coverage.js';
import { ADAPTER_NAME, iso, num, openDb, str } from '../db.js';
import { decodeMessageBlob, hasStoreTables, readBlob, readMeta0, rootMessageIds } from './read.js';
import { cliOutcome, cliResultPayload } from '../outcome.js';
import { isPath } from '../tools.js';
import { cap } from '../ide/parse.js';

/**
 * cursor-agent parser: the root snapshot's message list → IR. Pure — no
 * server imports, no I/O beyond the run's own `store.db`.
 *
 * The two Cursor parsers deliberately share no "message" abstraction — an
 * IDE bubble and a CLI message blob model different things, and a common one
 * would be a lie. What they share is `outcome.js`, because both answer the
 * same question there.
 *
 * Grounded in the two calibration sessions (2026-08-20, 2026-08-23):
 *
 * - **Roles** `{system, user, assistant, tool}`; **blocks** `{text, reasoning,
 *   redacted-reasoning, tool-call, tool-result}`.
 * - **The first `user` blob is not a prompt.** It is ~35–45 KB of injected
 *   context (`<user_info>`, rules, git status) with `content: <string>` and
 *   `providerOptions.cursor.requestContextCompleteness`. The human's prompt
 *   is the NEXT `user` blob, `content: [{type:'text', text}]`, wrapped in
 *   `<timestamp>…</timestamp>\n<user_query>…</user_query>`. The injected
 *   context is READ (it counts toward coverage) and never rendered — it is
 *   Cursor's prompt engineering, not the user's words, and it carries the
 *   repo's instruction files and git status, which are not rungraph's to
 *   re-emit.
 * - **Message blobs carry no timestamps.** That `<timestamp>` is the only
 *   per-message time in the store; it parses when it matches the observed
 *   prose shape and is absent otherwise.
 * - **Calls and results match on `content[].toolCallId`, never on message
 *   id** — tool-message ids contain a newline on one session and are the
 *   literal `"1"` on every assistant message of the other.
 * - **A `tool-call` with no `tool-result` is `running`** — the only in-flight
 *   representation the CLI has (the call is flushed before the tool runs, the
 *   result after; measured).
 */

const CURSOR_QUIET_MS = 5 * 60 * 1000;

const safeStringify = (value, indent = 2) => {
  try {
    return JSON.stringify(value, null, indent) ?? '';
  } catch (err) {
    return `(could not render this payload: ${err?.name ?? 'error'})`;
  }
};

/** Block types the grammar understands. A Set: `type` is vendor-written. */
const KNOWN_BLOCK_TYPES = new Set(['text', 'reasoning', 'redacted-reasoning', 'tool-call', 'tool-result']);

export async function parseCli(ref, opts = {}) {
  const collect = opts.collectDetails ?? false;
  const { db, close } = await openDb(ref.dbPath);
  try {
    if (!hasStoreTables(db)) throw new Error(`no blobs/meta tables — not a cursor-agent store.db`);
    const g = emptyGraph({
      runId: ref.runId,
      adapter: ADAPTER_NAME,
      kind: 'session',
      title: ref.title,
    });
    const stats = {
      // The CLI coverage unit: root field-1 ENTRIES walked.
      records: 0,
      unrecognized: 0,
      sourcesUnread: 0,
      toolCalls: 0,
      unmatchedResults: 0,
      unknownTypes: {},
      unknownBlockTypes: {},
    };

    const meta0 = readMeta0(db);
    const rootId = str(meta0?.latestRootBlobId);
    const root = rootId ? readBlob(db, rootId) : undefined;
    const ids = root ? rootMessageIds(root) : null;

    if (!meta0 || !rootId || !root || !ids) {
      // A missing/undecodable meta['0'], a missing latestRootBlobId, a missing
      // root, or a root the walker cannot parse: `records: 0, sourcesUnread: 1`
      // and an empty graph, with the run still listed.
      stats.sourcesUnread = 1;
      finishMeta(g, ref, meta0, stats, {
        rootUnreadable: !meta0 ? 'meta' : !rootId ? 'no-root-id' : !root ? 'root-missing' : 'root-unparseable',
      });
      return { ir: g, details: new Map() };
    }

    const walker = new ChatWalker(g, collect, stats);
    for (const id of ids) {
      stats.records++;
      const buf = readBlob(db, id);
      if (!buf) {
        stats.sourcesUnread++;
        continue;
      }
      const { json, miss } = decodeMessageBlob(buf);
      if (!json) {
        stats.unrecognized++;
        tallyUnknownType(stats.unknownTypes, miss === 'binary' ? 'blob' : 'message');
        continue;
      }
      walker.message(id, json);
    }
    walker.finish();
    finishMeta(g, ref, meta0, stats, { model: walker.model });
    return { ir: g, details: walker.details };
  } finally {
    await close();
  }
}

function finishMeta(g, ref, meta0, stats, extra) {
  const startedAt = iso(num(ref.createdAtMs) ?? num(meta0?.createdAt));
  if (startedAt) g.meta.startedAt = startedAt;
  const lastAt = num(ref.updatedAtMs);
  if (lastAt !== undefined && lastAt > 0 && Date.now() - lastAt >= CURSOR_QUIET_MS) {
    const endedAt = iso(lastAt);
    if (endedAt) g.meta.endedAt = endedAt;
  }
  g.meta.unrecognizedLineCount = stats.unrecognized;
  g.meta.coverage = {
    records: stats.records,
    unrecognized: stats.unrecognized,
    sourcesUnread: stats.sourcesUnread,
  };
  g.meta.totals = { tokens: 0, toolCalls: stats.toolCalls, agents: 0 };
  g.meta.ext = {
    [ADAPTER_NAME]: {
      surface: 'cli',
      ...(Number.isFinite(ref.schemaVersion) && ref.schemaVersion !== 1
        ? { cliSchemaVersion: ref.schemaVersion }
        : {}),
      ...(str(meta0?.mode) ? { mode: meta0.mode } : {}),
      ...(typeof meta0?.isRunEverything === 'boolean' ? { isRunEverything: meta0.isRunEverything } : {}),
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.rootUnreadable ? { rootUnreadable: extra.rootUnreadable } : {}),
      ...(stats.unmatchedResults > 0 ? { unmatchedResults: stats.unmatchedResults } : {}),
      ...(Object.keys(stats.unknownTypes).length > 0 ? { unknownTypes: stats.unknownTypes } : {}),
      ...(Object.keys(stats.unknownBlockTypes).length > 0 ? { unknownBlockTypes: stats.unknownBlockTypes } : {}),
    },
  };
}

// ---------------------------------------------------------------------------

class ChatWalker {
  constructor(g, collect, stats) {
    this.g = g;
    this.collect = collect;
    this.stats = stats;
    this.details = new Map();
    this.chainTip = null;
    this.pendingReason = null;
    this.turn = null;
    this.toolKey = new Map(); // tool node id → family
    this.toolFiles = new Map();
    this.toolPrev = new Map();
    this.open = new Map(); // toolCallId → { nodeId, family, args, callIndex, blobId }
    this.lastHumanId = null;
    this.lastDenialBlob = null; // the ASSISTANT blob whose call the last denial refused
    this.narration = null;
    this.live = new Set();
    this.created = [];
    this.model = undefined;
  }

  node(n) {
    // Blob ids are sha256(content). A root list that names one byte-identical
    // blob twice (nothing observed writes that, but nothing forbids it) must
    // not yield two nodes with one id — downstream maps key on it.
    if (this.g.nodes.some((x) => x.id === n.id)) {
      let k = 2;
      while (this.g.nodes.some((x) => x.id === `${n.id}:${k}`)) k++;
      n.id = `${n.id}:${k}`;
    }
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

  // ---- messages -----------------------------------------------------------

  message(blobId, msg) {
    const role = msg.role;
    if (role === 'system') return; // read; not a node
    if (role === 'user') return this.userMessage(blobId, msg);
    if (role === 'assistant') return this.assistantMessage(blobId, msg);
    if (role === 'tool') return this.toolMessage(blobId, msg);
    this.stats.unrecognized++;
    tallyUnknownType(this.stats.unknownTypes, typeof role === 'string' ? `role:${role}` : 'message');
  }

  blocks(msg) {
    if (!Array.isArray(msg.content)) return [];
    const out = [];
    for (const b of msg.content) {
      if (!b || typeof b !== 'object' || typeof b.type !== 'string') {
        tallyUnknownType(this.stats.unknownBlockTypes, 'block');
        continue;
      }
      if (!KNOWN_BLOCK_TYPES.has(b.type)) {
        tallyUnknownType(this.stats.unknownBlockTypes, b.type);
        continue;
      }
      out.push(b);
    }
    return out;
  }

  userMessage(blobId, msg) {
    // Injected context: `content` is a string, or the request-context flag is
    // set. Read, never rendered — nothing of it reaches the IR or details.
    if (typeof msg.content === 'string' || msg.providerOptions?.cursor?.requestContextCompleteness) return;
    const blocks = this.blocks(msg);
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    const { prompt, at } = unwrapUserQuery(text);
    this.closeTurn();
    this.narration = null;
    const node = this.node({
      id: `t:${short(blobId)}`,
      kind: 'turn',
      label: snippet(prompt) || '(empty prompt)',
      status: 'completed',
      ...(at ? { startedAt: at } : {}),
      hasDetail: true,
    });
    const id = node.id;
    this.chain(id);
    this.turn = { id, node, prompt, responseText: '' };
  }

  closeTurn() {
    const t = this.turn;
    this.turn = null;
    if (!t) return;
    // A turn is running iff one of ITS calls is still open — decided here,
    // at close, never by a flag set when the call was opened.
    if ([...this.open.values()].some((c) => c.turn === t)) t.node.status = 'running';
    if (this.collect) {
      this.details.set(t.id, { kind: 'turn', prompt: cap(t.prompt, 8000), responseText: cap(t.responseText, 8000) });
    }
  }

  assistantMessage(blobId, msg) {
    let i = 0;
    for (const b of this.blocks(msg)) {
      const index = i++;
      switch (b.type) {
        case 'text':
          if (str(b.text)) {
            if (this.turn) this.turn.responseText += (this.turn.responseText ? '\n\n' : '') + b.text;
            this.narration = b.text;
          }
          break;
        case 'reasoning':
        case 'redacted-reasoning': {
          const model = str(b.providerOptions?.cursor?.modelName);
          if (model && !this.model) this.model = model;
          break;
        }
        case 'tool-call':
          this.toolCall(blobId, index, b);
          break;
        default:
          break;
      }
    }
  }

  toolCall(blobId, index, b) {
    const family = str(b.toolName) ?? 'tool';
    const args = b.args && typeof b.args === 'object' ? b.args : {};
    const callId = str(b.toolCallId) ?? `${blobId}:${index}`;

    const tip = this.g.nodes.find((n) => n.id === this.chainTip);
    let nodeId;
    if (tip && tip.kind === 'tool' && this.toolKey.get(tip.id) === family) {
      tip.callCount += 1;
      nodeId = tip.id;
    } else {
      nodeId = this.node({
        id: `g:${short(blobId)}:${index}`,
        kind: 'tool',
        label: cliToolLabel(family, args),
        status: 'completed',
        callCount: 1,
        errorCount: 0,
        hasDetail: true,
      }).id;
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
    this.narration = null;
    this.stats.toolCalls++;

    // Open until its result arrives. Every call starts live and is settled
    // by toolMessage(); anything still open at finish() is `running`.
    this.live.add(nodeId);
    const paths = cliToolFiles(family, args);
    if (paths.length) this.attachFiles(nodeId, paths);
    let callIndex = -1;
    if (this.collect) {
      const calls = this.details.get(nodeId)?.calls;
      if (calls) {
        callIndex = calls.length;
        calls.push({ toolUseId: callId, input: cap(safeStringify(args), 3000), output: '', isError: false });
      }
    }
    this.open.set(callId, { nodeId, family, args, callIndex, turn: this.turn, assistantBlob: blobId });
  }

  toolMessage(blobId, msg) {
    for (const b of this.blocks(msg)) {
      if (b.type !== 'tool-result') continue;
      const callId = str(b.toolCallId);
      const call = callId ? this.open.get(callId) : undefined;
      if (!call) {
        this.stats.unmatchedResults++;
        continue;
      }
      this.open.delete(callId);
      const outcome = cliOutcome(msg, b);
      const failed = outcome === 'error' || outcome === 'rejected';
      const group = this.g.nodes.find((n) => n.id === call.nodeId);
      if (group && failed) group.errorCount += 1;
      // Settled: the node is live only while SOME call of its group is open.
      if (![...this.open.values()].some((c) => c.nodeId === call.nodeId)) this.live.delete(call.nodeId);

      const payload = cliResultPayload(msg);
      const durationMs = num(payload?.localExecutionTimeMs);
      if (this.collect && call.callIndex >= 0) {
        const entry = this.details.get(call.nodeId)?.calls?.[call.callIndex];
        if (entry) {
          entry.output = cap(typeof b.result === 'string' ? b.result : safeStringify(b.result), 4000);
          entry.isError = failed;
          if (durationMs !== undefined) entry.durationMs = durationMs;
        }
      }
      if (outcome === 'rejected') this.denial(blobId, call, b, payload);
      else if (outcome === 'error') this.pendingReason = `after ${call.family} error`;
    }
  }

  denial(blobId, call, block, payload) {
    // A refused parallel BATCH — several calls from ONE assistant message —
    // collapses into one human node. A retry the model issued AFTER seeing a
    // rejection is a new assistant message, and a second refusal of it is a
    // second decision: two nodes, two edges. The assistant-blob check is what
    // tells the two apart; chain adjacency alone cannot, because narration
    // between them is never a node.
    const prev = this.g.nodes.find((n) => n.id === this.lastHumanId);
    if (prev?.interventionKind === 'denial' && call.assistantBlob === this.lastDenialBlob) {
      prev.label = snippet(`${prev.label}, ${call.family}`, 60);
      this.edge('sequence', call.nodeId, prev.id);
      // The batch hangs off its one denial node: later nodes chain from it.
      this.chainTip = prev.id;
      return;
    }
    const node = this.node({
      id: `h:${short(blobId)}`,
      kind: 'human',
      label: `denied ${call.family}`,
      status: 'completed',
      interventionKind: 'denial',
      hasDetail: true,
    });
    const id = node.id;
    if (this.collect) {
      this.details.set(id, {
        kind: 'human',
        interventionKind: 'denial',
        context: cap(safeStringify(payload ?? call.args), 3000),
        answer: cap(typeof block.result === 'string' && block.result.trim() ? block.result : 'Rejected', 2000),
      });
    }
    // The tool→human edge comes from the REFUSED call's node and from nothing
    // else. In a parallel batch the chain tip may be a sibling (its results
    // land after later calls were opened); drawing the backbone edge from
    // that sibling would hand it a tool→denial edge too, and humanRefused()
    // in signals.js would then excuse the sibling's own error from
    // unresolved-error and retry-storm — a refusal of one call silencing a
    // failure of another. So the backbone edge is drawn only when the tip IS
    // the refused node; otherwise the explicit edge alone connects the node
    // and the tip simply moves on.
    if (this.chainTip === call.nodeId) {
      this.chain(id);
    } else {
      const e = this.edge('sequence', call.nodeId, id);
      if (e && this.pendingReason && !e.reason) {
        e.reason = this.pendingReason;
        this.pendingReason = null;
      }
      this.chainTip = id;
    }
    this.lastHumanId = id;
    this.lastDenialBlob = call.assistantBlob;
    this.pendingReason = 'after permission denial';
  }

  attachFiles(nodeId, paths) {
    this.toolFiles.set(nodeId, mergeFiles(this.toolFiles.get(nodeId), paths));
  }

  finish() {
    this.closeTurn();
    for (const n of this.created) {
      if (n.kind !== 'tool') continue;
      if (this.live.has(n.id)) n.status = 'running';
      else if (n.errorCount > 0 && n.errorCount >= n.callCount) n.status = 'error';
      if (n.callCount > 1) n.label = `${n.label} ×${n.callCount}`;
      const files = this.toolFiles.get(n.id);
      if (files?.length) n.files = files;
    }
  }
}

// ----------------------------------------------------------------- helpers

/** Stable, shorter node-id fragment of a 64-hex blob id. */
function short(blobId) {
  return typeof blobId === 'string' ? blobId.slice(0, 24) : String(blobId);
}

/**
 * The human's words out of the wrapped prompt text. Returns the
 * `<user_query>` body when the wrapper is present, the text itself when it is
 * not (an older build, or a shape not yet seen), and the `<timestamp>`
 * parsed to ISO when it matches the observed prose.
 */
export function unwrapUserQuery(text) {
  const s = typeof text === 'string' ? text : '';
  const q = /<user_query>([\s\S]*?)<\/user_query>/.exec(s);
  const ts = /<timestamp>([^<]*)<\/timestamp>/.exec(s);
  const prompt = (q ? q[1] : s.replace(/<timestamp>[^<]*<\/timestamp>\s*/, '')).trim();
  return { prompt, at: ts ? parseProseTimestamp(ts[1]) : undefined };
}

const MONTHS = { __proto__: null, jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * `Sunday, Aug 23, 2026, 1:25 PM (UTC-4)` → ISO. Local-time prose with its
 * own offset; ISO when it parses, undefined when it does not. Hand-written
 * rather than `Date.parse`, whose handling of the parenthesised offset is
 * engine-defined.
 */
export function parseProseTimestamp(text) {
  const m =
    /^\s*(?:[A-Za-z]+,\s*)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)\s*\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\)\s*$/i.exec(
      String(text ?? ''),
    );
  if (!m) return undefined;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return undefined;
  let hour = Number(m[4]) % 12;
  if (m[7].toUpperCase() === 'PM') hour += 12;
  const offsetMin = (Number(m[9]) * 60 + Number(m[10] ?? 0)) * (m[8] === '-' ? -1 : 1);
  const ms = Date.UTC(Number(m[3]), mon, Number(m[2]), hour, Number(m[5]), Number(m[6] ?? 0)) - offsetMin * 60_000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** `<Tool> · <hint>` for a CLI call — names are already plain. */
export function cliToolLabel(family, args, max = 40) {
  const hint = cliToolHint(family, args);
  if (!hint) return family;
  return snippet(`${family} · ${hint}`, max);
}

function cliToolHint(family, args) {
  if (!args || typeof args !== 'object') return undefined;
  switch (family) {
    case 'Shell':
      return str(args.description) ?? str(args.command);
    case 'Read':
    case 'StrReplace':
    case 'Write':
    case 'Delete':
      return baseName(args.path);
    case 'Grep':
      return str(args.pattern);
    case 'Glob':
      return str(args.glob_pattern) ?? str(args.pattern);
    default:
      return str(args.description) ?? str(args.path) ?? str(args.pattern) ?? str(args.query);
  }
}

/**
 * `StrReplace.args.path` and `Read.args.path` — the two observed file-naming
 * tools. Nothing else is a path here: precision over recall.
 */
export function cliToolFiles(family, args) {
  if (family !== 'Read' && family !== 'StrReplace') return [];
  const p = args?.path;
  return isPath(p) ? [p] : [];
}

function baseName(p) {
  if (typeof p !== 'string' || !p) return undefined;
  return p.split(/[\\/]/).filter(Boolean).pop();
}
