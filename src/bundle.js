import { gzipSync, gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { userInfo } from 'node:os';
import { findRun, ADAPTERS } from './scanner.js';
import { IR_VERSION } from './ir.js';
import { scanText, redactSecrets } from './secrets.js';

/**
 * `.rungraph` bundles — the share layer's file format. Gzipped JSON:
 *
 *   { bundleVersion, irVersion, sharedBy, exportedAt, redaction,
 *     runs: [{ runId, project, snapshot?, ir, details? }] }
 *
 * The bundle carries IR, not raw transcripts: redaction operates on one
 * documented schema instead of every vendor's format, vendor neutrality
 * survives sharing, and the viewer needs no adapters to open one. Detail
 * payloads are embedded eagerly — a bundle has no transcript files to fetch
 * them from lazily — which is why export is a distinct code path rather than
 * "serialize what the server has". Signals are NOT stored: the viewer derives
 * them at view time like for any local run, so a bundle written by an older
 * rungraph gets the viewer's current, calibrated signal layer for free.
 *
 * `bundleVersion` governs the envelope, `irVersion` the payload. The viewer
 * refuses newer values of either with a named upgrade message — never a blank
 * screen or a partial render that silently drops fields.
 */

export const BUNDLE_VERSION = 1;

/** Redaction tiers, in decreasing fidelity. */
export const REDACTIONS = ['full', 'redact-secrets', 'structure-only'];

/**
 * `sharedBy` default: the OS username. An unverified display string either
 * way — a bundle asserts, not proves, its sender.
 */
export function defaultSharedBy() {
  try {
    return process.env.USER || process.env.USERNAME || userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** `<project>-<date>.rungraph`, from the first run's project directory name. */
export function defaultBundleName(envelope) {
  const project = envelope.runs?.[0]?.project;
  const base = (project ? basename(project) : '') || 'runs';
  const date = String(envelope.exportedAt ?? '').slice(0, 10) || 'export';
  return `${base}-${date}.rungraph`;
}

/* ------------------------------------------------------------------- build */

/**
 * Build a bundle from run ids. Workflow runs referenced by `runRef` are
 * included transitively — a workflow node drills into its own graph, and a
 * bundle missing those IRs would break drill-down for the recipient.
 *
 * The secrets scan runs on whatever actually leaves, at every redaction tier
 * (structure-only output included: paths and mechanical labels can carry
 * tokens too). It FAILS CLOSED — a scanner error blocks the export, because
 * the safe default for an outbound artifact is "did not leave".
 *
 * @param {string[]} runIds
 * @param {{ sharedBy?: string, redaction?: 'full'|'redact-secrets'|'structure-only',
 *           allowSecrets?: boolean, now?: string }} [opts]
 * @returns {Promise<{ blocked: boolean, findings: object[], inventory: object,
 *                     warnings: string[], envelope: object, buffer?: Buffer }>}
 */
export async function buildBundle(runIds, opts = {}) {
  const redaction = opts.redaction ?? 'full';
  if (!REDACTIONS.includes(redaction)) throw new Error(`unknown redaction "${redaction}"`);

  const warnings = [];
  const runs = [];
  const seen = new Set();
  const queue = [...runIds];
  const requested = new Set(runIds);
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const ref = await findRun(id);
    if (!ref) {
      if (requested.has(id)) throw new Error(`no run found with id "${id}"`);
      warnings.push(`workflow run "${id}" is referenced but no longer on disk — drill-down will miss it`);
      continue;
    }
    const adapter = ADAPTERS.find((a) => a.name === ref.adapter);
    const { ir, details } = await adapter.parse(ref, { collectDetails: true });
    // Follow drill-in references BEFORE any transform strips them… they are
    // retained by every tier, but the order documents the dependency.
    for (const n of ir.nodes) {
      if (typeof n.runRef === 'string' && n.runRef) queue.push(n.runRef);
    }
    const entry = { runId: ref.runId, project: ref.project };
    // A run that appears live exports as-is — the parser tolerates mid-write
    // truncation by design — and carries a snapshot stamp for provenance.
    // "Looks live" is the IR's own signal: endedAt is absent while it does.
    if (!ir.meta.endedAt) entry.snapshot = opts.now ?? new Date().toISOString();
    if (redaction === 'structure-only') {
      entry.ir = structureOnly(ir);
    } else {
      entry.ir = ir;
      entry.details = Object.fromEntries(details);
    }
    runs.push(entry);
  }

  const envelope = {
    bundleVersion: BUNDLE_VERSION,
    irVersion: IR_VERSION,
    sharedBy: opts.sharedBy || 'unknown',
    exportedAt: opts.now ?? new Date().toISOString(),
    redaction,
    runs,
  };

  const findings = scanEnvelope(envelope);
  let blocked = false;
  if (redaction === 'redact-secrets') {
    redactEnvelope(envelope);
    // Verify, never assume: if anything still matches on the wire form, the
    // redactor has a hole and the export must not leave.
    if (scanText(JSON.stringify(envelope)).length > 0) {
      throw new Error('redaction left a matching secret in the output');
    }
  } else if (findings.length > 0 && !opts.allowSecrets) {
    blocked = true;
  }

  const inventory = buildInventory(envelope, findings, warnings);
  const out = { blocked, findings, inventory, warnings, envelope };
  if (!blocked) out.buffer = gzipSync(Buffer.from(JSON.stringify(envelope)));
  return out;
}

/* --------------------------------------------------------- structure-only */

/**
 * The structure-only tier. Governing rule: DERIVED AND MECHANICAL SURVIVES;
 * AUTHORED TEXT DIES.
 *
 * Retained: ids, kinds, status, error/call counts, timings, token counts,
 * models, files[], groups, edges (shape only), run meta totals, tool-node
 * labels (mechanical, path-level — "Edit src/auth.js ×3") and workflow names
 * (script identifiers). Dropped: every detail payload, prompt-derived titles,
 * `ext` bags (free-form, unauditable), and edge label/reason — spawn labels
 * are prompt snippets and `reason` can quote answered questions verbatim
 * ("answer: use the staging DB"), which is authored text.
 *
 * Turn, human and agent labels are replaced with generic positional ones: a
 * structure-only bundle still answers "where was feature X built" through
 * file paths and tool labels, it just cannot answer "what did they say".
 */
export function structureOnly(ir) {
  const unknownTypes = unknownTypesExt(ir.meta.ext);
  const g = {
    irVersion: ir.irVersion,
    meta: {
      runId: ir.meta.runId,
      adapter: ir.meta.adapter,
      kind: ir.meta.kind,
      title: `${ir.meta.kind} (structure only)`,
      ...(ir.meta.startedAt ? { startedAt: ir.meta.startedAt } : {}),
      ...(ir.meta.endedAt ? { endedAt: ir.meta.endedAt } : {}),
      totals: ir.meta.totals,
      unrecognizedLineCount: ir.meta.unrecognizedLineCount,
      // Coverage survives every tier, `ext` bags dropping included: it is
      // integers about transcript STRUCTURE plus record-type names bounded by
      // the coverage sanitizer — no content, no paths, no secrets exposure —
      // and a recipient who cannot tell "clean" from "unread" is exactly the
      // person the coverage layer exists for.
      ...(ir.meta.coverage ? { coverage: ir.meta.coverage } : {}),
      ...(unknownTypes ? { ext: unknownTypes } : {}),
    },
    nodes: [],
    edges: [],
    groups: (ir.groups ?? []).map((grp) => ({ id: grp.id, label: grp.label })),
  };
  let turnN = 0;
  let agentN = 0;
  const NODE_KEEP = [
    'id', 'kind', 'status', 'startedAt', 'endedAt', 'durationMs', 'tokens', 'model',
    'agentId', 'callCount', 'errorCount', 'runRef', 'interventionKind', 'group', 'files',
  ];
  const HUMAN_LABELS = { denial: 'denial', interrupt: 'interrupt', answer: 'answered a question' };
  for (const n of ir.nodes ?? []) {
    const keep = pick(n, NODE_KEEP);
    if (n.kind === 'turn') keep.label = `turn ${++turnN}`;
    else if (n.kind === 'agent') keep.label = `agent ${++agentN}`;
    else if (n.kind === 'human') keep.label = HUMAN_LABELS[n.interventionKind] ?? 'intervention';
    else if (n.kind === 'tool') keep.label = structureToolLabel(n);
    else keep.label = n.label; // workflow names are script identifiers
    g.nodes.push(keep);
  }
  for (const e of ir.edges ?? []) {
    g.edges.push(pick(e, ['id', 'kind', 'from', 'to']));
  }
  return g;
}

/**
 * The one part of an `ext` bag structure-only keeps: `unknownTypes`. The rest
 * of the bag is free-form and unauditable, which is why the tier drops it; the
 * type names are bounded and carry no authored text.
 */
function unknownTypesExt(ext) {
  if (!ext || typeof ext !== 'object') return null;
  // Null-prototype: vendor keys come from an IR that may have been written by
  // another machine, and `out['__proto__'] = …` on a plain object silently
  // reassigns a prototype instead of storing the bag.
  const out = { __proto__: null };
  for (const [vendor, bag] of Object.entries(ext)) {
    const t = bag && typeof bag === 'object' ? bag.unknownTypes : null;
    if (t && typeof t === 'object' && Object.keys(t).length > 0) out[vendor] = { unknownTypes: t };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * A tool label safe for the structure-only tier. Adapters write
 * "<Tool> · <hint> ×N", and the hint is only SOMETIMES mechanical: a file
 * basename is, but a Bash command/description, a Grep pattern or a WebSearch
 * query is authored text — exactly what this tier promises not to ship. The
 * rule applied here: the hint survives only when it is path-level, i.e. it
 * names a file the node's own `files[]` already carries; everything else
 * reduces to the bare tool name (plus the call count).
 */
function structureToolLabel(n) {
  const label = typeof n.label === 'string' ? n.label : '';
  const counted = label.match(/^(.*) (×\d+)$/);
  const base = counted ? counted[1] : label;
  const suffix = counted ? ` ${counted[2]}` : '';
  const sep = base.indexOf(' · ');
  if (sep === -1) return base + suffix; // bare tool name already
  const family = base.slice(0, sep);
  const hint = base.slice(sep + 3);
  const pathLevel = (n.files ?? []).some(
    (f) => typeof f === 'string' && (f === hint || f.endsWith(`/${hint}`) || f.endsWith(`\\${hint}`)),
  );
  return (pathLevel ? base : family) + suffix;
}

/* ---------------------------------------------------------------- scanning */

/**
 * Deep-walk every string in the envelope (labels, detail payloads, file
 * paths, meta, `ext` bags — everything that would leave the machine) and scan
 * each. Walking the object rather than the serialized JSON keeps locations:
 * a finding names its run, node, and place, so the fix is a decision instead
 * of a search.
 *
 * @returns {Array<{runId: string|null, nodeId: string|null, where: string,
 *                  kind: string, name: string, hint: string, count: number}>}
 */
export function scanEnvelope(envelope) {
  const byKey = new Map();
  walkStrings(envelope, [], (path, text) => {
    for (const hit of scanText(text)) {
      const loc = describeLocation(envelope, path);
      const key = JSON.stringify([loc.runId, loc.nodeId, loc.where, hit.kind]);
      const cur = byKey.get(key);
      if (cur) cur.count += hit.count;
      else byKey.set(key, { ...loc, kind: hit.kind, name: hit.name, hint: hit.hint, count: hit.count });
    }
  });
  return [...byKey.values()];
}

function redactEnvelope(envelope) {
  walkStrings(envelope, [], (path, text, set) => {
    const { text: out, redacted } = redactSecrets(text);
    if (redacted > 0) set(out);
  });
}

function walkStrings(value, path, visit) {
  if (typeof value === 'string') return; // root string — no setter, callers pass objects
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (typeof v === 'string') visit([...path, i], v, (nv) => (value[i] = nv));
      else if (v && typeof v === 'object') walkStrings(v, [...path, i], visit);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') visit([...path, k], v, (nv) => (value[k] = nv));
      else if (v && typeof v === 'object') walkStrings(v, [...path, k], visit);
    }
  }
}

/** Resolve a walk path to { runId, nodeId, where } for the findings listing. */
function describeLocation(envelope, path) {
  if (path[0] !== 'runs') return { runId: null, nodeId: null, where: path.join('.') };
  const run = envelope.runs[path[1]];
  const runId = run?.runId ?? null;
  const rest = path.slice(2);

  if (rest[0] === 'ir') {
    const [, section, idx, field, sub] = rest;
    if (section === 'nodes') {
      const node = run.ir.nodes?.[idx];
      const where = field === 'files' ? 'file path' : field === 'label' ? 'node label' : `node ${field}`;
      return { runId, nodeId: node?.id ?? null, where };
    }
    if (section === 'edges') {
      return { runId, nodeId: run.ir.edges?.[idx]?.id ?? null, where: `edge ${field}` };
    }
    if (section === 'groups') return { runId, nodeId: null, where: 'group label' };
    if (section === 'meta') return { runId, nodeId: null, where: `run ${idx}` };
    return { runId, nodeId: null, where: rest.join('.') };
  }

  if (rest[0] === 'details') {
    const nodeId = rest[1];
    const detail = run.details?.[nodeId];
    const field = rest[2];
    const toolName = detail?.name ?? 'tool';
    const WHERE = {
      turn: { prompt: 'your prompt', responseText: 'assistant response' },
      agent: { prompt: 'agent prompt', result: 'agent result', transcript: 'agent transcript' },
      tool: { name: 'tool name', context: 'tool narration', calls: null }, // calls handled below
      human: { context: 'intervention context', answer: 'intervention text' },
      workflow: { returnValue: 'workflow result' },
    };
    if (detail?.kind === 'tool' && field === 'calls') {
      const callField = rest[4];
      return { runId, nodeId, where: `${toolName} ${callField === 'input' ? 'input' : 'output'}` };
    }
    const where = WHERE[detail?.kind]?.[field] ?? `detail ${field}`;
    return { runId, nodeId, where };
  }

  return { runId, nodeId: null, where: rest.join('.') };
}

/* --------------------------------------------------------------- inventory */

/**
 * Filename shapes that earn a call-out in the export inventory. Precision
 * over recall — a noisy inventory is skimmed, not read — so this is
 * credential-adjacent names only, not every dotfile in a repo.
 */
const SENSITIVE_PATH = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i, // .env, .env.local, …
  /(^|[\\/])(\.netrc|\.npmrc|\.pypirc)$/i, // auth-bearing tool configs
  /\.(pem|key|p12|pfx)$/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.[^\\/]*)?$/i,
  /[\\/]\.(ssh|aws|gnupg)[\\/]/i,
  /(^|[\\/])credentials(\.[^\\/]*)?$/i,
];

