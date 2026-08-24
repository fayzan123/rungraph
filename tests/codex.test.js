import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/codex/index.js';
import { deriveSignals } from '../src/signals.js';
import { matchNodes } from '../src/find.js';
import {
  pinFixtureMtimes,
  CODEX_FIXTURE_ROOT,
  CODEX_CLEAN_RUN_ID,
  CODEX_SUBAGENT_RUN_ID,
  CODEX_CHILD_THREAD_ID,
  CODEX_GRANDCHILD_THREAD_ID,
  CODEX_OLD_RUN_ID,
  CODEX_COMPACT_RUN_ID,
} from './helpers.js';

beforeAll(() => pinFixtureMtimes());

const refFor = async (runId) => {
  const refs = await detect([CODEX_FIXTURE_ROOT]);
  return refs.find((r) => r.runId === runId);
};

describe('codex detect', () => {
  it('indexes the top-level threads with cwd-derived projects and prompt titles', async () => {
    const refs = await detect([CODEX_FIXTURE_ROOT]);
    expect(refs.map((r) => r.runId).sort()).toEqual([
      CODEX_CLEAN_RUN_ID,
      CODEX_SUBAGENT_RUN_ID,
      CODEX_OLD_RUN_ID,
      CODEX_COMPACT_RUN_ID,
    ]);
    const clean = refs.find((r) => r.runId === CODEX_CLEAN_RUN_ID);
    expect(clean.project).toBe('/home/dev/acme');
    expect(clean.projectFromCwd).toBe(true);
    // The IDE-context preamble is stripped: the title is what the user typed.
    expect(clean.title).toBe('Add input validation to the signup form');
  });

  it('subagent rollouts are NOT independent runs — they live inside their parent', async () => {
    const refs = await detect([CODEX_FIXTURE_ROOT]);
    expect(refs.some((r) => r.runId.includes(CODEX_CHILD_THREAD_ID))).toBe(false);
    expect(refs.some((r) => r.runId.includes(CODEX_GRANDCHILD_THREAD_ID))).toBe(false);
  });
});

