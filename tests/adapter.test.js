import { beforeAll, describe, expect, it } from 'vitest';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { toolNodeLabel } from '../src/adapters/claude-code/helpers.js';
import { pinFixtureMtimes, FIXTURE_ROOT, SESSION_RUN_ID, WORKFLOW_RUN_ID, EMPTY_RUN_ID } from './helpers.js';

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
    expect(ir.meta.unrecognizedLineCount).toBe(1); // the "holo-recap" future line
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
