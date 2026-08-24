import { beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { toolNodeLabel } from '../src/adapters/claude-code/helpers.js';
import { filePathsFromToolInput, mergeFiles } from '../src/adapters/claude-code/files.js';
import { isKnownMainLine } from '../src/adapters/claude-code/helpers.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  EMPTY_RUN_ID,
  TROUBLE_RUN_ID,
  CLEAN_RUN_ID,
  COMPACT_RUN_ID,
} from './helpers.js';

let refs;
beforeAll(async () => {
  await pinFixtureMtimes();
  refs = await detect([FIXTURE_ROOT]);
});

const ref = (runId) => refs.find((r) => r.runId === runId);

describe('detect', () => {
  it('finds sessions and workflow runs with titles', () => {
    const index = refs.map(({ runId, kind, title, project, startedAt, sizeBytes }) => ({
      runId,
      kind,
      title,
      project,
      startedAt,
      sizeBytes,
    }));
    expect(index).toMatchSnapshot();
  });
});

describe('toolNodeLabel', () => {
  it('names MCP tools by tool and server, never by the raw mcp__ id', () => {
    expect(toolNodeLabel('mcp__claude-in-chrome__computer', {})).toBe('computer · claude-in-chrome');
    expect(toolNodeLabel('mcp__rungraph__focus_nodes', { runId: 'x' })).toBe('focus_nodes · rungraph');
    // Plain tools are untouched, and a name that merely starts with mcp is not an MCP id.
    expect(toolNodeLabel('Bash', { command: 'ls' })).toBe('Bash · ls');
    expect(toolNodeLabel('mcpish', {})).toBe('mcpish');
  });
});