export function isSensitivePath(path) {
  return typeof path === 'string' && SENSITIVE_PATH.some((re) => re.test(path));
}

/**
 * What is about to leave the machine, computed from the envelope that
 * actually will. People do not realize how much lives in a transcript; this
 * makes it visible before it goes.
 */
function buildInventory(envelope, findings, warnings) {
  const files = [];
  const seenFiles = new Set();
  let nodeCount = 0;
  let promptCount = 0;
  const runs = envelope.runs.map((run) => {
    const nodes = run.ir.nodes ?? [];
    nodeCount += nodes.length;
    for (const n of nodes) {
      for (const f of n.files ?? []) {
        if (!seenFiles.has(f)) {
          seenFiles.add(f);
          files.push(f);
        }
      }
    }
    // Prompts leave only when detail payloads do — structure-only ships none.
    const prompts = run.details
      ? nodes.filter((n) => n.kind === 'turn').length
      : 0;
    promptCount += prompts;
    return {
      runId: run.runId,
      title: run.ir.meta?.title ?? '',
      kind: run.ir.meta?.kind ?? 'session',
      nodeCount: nodes.length,
      ...(run.snapshot ? { snapshot: run.snapshot } : {}),
    };
  });
  return {
    redaction: envelope.redaction,
    sharedBy: envelope.sharedBy,
    runCount: runs.length,
    runs,
    nodeCount,
    promptCount,
    files,
    sensitiveFiles: files.filter(isSensitivePath),
    findingCount: findings.reduce((t, f) => t + f.count, 0),
    warnings,
  };
}

