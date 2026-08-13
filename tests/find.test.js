import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { matchNodes, matchesNode, normalizeQuery } from '../src/find.js';
import { pinFixtureMtimes, FIXTURE_ROOT, SESSION_RUN_ID, TROUBLE_RUN_ID } from './helpers.js';

let session;
let trouble;
beforeAll(async () => {
  await pinFixtureMtimes();
  const refs = await detect([FIXTURE_ROOT]);
  session = (await parse(refs.find((r) => r.runId === SESSION_RUN_ID))).ir;
  trouble = (await parse(refs.find((r) => r.runId === TROUBLE_RUN_ID))).ir;
});

const labels = (ir, ids) => ir.nodes.filter((n) => ids.includes(n.id)).map((n) => n.label);

describe('matchNodes', () => {
  it('matches node labels, case-insensitively', () => {
    expect(labels(session, matchNodes(session, 'grep'))).toEqual(['Grep · waitForURL']);
    expect(matchNodes(session, 'GREP')).toEqual(matchNodes(session, 'grep'));
  });

  it('matches file paths a node touched, not just its label', () => {
    // "token.js" appears in no label — the Read and the Edit are found purely
    // through files[], which is the whole point of Phase 2 for search.
    const ids = matchNodes(trouble, 'token.js');
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const node = trouble.nodes.find((n) => n.id === id);
      expect(node.files.some((f) => f.includes('token.js'))).toBe(true);
    }
    expect(labels(trouble, ids).some((l) => l.startsWith('Read'))).toBe(true);
  });

  it('finds work done inside a subagent through the agent node files', () => {
    const ids = matchNodes(session, 'src/auth/session.ts');
    const kinds = session.nodes.filter((n) => ids.includes(n.id)).map((n) => n.kind);
    expect(kinds).toContain('agent');
  });

  it('an empty query matches nothing — not everything', () => {
    for (const q of ['', '   ', null, undefined, 42]) expect(matchNodes(session, q)).toEqual([]);
  });

  it('returns ids in IR order, without duplicates', () => {
    const ids = matchNodes(session, 'e'); // deliberately broad
    const order = session.nodes.map((n) => n.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(order);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tolerates a malformed IR and hostile nodes', () => {
    expect(matchNodes(null, 'x')).toEqual([]);
    expect(matchNodes({ nodes: [{ id: 'a', label: 7, files: [null, 3] }] }, 'x')).toEqual([]);
    expect(matchesNode(null, 'x')).toBe(false);
    expect(normalizeQuery('  Foo ')).toBe('foo');
  });

  // The frontend imports this module straight out of src/ so the human's find
  // and the agent's find can never disagree. A single `node:` import would
  // break the bundle — and would be found at build time, not here, so assert it.
  // A NUL byte makes grep and ripgrep classify a source file as binary and
  // return nothing at all — silently. It cost a real debugging session: a
  // delimiter chosen to be collision-proof blinded every tool used to read the
  // file it was in.
  it('no source file contains a NUL byte, so the tree stays greppable', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const dirs = ['src', join('src', 'adapters', 'claude-code'), join('frontend', 'src')];
    for (const dir of dirs) {
      for (const name of await readdir(join(root, dir))) {
        if (!/\.(js|jsx|css)$/.test(name)) continue;
        const buf = await readFile(join(root, dir, name));
        expect(buf.includes(0), `${dir}/${name} contains a NUL byte`).toBe(false);
      }
    }
  });

  it('imports nothing, so the frontend bundle can consume it', async () => {
    const src = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'find.js'),
      'utf8',
    );
    // Comments are allowed to *mention* node: — only the code must be clean.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\(|['"]node:|process\./);
  });
});