describe('parse: session', () => {
  it('produces the expected IR', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  it('holds graph invariants', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const ids = new Set(ir.nodes.map((n) => n.id));
    expect(ids.size).toBe(ir.nodes.length);
    for (const e of ir.edges) {
      expect(ids.has(e.from), `edge from ${e.from}`).toBe(true);
      expect(ids.has(e.to), `edge to ${e.to}`).toBe(true);
    }
    expect(ir.irVersion).toBe(1);
  });

  it('counts unknown line types instead of failing', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    expect(ir.meta.unrecognizedLineCount).toBe(2); // "holo-recap" + an "atis-latch" of an unseen SHAPE
    // …and names them, because a count alone cannot tell one benign metadata
    // type from four hundred missing assistant turns.
    expect(ir.meta.ext.claudeCode.unknownTypes).toEqual({ 'holo-recap': 1, 'atis-latch': 1 });
  });

  it('recognizes a shape-gated line type only in the shape it was observed in', async () => {
    // `atis-latch` is `{type, atis, sessionId}` and nothing else — `atis`
    // empty or an opaque token, both observed. The same type carrying an
    // extra key is NOT recognized, because swallowing it silently would
    // report 100% coverage over content nobody read. `bridge-session` is the
    // remote-control bridge's record, six known keys and no content.
    const clean = (await parse(ref(CLEAN_RUN_ID))).ir;
    expect(clean.meta.unrecognizedLineCount).toBe(0);
    expect(clean.nodes.some((n) => /atis|bridge/i.test(n.label))).toBe(false);
    expect(isKnownMainLine({ type: 'atis-latch', atis: '', sessionId: 's' })).toBe(true);
    expect(isKnownMainLine({ type: 'atis-latch', sessionId: 's' })).toBe(true);
    expect(isKnownMainLine({ type: 'atis-latch', atis: 'c3220c7ab05b70ed', sessionId: 's' })).toBe(true);
    expect(isKnownMainLine({ type: 'atis-latch', atis: 'v1.c3220c7ab05b70ed.QNL.token', sessionId: 's' })).toBe(true);
    expect(isKnownMainLine({ type: 'atis-latch', atis: 'x', sessionId: 's', content: 'words' })).toBe(false);
    expect(isKnownMainLine({ type: 'atis-latch', atis: 42, sessionId: 's' })).toBe(false);
    expect(isKnownMainLine({ type: 'atis-latch' })).toBe(false); // no sessionId: not the observed shape
    const bridge = { type: 'bridge-session', sessionId: 's', bridgeSessionId: 'cse_x', lastSequenceNum: 0, ownerAccountUuid: 'a', ownerOrganizationUuid: 'o' };
    expect(isKnownMainLine(bridge)).toBe(true);
    expect(isKnownMainLine({ ...bridge, message: { role: 'user', content: 'hi' } })).toBe(false);
    expect(isKnownMainLine({ ...bridge, bridgeSessionId: 7 })).toBe(false);
    expect(isKnownMainLine({ type: 'not-a-thing' })).toBe(false);
    expect(isKnownMainLine({ type: 'constructor' })).toBe(false);
    expect(isKnownMainLine(null)).toBe(false);
  });

  it('surfaces human interventions as nodes', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const kinds = ir.nodes.filter((n) => n.kind === 'human').map((n) => n.interventionKind);
    expect(kinds).toContain('denial');
    expect(kinds).toContain('answer');
  });

  it('collapses consecutive same-tool calls into one node', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const bash = ir.nodes.find((n) => n.kind === 'tool' && n.label.startsWith('Bash'));
    expect(bash.callCount).toBe(2);
    expect(bash.errorCount).toBe(1);
    // aggregated label keeps the first call's summary + ×N
    expect(bash.label).toBe('Bash · Run the login test ×2');
  });

  it('synthesizes descriptive tool labels from call inputs', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const labels = ir.nodes.filter((n) => n.kind === 'tool').map((n) => n.label);
    expect(labels).toContain('Edit · login.spec.ts'); // basename of file_path
    expect(labels).toContain('Grep · waitForURL'); // pattern
    expect(labels).toContain('Read · login.spec.ts');
    expect(labels).toContain('Bash · npm run lint'); // no description → command
    expect(labels).toContain('Hypervisor'); // unknown tool → plain name
  });

  it('toolNodeLabel truncates and never throws on hostile input', () => {
    expect(toolNodeLabel('Bash', { command: 'x'.repeat(200) }).length).toBeLessThanOrEqual(40);
    expect(toolNodeLabel('WebFetch', { url: 'https://docs.example.com/a/b' })).toBe(
      'WebFetch · docs.example.com',
    );
    expect(toolNodeLabel('WebFetch', { url: ':::not a url' })).toBe('WebFetch');
    expect(toolNodeLabel('Bash', null)).toBe('Bash');
    expect(toolNodeLabel('Read', { file_path: 42 })).toBe('Read');
    expect(toolNodeLabel('Mystery', { anything: true })).toBe('Mystery');
  });

  it('attaches "why" context only to the group right after narration', async () => {
    const { ir, details } = await parse(ref(SESSION_RUN_ID), { collectDetails: true });
    const grep = ir.nodes.find((n) => n.label.startsWith('Grep'));
    expect(details.get(grep.id).context).toContain('checking the wait pattern');
    // first Bash group is preceded by thinking, not narration text
    const bash = ir.nodes.find((n) => n.label.startsWith('Bash ·'));
    expect(details.get(bash.id).context).toBeUndefined();
    // the Read right after the Grep must not inherit the consumed narration
    const read = ir.nodes.find((n) => n.label.startsWith('Read'));
    expect(details.get(read.id).context).toBeUndefined();
  });

  it('does not leak a turn sign-off into post-notification continuation tools', async () => {
    const { ir, details } = await parse(ref(SESSION_RUN_ID), { collectDetails: true });
    // this Bash runs after a task-notification, with no new human prompt —
    // the previous turn's closing text is not its "why"
    const git = ir.nodes.find((n) => n.label === 'Bash · Confirm hardening commit');
    expect(git).toBeDefined();
    expect(details.get(git.id).context).toBeUndefined();
  });

  it('links the async agent with status from its notification + transcript', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const agent = ir.nodes.find((n) => n.kind === 'agent');
    expect(agent.agentId).toBe('a123456789abcdef0');
    expect(agent.status).toBe('completed');
    expect(agent.tokens.output).toBeGreaterThan(0);
    expect(ir.edges.some((e) => e.kind === 'spawn' && e.to === agent.id)).toBe(true);
    expect(ir.edges.some((e) => e.kind === 'return' && e.from === agent.id)).toBe(true);
  });

  it('serves lazy detail payloads', async () => {
    const { ir, details } = await parse(ref(SESSION_RUN_ID), { collectDetails: true });
    const bash = ir.nodes.find((n) => n.kind === 'tool' && n.label.startsWith('Bash'));
    const d = details.get(bash.id);
    expect(d.kind).toBe('tool');
    expect(d.calls).toHaveLength(2);
    expect(d.calls[0].isError).toBe(true);
    const agent = ir.nodes.find((n) => n.kind === 'agent');
    expect(details.get(agent.id).transcript.length).toBeGreaterThan(0);
  });

  it('parses an empty headless session without nodes or errors', async () => {
    const { ir } = await parse(ref(EMPTY_RUN_ID));
    expect(ir.nodes).toHaveLength(0);
    expect(ir.meta.unrecognizedLineCount).toBe(0);
    // An empty run is not a blind one: two records, both read.
    expect(ir.meta.coverage).toEqual({ records: 2, unrecognized: 0, sourcesUnread: 0 });
  });
});