/* -------------------------------------------------------------------- read */

/**
 * Decode a `.rungraph` buffer. Throws with a message written for the banner:
 * bad gzip/JSON and unknown versions are NAMED, never a blank screen — and a
 * newer bundle is refused outright rather than partially rendered with
 * silently dropped fields.
 */
export function decodeBundle(buf) {
  let json;
  try {
    json = gunzipSync(buf).toString('utf8');
  } catch {
    throw new Error('not a .rungraph bundle (gzip decode failed)');
  }
  let envelope;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new Error('corrupt bundle (gzip decoded, but the JSON inside is truncated or invalid)');
  }
  if (!envelope || typeof envelope !== 'object' || !Number.isInteger(envelope.bundleVersion)) {
    throw new Error('not a .rungraph bundle (no bundleVersion)');
  }
  if (envelope.bundleVersion > BUNDLE_VERSION) {
    throw new Error(
      `bundle version ${envelope.bundleVersion} is newer than this rungraph understands (${BUNDLE_VERSION}) — upgrade with \`npm i -g rungraph\``,
    );
  }
  if (Number.isInteger(envelope.irVersion) && envelope.irVersion > IR_VERSION) {
    throw new Error(
      `bundle carries irVersion ${envelope.irVersion}, newer than this rungraph understands (${IR_VERSION}) — upgrade with \`npm i -g rungraph\``,
    );
  }
  if (!Array.isArray(envelope.runs)) {
    throw new Error('corrupt bundle (no runs array)');
  }
  return envelope;
}

