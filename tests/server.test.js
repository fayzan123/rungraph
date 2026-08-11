import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { pinFixtureMtimes, FIXTURE_ROOT, SESSION_RUN_ID, WORKFLOW_RUN_ID } from './helpers.js';

let server;
beforeAll(async () => {
  await pinFixtureMtimes();
  process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
  server = await startServer({ preferredPort: 4599 });
});
afterAll(async () => {
  delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
  await server.close();
});

const get = async (path) => {
  const res = await fetch(server.url + path);
  return { status: res.status, body: await res.json() };
};

describe('HTTP API', () => {
  it('binds 127.0.0.1 only', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('GET /api/index returns the run index', async () => {
    const { status, body } = await get('/api/index');
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(3);
  });

  it('GET /api/graph/:runId returns IR', async () => {
    const { status, body } = await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`);
    expect(status).toBe(200);
    expect(body.irVersion).toBe(1);
  });

  it('GET /api/detail/:nodeId serves lazy payloads', async () => {
    const g = (await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`)).body;
    const node = g.nodes.find((n) => n.hasDetail);
    const { status, body } = await get(
      `/api/detail/${encodeURIComponent(node.id)}?run=${encodeURIComponent(SESSION_RUN_ID)}`,
    );
    expect(status).toBe(200);
    expect(body.kind).toBe(node.kind);
  });

  it('404s an unknown run', async () => {
    const { status } = await get('/api/graph/claude-code:nope');
    expect(status).toBe(404);
  });

  it('SSE watch delivers a snapshot', async () => {
    const res = await fetch(
      `${server.url}/api/watch/${encodeURIComponent(WORKFLOW_RUN_ID)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 8000;
    while (!buf.includes('\n\n') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    const frame = buf.split('\n\n').find((f) => f.startsWith('data: '));
    expect(frame).toBeDefined();
    const msg = JSON.parse(frame.slice(6));
    expect(msg.type).toBe('snapshot');
    expect(msg.graph.meta.runId).toBe(WORKFLOW_RUN_ID);
  }, 15000);
});