describe('parse: the compaction seam', () => {
  // A `/compact` writes two records: a system/compact_boundary and the summary
  // as a `user` line (both probed live on 2.1.241, 2026-08-23). Before this
  // fixture existed the boundary was silently dropped and the summary rendered
  // as a prompt a human typed — an unbroken spine with a synthetic turn on it,
  // exactly the false continuous timeline the opencode fixture forbids.
  it('the compact summary is never a prompt a human typed', async () => {
    const { ir } = await parse(ref(COMPACT_RUN_ID));
    const turns = ir.nodes.filter((n) => n.kind === 'turn');
    expect(turns.map((n) => n.label)).toEqual([
      'Walk the release checklist',
      'Carry on with the tag step',
    ]);
  });

  it('the seam rides the next spine edge, with the metadata in ext', async () => {
    const { ir } = await parse(ref(COMPACT_RUN_ID));
    const seam = ir.edges.find((e) => e.reason === 'after context compaction');
    expect(seam?.kind).toBe('sequence');
    // From the pre-compaction turn to the post-compaction one — no node in
    // between, because the seam is lineage, not an event of its own.
    expect(seam.from).toMatch(/^t:/);
    expect(seam.to).toMatch(/^t:/);
    expect(ir.meta.ext.claudeCode.compaction).toBe(1);
    expect(ir.meta.ext.claudeCode.compactions).toEqual([
      { trigger: 'manual', preTokens: 33963, postTokens: 8502 },
    ]);
  });

  it('the seam costs nothing in coverage', async () => {
    const { ir } = await parse(ref(COMPACT_RUN_ID));
    expect(ir.meta.unrecognizedLineCount).toBe(0);
    expect(ir.meta.coverage.unrecognized).toBe(0);
    expect(ir.meta.coverage.sourcesUnread).toBe(0);
  });
});