/** Read + decode one bundle file. Same named-error contract as decodeBundle. */
export async function loadBundleFile(path) {
  let buf;
  try {
    buf = await readFile(path);
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err?.code ?? err?.message ?? err}`);
  }
  return { fileName: basename(path), envelope: decodeBundle(buf) };
}

/**
 * Index entry for a bundle-served run. Provenance lives HERE, on the index
 * entry, not inside the IR: `sharedBy`/`bundle`/`exportedAt` describe the
 * transfer, not the run, so the IR stays untouched (no irVersion
 * implications) and every consumer that tolerates `provenance` absence keeps
 * working on local runs.
 */
export function bundleRunEntry(run, envelope, fileName) {
  const meta = run.ir?.meta ?? {};
  return {
    runId: run.runId,
    adapter: meta.adapter ?? 'unknown',
    kind: meta.kind ?? 'session',
    title: meta.title ?? '(untitled)',
    project: typeof run.project === 'string' ? run.project : null,
    startedAt: meta.startedAt ?? null,
    modifiedAt: meta.endedAt ?? meta.startedAt ?? envelope.exportedAt,
    sizeBytes: null,
    active: false, // bundles are static: no watcher, liveness is always "complete"
    provenance: {
      sharedBy: envelope.sharedBy ?? 'unknown',
      bundle: fileName,
      exportedAt: envelope.exportedAt ?? null,
      ...(run.snapshot ? { snapshot: run.snapshot } : {}),
    },
  };
}
