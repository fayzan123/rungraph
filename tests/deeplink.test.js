import { describe, expect, it } from 'vitest';
import {
  buildFocusHash,
  decodeDescriptor,
  descriptorFromFocus,
  encodeDescriptor,
  normalizeDescriptor,
  parseFocusHash,
} from '../src/deeplink.js';

// Same purity contract as find.js: the frontend bundle imports this file
// directly, so a node: import would break it.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('purity contract', () => {
  it('deeplink.js has no imports at all', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'deeplink.js'),
      'utf8',
    );
    expect(src).not.toMatch(/^\s*import /m);
    expect(src).not.toMatch(/require\(/);
  });
});

describe('descriptor round-trips', () => {
  const CASES = [
    { source: 'find', query: 'auth token' },
    { source: 'signal', signalId: 'sig:retry-storm:g:toolu_01' },
    { source: 'file', path: '/abs/path/src/auth/tökén.js' }, // non-ASCII survives
    { source: 'agent', nodeIds: ['a:1', 'g:2'], label: '6 failed edits', reason: 'why — “quoted”' },
  ];
  for (const desc of CASES) {
    it(`${desc.source} survives encode → decode`, () => {
      expect(decodeDescriptor(encodeDescriptor(desc))).toEqual(desc);
    });
  }

  it('encoded form is URL-hash-safe base64url', () => {
    const s = encodeDescriptor(CASES[3]);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('descriptor validation — links arrive from anywhere', () => {
  it('rejects garbage without throwing', () => {
    expect(decodeDescriptor('%%%')).toBeNull();
    expect(decodeDescriptor('')).toBeNull();
    expect(decodeDescriptor('AAAA')).toBeNull(); // valid base64url, not JSON
    expect(decodeDescriptor(encodeDescriptor({ source: 'find', query: 'x' }) + '!!')).toBeNull();
  });

  it('rejects unknown sources and malformed shapes', () => {
    expect(normalizeDescriptor({ source: 'telepathy' })).toBeNull();
    expect(normalizeDescriptor({ source: 'find', query: '   ' })).toBeNull();
    expect(normalizeDescriptor({ source: 'signal' })).toBeNull();
    expect(normalizeDescriptor({ source: 'agent', nodeIds: [] })).toBeNull();
    expect(normalizeDescriptor({ source: 'agent', nodeIds: [1, 2] })).toBeNull();
    expect(normalizeDescriptor(null)).toBeNull();
  });

  it('drops extra fields — the descriptor is a contract, not a bag', () => {
    const d = normalizeDescriptor({ source: 'find', query: 'x', evil: 'payload' });
    expect(d).toEqual({ source: 'find', query: 'x' });
  });
});

describe('hash build and parse', () => {
  it('round-trips run + selection + descriptor', () => {
    const hash = buildFocusHash({
      runId: 'claude-code:-home-dev-acme:1111',
      sel: 'g:toolu_01',
      descriptor: { source: 'find', query: 'auth' },
    });
    expect(hash.startsWith('#run=')).toBe(true);
    expect(parseFocusHash(hash)).toEqual({
      runId: 'claude-code:-home-dev-acme:1111',
      sel: 'g:toolu_01',
      descriptor: { source: 'find', query: 'auth' },
    });
  });

  it('a run alone still links', () => {
    const hash = buildFocusHash({ runId: 'r1' });
    expect(parseFocusHash(hash)).toEqual({ runId: 'r1', sel: null, descriptor: null });
  });

  it('an unrelated fragment is not mistaken for a broken deep link', () => {
    expect(parseFocusHash('#section-3')).toBeNull();
    expect(parseFocusHash('')).toBeNull();
    expect(parseFocusHash(null)).toBeNull();
  });

  it('a link with a mangled descriptor still restores the run', () => {
    const parsed = parseFocusHash('#run=r1&f=%%%broken');
    expect(parsed.runId).toBe('r1');
    expect(parsed.descriptor).toBeNull();
  });

  it('nothing to link to yields nothing', () => {
    expect(buildFocusHash({})).toBe('');
    expect(buildFocusHash({ runId: '' })).toBe('');
  });
});

describe('descriptorFromFocus — links name the source, not the members', () => {
  it('producer-backed focuses become re-executable descriptors', () => {
    expect(descriptorFromFocus({ source: 'find', query: 'auth', nodeIds: ['a', 'b'] })).toEqual({
      source: 'find',
      query: 'auth',
    });
    expect(
      descriptorFromFocus({ source: 'signal', signalId: 'sig:x', nodeIds: ['a'] }),
    ).toEqual({ source: 'signal', signalId: 'sig:x' });
    expect(descriptorFromFocus({ source: 'file', path: '/p', nodeIds: [] })).toEqual({
      source: 'file',
      path: '/p',
    });
  });

  it('agent focuses keep their explicit ids — they have no query to re-run', () => {
    expect(
      descriptorFromFocus({ source: 'agent', nodeIds: ['a'], label: 'l', reason: 'r' }),
    ).toEqual({ source: 'agent', nodeIds: ['a'], label: 'l', reason: 'r' });
  });

  it('null focus yields null', () => {
    expect(descriptorFromFocus(null)).toBeNull();
  });
});