describe('file attribution', () => {
  it('puts the touched paths on tool nodes', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const edit = ir.nodes.find((n) => n.label.startsWith('Edit · login'));
    expect(edit.files).toEqual(['/home/dev/acme/tests/login.spec.ts']);
  });

  it('unions a collapsed group and de-duplicates', async () => {
    const { ir } = await parse(ref(TROUBLE_RUN_ID));
    const edit = ir.nodes.find((n) => n.label.startsWith('Edit'));
    expect(edit.callCount).toBe(3); // three calls collapsed into one node…
    expect(edit.files).toEqual(['/home/dev/acme/src/auth/token.js']); // …one path
  });

  it('omits the field entirely when a tool touched no file', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const bash = ir.nodes.find((n) => n.label.startsWith('Bash'));
    // Absent, not [] — consumers are told to tolerate absence, and an empty
    // array would make "this node touched nothing" indistinguishable from
    // "this adapter cannot say".
    expect('files' in bash).toBe(false);
    expect(ir.nodes.find((n) => n.label === 'Hypervisor').files).toBeUndefined();
  });

  // The path most likely to regress and most costly to miss: a subagent's tool
  // calls never become tool nodes, so without this every edit made inside an
  // agent is invisible to the files lane.
  it('an agent node carries the files edited inside its own transcript', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const agent = ir.nodes.find((n) => n.kind === 'agent');
    expect(agent.files).toEqual(['/home/dev/acme/src/auth/session.ts']);
  });

  it('agent nodes in a workflow drill-in graph carry them too', async () => {
    const { ir } = await parse(ref(WORKFLOW_RUN_ID));
    // These workflow agents only call StructuredOutput, so they touch nothing —
    // and must therefore say nothing rather than claiming an empty list.
    for (const n of ir.nodes.filter((x) => x.kind === 'agent')) {
      expect(n.files).toBeUndefined();
    }
  });

  it('is identical whether or not detail payloads were collected', async () => {
    // The server caches a detail-collecting parse and the CLI does not; a
    // divergence here is a silent agent/human mismatch about what was touched.
    const plain = (await parse(ref(SESSION_RUN_ID))).ir;
    const rich = (await parse(ref(SESSION_RUN_ID), { collectDetails: true })).ir;
    expect(plain.nodes.map((n) => n.files)).toEqual(rich.nodes.map((n) => n.files));
  });

  it('filePathsFromToolInput reads path keys and refuses everything else', () => {
    expect(filePathsFromToolInput('Edit', { file_path: '/a/b.js' })).toEqual(['/a/b.js']);
    expect(filePathsFromToolInput('NotebookEdit', { notebook_path: '/a/n.ipynb' })).toEqual(['/a/n.ipynb']);
    expect(filePathsFromToolInput('mcp__x__write', { file_path: '/a/c.js' })).toEqual(['/a/c.js']);
    // A search root is a directory, not a file that was touched; shell is guesswork.
    expect(filePathsFromToolInput('Grep', { pattern: 'x', path: '/a' })).toEqual([]);
    expect(filePathsFromToolInput('Bash', { command: 'rm /a/b.js' })).toEqual([]);
    // hostile input never throws
    expect(filePathsFromToolInput('Edit', null)).toEqual([]);
    expect(filePathsFromToolInput('Edit', { file_path: 42 })).toEqual([]);
    expect(filePathsFromToolInput('Edit', { file_path: '  ' })).toEqual([]);
    expect(filePathsFromToolInput('Edit', { file_path: 'a\nb' })).toEqual([]);
    expect(filePathsFromToolInput('Edit', { file_path: 'x'.repeat(600) })).toEqual([]);
  });

  it('mergeFiles unions in first-seen order and caps', () => {
    expect(mergeFiles(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(mergeFiles(undefined, ['a'])).toEqual(['a']);
    expect(mergeFiles(['a', 'b', 'c'], ['d'], 2)).toEqual(['a', 'b']);
  });
});

