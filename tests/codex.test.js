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
