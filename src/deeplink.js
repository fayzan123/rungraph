/**
 * Deep-link descriptor codec — focus state in the URL hash.
 *
 * A link names a focus **by its source, not by its members**: `find`, `signal`
 * and `file` descriptors re-execute on load (one matcher, one signal
 * derivation, one attribution source — a link and a fresh query can never
 * disagree). Only agent-sourced sets are explicit ids, because they have no
 * query to re-run.
 *
 * One implementation, three consumers: the frontend bundle (copy-link and
 * restore-on-load), `focus_nodes` in src/mcp.js (which returns a pastable
 * link), and the tests. Same contract as src/find.js:
 *
 * PURITY CONTRACT: no Node builtins, no imports at all. TextEncoder/
 * TextDecoder/URLSearchParams are globals in both the browser and Node ≥ 20.
 */

const SOURCES = new Set(['find', 'signal', 'file', 'agent']);
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A validated descriptor, or null. Never throws — descriptors arrive from
 * URLs, which arrive from anywhere.
 *
 * @param {unknown} d
 * @returns {object|null}
 */
export function normalizeDescriptor(d) {
  if (!d || typeof d !== 'object' || !SOURCES.has(d.source)) return null;
  switch (d.source) {
    case 'find':
      return typeof d.query === 'string' && d.query.trim()
        ? { source: 'find', query: d.query }
        : null;
    case 'signal':
      return typeof d.signalId === 'string' && d.signalId
        ? { source: 'signal', signalId: d.signalId }
        : null;
    case 'file':
      return typeof d.path === 'string' && d.path ? { source: 'file', path: d.path } : null;
    case 'agent': {
      const nodeIds = Array.isArray(d.nodeIds)
        ? d.nodeIds.filter((x) => typeof x === 'string' && x)
        : [];
      if (nodeIds.length === 0) return null;
      return {
        source: 'agent',
        nodeIds,
        label: typeof d.label === 'string' ? d.label : '',
        reason: typeof d.reason === 'string' ? d.reason : '',
      };
    }
    default:
      return null;
  }
}

/** The descriptor for an in-app FocusSet (see frontend/src/focus.js), or null. */
export function descriptorFromFocus(focus) {
  if (!focus) return null;
  switch (focus.source) {
    case 'find':
      return normalizeDescriptor({ source: 'find', query: focus.query });
    case 'signal':
      return normalizeDescriptor({ source: 'signal', signalId: focus.signalId });
    case 'file':
      return normalizeDescriptor({ source: 'file', path: focus.path });
    case 'agent':
      return normalizeDescriptor({
        source: 'agent',
        nodeIds: focus.nodeIds,
        label: focus.label,
        reason: focus.reason,
      });
    default:
      return null;
  }
}

/** @param {object} descriptor → base64url string ('' for an invalid one). */
export function encodeDescriptor(descriptor) {
  const d = normalizeDescriptor(descriptor);
  if (!d) return '';
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    if (b !== undefined) out += B64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    if (c !== undefined) out += B64[c & 63];
  }
  return out;
}

/** base64url string → validated descriptor, or null on any kind of garbage. */
export function decodeDescriptor(text) {
  if (typeof text !== 'string' || !text || /[^A-Za-z0-9_-]/.test(text)) return null;
  try {
    const bytes = [];
    for (let i = 0; i < text.length; i += 4) {
      const n = [0, 1, 2, 3].map((k) => B64.indexOf(text[i + k] ?? 'A'));
      if (n.some((x) => x === -1)) return null;
      bytes.push((n[0] << 2) | (n[1] >> 4));
      if (text[i + 2] !== undefined) bytes.push(((n[1] & 15) << 4) | (n[2] >> 2));
      if (text[i + 3] !== undefined) bytes.push(((n[2] & 3) << 6) | n[3]);
    }
    return normalizeDescriptor(JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))));
  } catch {
    return null;
  }
}

/**
 * Build the URL hash for a view: run, optional selected node, optional focus
 * descriptor. Returns '' when there is nothing to link to.
 */
export function buildFocusHash({ runId, sel, descriptor } = {}) {
  if (typeof runId !== 'string' || !runId) return '';
  const params = new URLSearchParams();
  params.set('run', runId);
  if (typeof sel === 'string' && sel) params.set('sel', sel);
  const f = descriptor ? encodeDescriptor(descriptor) : '';
  if (f) params.set('f', f);
  return '#' + params.toString();
}

/**
 * Parse a location.hash back into { runId, sel, descriptor }.
 * Returns null when the hash is not a rungraph deep link — an unrelated
 * fragment must not be mistaken for a broken one.
 */
export function parseFocusHash(hash) {
  if (typeof hash !== 'string') return null;
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text.includes('run=')) return null;
  let params;
  try {
    params = new URLSearchParams(text);
  } catch {
    return null;
  }
  const runId = params.get('run');
  if (!runId) return null;
  return {
    runId,
    sel: params.get('sel') || null,
    descriptor: decodeDescriptor(params.get('f') ?? '') ?? null,
  };
}