describe('parse: workflow run', () => {
  it('produces the expected IR', async () => {
    const { ir } = await parse(ref(WORKFLOW_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  it('groups agents into phases and marks the retry', async () => {
    const { ir } = await parse(ref(WORKFLOW_RUN_ID));
    expect(ir.groups.map((g) => g.label)).toEqual(['Find', 'Fix']);
    const failed = ir.nodes.find((n) => n.agentId === 'aaaa000000000002f');
    const retry = ir.nodes.find((n) => n.agentId === 'aaaa000000000003f');
    expect(failed.status).toBe('error');
    expect(retry.status).toBe('completed');
    const retryEdge = ir.edges.find((e) => e.from === failed.id && e.to === retry.id);
    expect(retryEdge.reason).toBe('retry after failure');
  });

  it('carries the workflow return value in the root detail', async () => {
    const { ir, details } = await parse(ref(WORKFLOW_RUN_ID), { collectDetails: true });
    const root = ir.nodes.find((n) => n.kind === 'workflow');
    expect(root.status).toBe('completed');
    expect(details.get(root.id).returnValue).toContain('patched');
  });
});

describe('parse: tool-group timing (callOffsets + endedAt)', () => {
  // The replay layer's per-call granularity rests on two additive tool-node
  // fields. Both are computed from the builder's own state, so they must be
  // on the IR whether or not details are collected — `rungraph graph --json`
  // is the IR path and collects none.
  const toolNodes = (ir) => ir.nodes.filter((n) => n.kind === 'tool');

  it('a collapsed group carries callOffsets that agree with the detail payload (session 1111…, Bash ×2)', async () => {
    const { ir, details } = await parse(ref(SESSION_RUN_ID), { collectDetails: true });
    const bash = ir.nodes.find((n) => n.label === 'Bash · Run the login test ×2');
    // The two tool_use records sit at 12:00:06.000 and 12:00:09.000.
    expect(bash.callOffsets).toEqual([0, 3000]);
    const calls = details.get(bash.id).calls;
    expect(bash.callOffsets).toHaveLength(bash.callCount);
    expect(bash.callOffsets[0]).toBe(0);
    for (let i = 0; i < calls.length; i++) {
      expect(bash.callOffsets[i]).toBe(Date.parse(calls[i].startedAt) - Date.parse(bash.startedAt));
      if (i) expect(bash.callOffsets[i]).toBeGreaterThanOrEqual(bash.callOffsets[i - 1]);
    }
  });

  it('an all-error group still carries offsets and its end (trouble run 4444…, Edit ×3)', async () => {
    const { ir, details } = await parse(ref(TROUBLE_RUN_ID), { collectDetails: true });
    const edit = ir.nodes.find((n) => n.label.startsWith('Edit'));
    expect(edit.status).toBe('error');
    expect(edit.callOffsets).toEqual([0, 3000, 6000]);
    const calls = details.get(edit.id).calls;
    calls.forEach((c, i) => {
      expect(edit.callOffsets[i]).toBe(Date.parse(c.startedAt) - Date.parse(edit.startedAt));
    });
    // An error IS a resolution: the group ended when its last error came back.
    expect(edit.endedAt).toBe('2026-08-01T12:01:46.500Z');
  });

  it('single-call nodes carry no callOffsets at all (sessions 1111…, 3333…, 4444…)', async () => {
    // Absent, not [0] — call 0 IS the node's start, so the array would be
    // information-free bytes on the majority of tool nodes (same rule as `files`).
    for (const id of [SESSION_RUN_ID, CLEAN_RUN_ID, TROUBLE_RUN_ID]) {
      const { ir } = await parse(ref(id));
      for (const n of toolNodes(ir)) {
        if (n.callCount === 1) expect('callOffsets' in n, n.id).toBe(false);
        else expect(n.callOffsets, n.id).toBeDefined();
      }
    }
  });

  it('a resolved group ends at its last result (session 1111…)', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const bash = ir.nodes.find((n) => n.label === 'Bash · Run the login test ×2');
    // toolu_fx0002's tool_result record is the group's last resolution.
    expect(bash.endedAt).toBe('2026-08-01T12:00:10.500Z');
    // Every group in this dead session resolved, so every one has an end that
    // does not precede its start — and NONE has a durationMs: the outlier
    // signal reads durationMs, and tool groups must stay out of its population.
    for (const n of toolNodes(ir)) {
      expect(n.endedAt, n.id).toBeDefined();
      expect(Date.parse(n.endedAt)).toBeGreaterThanOrEqual(Date.parse(n.startedAt));
      expect('durationMs' in n, n.id).toBe(false);
    }
  });

  it('a human denial resolves the group it refused (session 1111…, Edit · session.ts)', async () => {
    const { ir } = await parse(ref(SESSION_RUN_ID));
    const edit = ir.nodes.find((n) => n.label === 'Edit · session.ts');
    const denial = ir.nodes.find((n) => n.interventionKind === 'denial');
    expect(edit.errorCount).toBe(1);
    // The denial record (toolDenialKind: user-rejected) is the resolution, so
    // the group ends at the very instant the human node starts.
    expect(edit.endedAt).toBe('2026-08-01T12:00:40.500Z');
    expect(edit.endedAt).toBe(denial.startedAt);
  });

  it('is identical whether or not detail payloads were collected (session 1111…)', async () => {
    const pick = (ir) => toolNodes(ir).map((n) => [n.id, n.callOffsets, n.endedAt]);
    const plain = (await parse(ref(SESSION_RUN_ID))).ir;
    const rich = (await parse(ref(SESSION_RUN_ID), { collectDetails: true })).ir;
    expect(pick(plain)).toEqual(pick(rich));
  });

  describe('a group with a call still out', () => {
    // The corpus has no unresolved group, so one is made here: session 1111…
    // cut off right after a tool_use, before its tool_result. Never written to
    // the fixture tree.
    const FIXTURE_FILE = '11111111-1111-4111-8111-111111111111.jsonl';
    let root;
    async function truncatedRun(lineCount, { dead }) {
      root ??= await mkdtemp(join(tmpdir(), 'rg-timing-'));
      const dir = join(root, dead ? 'dead' : 'live');
      await cp(FIXTURE_ROOT, dir, { recursive: true });
      const file = join(dir, '-home-dev-acme', FIXTURE_FILE);
      const lines = (await readFile(file, 'utf8')).split('\n').slice(0, lineCount);
      await writeFile(file, lines.join('\n') + '\n');
      if (dead) {
        // Pin every mtime into the past so the run reads as over, exactly as
        // pinFixtureMtimes does for the real corpus.
        const when = new Date('2026-08-01T13:00:00Z');
        const walk = async (d) => {
          for (const ent of await readdir(d, { withFileTypes: true })) {
            const p = join(d, ent.name);
            if (ent.isDirectory()) await walk(p);
            await utimes(p, when, when);
          }
        };
        await walk(dir);
      }
      const runRefs = await detect([dir]);
      return parse(runRefs.find((r) => r.runId === SESSION_RUN_ID), { collectDetails: true });
    }

    it('carries no endedAt even when a dead session marks it completed', async () => {
      // Through line 10: both Bash tool_use records, only the first's result.
      const { ir, details } = await truncatedRun(10, { dead: true });
      const bash = ir.nodes.find((n) => n.label === 'Bash · Run the login test ×2');
      expect(bash.status).toBe('completed'); // finish() closes trailing groups of a dead run…
      expect('endedAt' in bash).toBe(false); // …but an end is about a RESULT existing, not a status
      // Offsets need only the starts, and both calls started.
      expect(bash.callOffsets).toEqual([0, 3000]);
      expect(details.get(bash.id).calls[1].output).toBeNull();
    });

    it('carries no endedAt while live, and a single unresolved call carries neither field', async () => {
      // Through line 8: one Bash tool_use, no result, and the file was just written.
      const { ir } = await truncatedRun(8, { dead: false });
      const bash = ir.nodes.find((n) => n.label === 'Bash · Run the login test');
      expect(bash.status).toBe('running');
      expect('endedAt' in bash).toBe(false);
      expect('callOffsets' in bash).toBe(false);
      await rm(root, { recursive: true, force: true });
    });
  });
});