describe('codex parse', () => {
  it('clean-run IR matches the snapshot', async () => {
    const { ir } = await parse(await refFor(CODEX_CLEAN_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  it('subagent-run IR matches the snapshot', async () => {
    const { ir } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    expect(ir).toMatchSnapshot();
  });

  // The Codex precision guard, same role as the Claude clean run: thresholds
  // that fire on an ordinary successful Codex session would burn the signal
  // layer's trust on vendor two's first day.
  it('the codex clean run derives zero signals', async () => {
    const { ir } = await parse(await refFor(CODEX_CLEAN_RUN_ID));
    expect(deriveSignals(ir)).toEqual([]);
  });

  it('links the subagent across rollout files: tokens, files, lineage, return edge', async () => {
    const { ir, details } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID), {
      collectDetails: true,
    });
    const agent = ir.nodes.find((n) => n.kind === 'agent');
    expect(agent.agentId).toBe(CODEX_CHILD_THREAD_ID);
    expect(agent.status).toBe('completed');
    // These can only come from the CHILD's rollout file.
    expect(agent.tokens).toEqual({ input: 5000, output: 400 });
    expect(agent.files).toEqual(['/home/dev/acme/docs/auth-map.md']);
    expect(agent.model).toBe('gpt-5.5-codex');
    expect(agent.ext.codex).toEqual({ nickname: 'Darwin', agentPath: '/root/auth_map', depth: 1 });
    // The FINAL_ANSWER is the return edge and the readable result.
    const ret = ir.edges.find((e) => e.kind === 'return' && e.from === agent.id);
    expect(ret.label).toContain('Auth map');
    expect(details.get(agent.id).result).toContain('session.ts:41');
  });

  it('fork-inherited history is excluded from the child summary', async () => {
    const { ir, details } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID), {
      collectDetails: true,
    });
    const agent = ir.nodes.find((n) => n.kind === 'agent');
    const transcript = details.get(agent.id).transcript;
    // The parent's prompt was physically copied into the child file with its
    // original timestamp — it must not read as the child's own work.
    expect(JSON.stringify(transcript)).not.toContain('Map the auth module');
  });

  it('an interrupt becomes a human node with decision lineage', async () => {
    const { ir } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    const human = ir.nodes.find((n) => n.kind === 'human');
    expect(human.interventionKind).toBe('interrupt');
    const after = ir.edges.find((e) => e.from === human.id && e.kind === 'sequence');
    expect(after.reason).toBe('after user interrupt');
  });

  it('unknown line shapes are skipped and counted, never fatal', async () => {
    const { ir } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    // one unknown top-level type + one unknown event_msg subtype
    expect(ir.meta.unrecognizedLineCount).toBe(2);
  });

  it('a recovered tool error stays one collapsed group, not a signal', async () => {
    const { ir } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    const shell = ir.nodes.find((n) => n.label.startsWith('Shell') && n.callCount === 2);
    expect(shell.errorCount).toBe(1);
    expect(shell.status).toBe('completed');
    const signals = deriveSignals(ir);
    expect(signals.filter((s) => s.kind === 'retry-storm')).toEqual([]);
    expect(signals.filter((s) => s.kind === 'unresolved-error')).toEqual([]);
  });

  it('file attribution reaches find_nodes, from both patch mechanisms', async () => {
    const clean = await parse(await refFor(CODEX_CLEAN_RUN_ID));
    // JS-exec mode: patch_apply_end with an exec-<uuid> call_id no call matches
    expect(matchNodes(clean.ir, 'signup.ts').length).toBeGreaterThan(0);
    const sub = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    // classic apply_patch: relative input path resolved against the turn cwd
    const patch = sub.ir.nodes.find((n) => n.label.startsWith('Patch'));
    expect(patch.files).toEqual(['/home/dev/acme/src/auth/session.ts']);
  });

  it('tool details carry exec verdicts parsed from output text', async () => {
    const { details } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID), {
      collectDetails: true,
    });
    const shell = details.get('g:call_c2t1');
    expect(shell.calls).toHaveLength(2);
    expect(shell.calls[0].isError).toBe(true);
    expect(shell.calls[1].isError).toBe(false);
    expect(shell.calls[1].durationMs).toBe(4400); // "Wall time: 4.4 seconds"
    expect(shell.context).toBeUndefined();
  });

  it('turn details carry the prompt and the assistant text from the event stream', async () => {
    const { details } = await parse(await refFor(CODEX_CLEAN_RUN_ID), { collectDetails: true });
    const turn = details.get('t:turn-c1a');
    expect(turn.prompt).toBe('Add input validation to the signup form');
    expect(turn.responseText).toContain('Validation added');
    // commentary narration became the tool group's "why" context
  });

  it('commentary narration becomes the next tool group\'s "why" context', async () => {
    const { details } = await parse(await refFor(CODEX_CLEAN_RUN_ID), { collectDetails: true });
    expect(details.get('g:call_c1grep').context).toContain('Looking at the form component');
  });

  it('the fork-inherited block is cut structurally, not by timestamp', async () => {
    // The child fixture re-stamps inherited lines AT fork time (equal/later
    // than line 1, matching real 0.144.x children), including the parent's
    // token_count with the parent's totals — none of it may count as the
    // child's own work.
    const { ir } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    const child = ir.nodes.find((n) => n.agentId === CODEX_CHILD_THREAD_ID);
    expect(child.tokens).toEqual({ input: 5000, output: 400 }); // own, not the parent's 15000/800
  });

  it('depth-2 grandchildren materialize with edges off their spawning agent', async () => {
    const { ir, details } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID), {
      collectDetails: true,
    });
    const child = ir.nodes.find((n) => n.agentId === CODEX_CHILD_THREAD_ID);
    const grand = ir.nodes.find((n) => n.agentId === CODEX_GRANDCHILD_THREAD_ID);
    expect(grand).toBeDefined();
    expect(grand.status).toBe('completed');
    expect(grand.tokens).toEqual({ input: 1000, output: 100 });
    expect(grand.ext.codex).toMatchObject({ nickname: 'Bohr', depth: 2 });
    const spawn = ir.edges.find((e) => e.kind === 'spawn' && e.to === grand.id);
    expect(spawn.from).toBe(child.id);
    const ret = ir.edges.find((e) => e.kind === 'return' && e.from === grand.id);
    expect(ret.to).toBe(child.id);
    expect(details.get(grand.id).result).toContain('refresh path is sound');
    expect(ir.meta.totals.agents).toBe(2);
  });

  it('real-array tool outputs (the dominant 0.144.x shape) parse into details', async () => {
    const { details } = await parse(await refFor(CODEX_CLEAN_RUN_ID), { collectDetails: true });
    const patchGroup = [...details.values()].find(
      (d) => d.kind === 'tool' && d.calls?.some((c) => c.output?.includes('Updated the following files')),
    );
    expect(patchGroup).toBeDefined();
    const call = patchGroup.calls.find((c) => c.output?.includes('Updated the following files'));
    expect(call.isError).toBe(false);
    expect(call.durationMs).toBe(400); // "Wall time 0.4 seconds" from the array parts
  });

  it('old-format sessions (no task events) get every turn, closed cleanly', async () => {
    const { ir, details } = await parse(await refFor(CODEX_OLD_RUN_ID), { collectDetails: true });
    const turns = ir.nodes.filter((n) => n.kind === 'turn');
    expect(turns.map((n) => n.label)).toEqual(['List the auth files', 'Which one owns refresh?']);
    // Both turns closed NORMALLY: details written, tokens kept, no false error.
    for (const t of turns) {
      expect(t.status).toBe('completed');
      expect(details.get(t.id)).toBeDefined();
      expect(t.tokens).toBeDefined();
    }
    expect(details.get(turns[0].id).responseText).toContain('Three files');
    expect(deriveSignals(ir)).toEqual([]); // a clean historic session stays clean
  });

  it('a compaction rides the next spine edge, and is a fact rather than a signal', async () => {
    // The cross-adapter seam rule, asserted here without the sqlite gate so
    // the Node 20 CI leg still covers codex's half of it.
    const { ir } = await parse(await refFor(CODEX_COMPACT_RUN_ID));
    const turns = ir.nodes.filter((n) => n.kind === 'turn');
    expect(turns.map((n) => n.label)).toEqual([
      'Summarize the migration status',
      'Finish the storage migration',
    ]);
    const seam = ir.edges.find((e) => e.reason === 'after context compaction');
    expect(seam?.kind).toBe('sequence');
    expect(seam.from).toBe(turns[0].id);
    expect(seam.to).toBe(turns[1].id);
    expect(deriveSignals(ir)).toEqual([]);
  });
});

// Phase-1 replay fields (spec 2026-08-23-session-replay-design §1, §3 row
// "codex"): call start = the function-call event's `ts`; group end = the last
// function_call_output's timestamp. Both are additive and ABSENT when unknown.
describe('codex replay timings', () => {
  const offsetsOf = (node, detail) =>
    detail.calls.map((c) => Date.parse(c.startedAt) - Date.parse(node.startedAt));

  it('a multi-call group carries callOffsets that match the detail payload (subagent run, g:call_c2t1)', async () => {
    const { ir, details } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID), {
      collectDetails: true,
    });
    const group = ir.nodes.find((n) => n.id === 'g:call_c2t1');
    expect(group.callCount).toBe(2);
    // exec_command at 10:01:32 and 10:01:36 — the second call is 4 s in.
    expect(group.callOffsets).toEqual([0, 4000]);
    expect(group.callOffsets).toHaveLength(group.callCount);
    expect(group.callOffsets).toEqual(offsetsOf(group, details.get(group.id)));
  });

  it('a JS-exec patch collapsed into the grep group is timed from its own call line (clean run, g:call_c1grep)', async () => {
    const { ir, details } = await parse(await refFor(CODEX_CLEAN_RUN_ID), { collectDetails: true });
    const group = ir.nodes.find((n) => n.id === 'g:call_c1grep');
    expect(group.callCount).toBe(2);
    expect(group.callOffsets).toEqual([0, 6000]);
    expect(group.callOffsets).toEqual(offsetsOf(group, details.get(group.id)));
  });

  it('the IR path carries callOffsets without collecting details (clean run)', async () => {
    const { ir } = await parse(await refFor(CODEX_CLEAN_RUN_ID));
    expect(ir.nodes.find((n) => n.id === 'g:call_c1grep').callOffsets).toEqual([0, 6000]);
  });

  it('every multi-call group across the corpus is well-formed: [0]===0, non-decreasing, length===callCount', async () => {
    for (const runId of [CODEX_CLEAN_RUN_ID, CODEX_SUBAGENT_RUN_ID, CODEX_OLD_RUN_ID, CODEX_COMPACT_RUN_ID]) {
      const { ir, details } = await parse(await refFor(runId), { collectDetails: true });
      for (const n of ir.nodes.filter((n) => n.kind === 'tool' && n.callOffsets)) {
        expect(n.callCount).toBeGreaterThanOrEqual(2);
        expect(n.callOffsets[0]).toBe(0);
        expect(n.callOffsets).toHaveLength(n.callCount);
        for (let i = 1; i < n.callOffsets.length; i++) {
          expect(Number.isInteger(n.callOffsets[i])).toBe(true);
          expect(n.callOffsets[i]).toBeGreaterThanOrEqual(n.callOffsets[i - 1]);
        }
        expect(n.callOffsets).toEqual(offsetsOf(n, details.get(n.id)));
      }
    }
  });

  it('single-call nodes carry NO callOffsets — not even [0] (clean, subagent and old runs)', async () => {
    for (const runId of [CODEX_CLEAN_RUN_ID, CODEX_SUBAGENT_RUN_ID, CODEX_OLD_RUN_ID]) {
      const { ir } = await parse(await refFor(runId));
      const singles = ir.nodes.filter((n) => n.kind === 'tool' && n.callCount === 1);
      expect(singles.length).toBeGreaterThan(0);
      for (const n of singles) expect(n).not.toHaveProperty('callOffsets');
    }
  });

  it('a resolved group ends at its LAST output, never before it starts (subagent run, g:call_c2t1)', async () => {
    const { ir } = await parse(await refFor(CODEX_SUBAGENT_RUN_ID));
    const group = ir.nodes.find((n) => n.id === 'g:call_c2t1');
    // outputs at 10:01:34 and 10:01:38 — the group ends with the second.
    expect(group.endedAt).toBe('2026-08-01T10:01:38.000Z');
    expect(Date.parse(group.endedAt)).toBeGreaterThanOrEqual(Date.parse(group.startedAt));
    // A single resolved call ends at its own output (old run, both calls).
    const old = await parse(await refFor(CODEX_OLD_RUN_ID));
    expect(old.ir.nodes.filter((n) => n.kind === 'tool').map((n) => n.endedAt)).toEqual([
      '2026-08-01T10:02:36.000Z',
      '2026-08-01T10:02:46.000Z',
    ]);
  });

  it('tool groups get endedAt but never durationMs — the outlier signal reads durationMs (all runs)', async () => {
    for (const runId of [CODEX_CLEAN_RUN_ID, CODEX_SUBAGENT_RUN_ID, CODEX_OLD_RUN_ID]) {
      const { ir } = await parse(await refFor(runId));
      for (const n of ir.nodes.filter((n) => n.kind === 'tool')) {
        expect(n).not.toHaveProperty('durationMs');
        if (n.endedAt) expect(Date.parse(n.endedAt)).toBeGreaterThanOrEqual(Date.parse(n.startedAt));
      }
    }
  });

  // The committed corpus resolves every call, so the live and untimed shapes
  // are synthesised at test time (never written into the fixture tree), in the
  // same envelope grammar the clean fixture uses.
  describe('synthesised rollouts', () => {
    const THREAD = 'c9c9c9c9-0000-7000-8000-000000000009';
    const line = (timestamp, type, payload) =>
      JSON.stringify(timestamp == null ? { type, payload } : { timestamp, type, payload });
    const call = (ts, id, cmd) =>
      line(ts, 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd }),
        call_id: id,
      });
    const output = (ts, id) =>
      line(ts, 'response_item', {
        type: 'function_call_output',
        call_id: id,
        output: 'Wall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nok',
      });
    const head = [
      line('2026-08-01T13:00:00.000Z', 'session_meta', { id: THREAD, cwd: '/home/dev/acme', thread_source: 'user' }),
      line('2026-08-01T13:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-x' }),
      line('2026-08-01T13:00:04.000Z', 'event_msg', { type: 'user_message', message: 'Run the checks' }),
    ];

    const parseSynthetic = async (lines) => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = await mkdtemp(join(tmpdir(), 'rungraph-codex-replay-'));
      const dir = join(root, '2026', '08', '01');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `rollout-2026-08-01T13-00-00-${THREAD}.jsonl`), lines.join('\n') + '\n');
      const ref = (await detect([root])).find((r) => r.runId === `codex:${THREAD}`);
      return parse(ref, { collectDetails: true });
    };

    it('a live group whose last call has no output carries NO endedAt, but still its callOffsets', async () => {
      const { ir } = await parseSynthetic([
        ...head,
        call('2026-08-01T13:00:10.000Z', 'call_x1', 'npm run lint'),
        output('2026-08-01T13:00:12.000Z', 'call_x1'),
        call('2026-08-01T13:00:14.000Z', 'call_x2', 'npm test'),
        // no output for call_x2, no task_complete: the turn is still open
      ]);
      // Fresh mtime + open turn → the run is live (meta.endedAt is only set
      // once it is over). The group's own status is not asserted: appending
      // a call to an already-resolved group leaves it `completed` in every
      // JSONL adapter today, which is a status question, not a timing one.
      expect(ir.meta).not.toHaveProperty('endedAt');
      const group = ir.nodes.find((n) => n.kind === 'tool');
      expect(group.callCount).toBe(2);
      expect(group.callOffsets).toEqual([0, 4000]);
      expect(group).not.toHaveProperty('endedAt');
    });

    it('one untimed call withholds the whole list — there is no partial callOffsets', async () => {
      const { ir, details } = await parseSynthetic([
        ...head,
        call('2026-08-01T13:00:10.000Z', 'call_x1', 'npm run lint'),
        output('2026-08-01T13:00:12.000Z', 'call_x1'),
        call(null, 'call_x2', 'npm test'), // envelope without a timestamp
        output('2026-08-01T13:00:16.000Z', 'call_x2'),
        line('2026-08-01T13:00:20.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-x' }),
      ]);
      const group = ir.nodes.find((n) => n.kind === 'tool');
      expect(group.callCount).toBe(2);
      expect(group).not.toHaveProperty('callOffsets');
      expect(details.get(group.id).calls[1].startedAt).toBeUndefined();
      // Both calls resolved at timed outputs, so the group still ends.
      expect(group.endedAt).toBe('2026-08-01T13:00:16.000Z');
    });
  });
});
