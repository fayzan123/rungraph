import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { matchNodes } from '../src/find.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  TROUBLE_RUN_ID,
  FIXTURE_RUN_COUNT,
} from './helpers.js';

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

const post = async (path, body, headers = {}) => {
  const res = await fetch(server.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/**
 * Open an SSE connection and collect frames until `want` matches one (or we
 * time out). Returns { frames, close }.
 */
async function openWatch(runId, { settleMs = 600 } = {}) {
  const res = await fetch(`${server.url}/api/watch/${encodeURIComponent(runId)}`, {
    headers: { accept: 'text/event-stream' },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buf = '';
  let done = false;
  (async () => {
    try {
      while (!done) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith('data: ')) {
            try {
              frames.push(JSON.parse(chunk.slice(6)));
            } catch {
              /* partial */
            }
          }
        }
      }
    } catch {
      /* closed */
    }
  })();
  await new Promise((r) => setTimeout(r, settleMs)); // let the snapshot land
  return {
    frames,
    async waitFor(pred, ms = 3000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = frames.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 40));
      }
      return null;
    },
    close: async () => {
      done = true;
      await reader.cancel().catch(() => {});
    },
  };
}

describe('HTTP API', () => {
  it('binds 127.0.0.1 only', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('GET /api/index returns the run index', async () => {
    const { status, body } = await get('/api/index');
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(FIXTURE_RUN_COUNT);
  });

  it('GET /api/graph/:runId returns IR, with signals derived server-side', async () => {
    const { status, body } = await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`);
    expect(status).toBe(200);
    expect(body.irVersion).toBe(1);
    expect(Array.isArray(body.signals)).toBe(true);
    expect(body.signals.length).toBeGreaterThan(0);
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

  it('tool detail carries optional "why" context, absent when no narration', async () => {
    const g = (await get(`/api/graph/${encodeURIComponent(SESSION_RUN_ID)}`)).body;
    const grep = g.nodes.find((n) => n.label.startsWith('Grep'));
    const withWhy = await get(
      `/api/detail/${encodeURIComponent(grep.id)}?run=${encodeURIComponent(SESSION_RUN_ID)}`,
    );
    expect(withWhy.status).toBe(200);
    expect(withWhy.body.context).toContain('checking the wait pattern');
    const read = g.nodes.find((n) => n.label.startsWith('Read'));
    const noWhy = await get(
      `/api/detail/${encodeURIComponent(read.id)}?run=${encodeURIComponent(SESSION_RUN_ID)}`,
    );
    expect(noWhy.body.context).toBeUndefined();
  });

  it('404s an unknown run', async () => {
    const { status } = await get('/api/graph/claude-code:nope');
    expect(status).toBe(404);
  });

  // One matcher, two consumers: if the endpoint and the library ever disagree,
  // the human's find and the agent's find are showing different runs.
  it('GET /api/find returns exactly what matchNodes returns', async () => {
    const refs = await detect([FIXTURE_ROOT]);
    const { ir } = await parse(refs.find((r) => r.runId === TROUBLE_RUN_ID));
    const direct = matchNodes(ir, 'token.js');
    const { status, body } = await get(
      `/api/find/${encodeURIComponent(TROUBLE_RUN_ID)}?q=${encodeURIComponent('token.js')}`,
    );
    expect(status).toBe(200);
    expect(body.nodeIds).toEqual(direct);
    expect(body.matched).toBe(direct.length);
    expect(body.nodes.map((n) => n.id)).toEqual(direct);
  });

  it('GET /api/find with an empty query matches nothing', async () => {
    const { body } = await get(`/api/find/${encodeURIComponent(TROUBLE_RUN_ID)}?q=`);
    expect(body.nodeIds).toEqual([]);
  });

  it('GET /api/find 404s an unknown run', async () => {
    expect((await get('/api/find/claude-code:nope?q=x')).status).toBe(404);
  });
});

describe('the focus channel', () => {
  it('GET /api/view reports nothing while no browser is connected', async () => {
    const { status, body } = await get('/api/view');
    expect(status).toBe(200);
    expect(body.runs).toEqual([]);
  });

  it('POST /api/focus reaches the SSE clients watching that run', async () => {
    const watch = await openWatch(SESSION_RUN_ID);
    try {
      const view = await get('/api/view');
      expect(view.body.runs).toEqual([{ runId: SESSION_RUN_ID, clientCount: 1 }]);

      const { status, body } = await post('/api/focus', {
        runId: SESSION_RUN_ID,
        nodeIds: ['a:toolu_fxA001'],
        label: '1 agent',
        reason: 'the audit that found the races',
      });
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, clientCount: 1 });
      expect(body.url).toContain('?run=');

      const frame = await watch.waitFor((f) => f.type === 'focus');
      expect(frame).toMatchObject({
        type: 'focus',
        runId: SESSION_RUN_ID,
        nodeIds: ['a:toolu_fxA001'],
        label: '1 agent',
        reason: 'the audit that found the races',
        source: 'agent',
      });
    } finally {
      await watch.close();
    }
  }, 20000);

  // Nobody looking is not an error: the agent already answered in the terminal,
  // and the client count is how it learns to hand over a url instead.
  it('POST /api/focus for a run with no clients succeeds silently', async () => {
    const { status, body } = await post('/api/focus', {
      runId: WORKFLOW_RUN_ID,
      nodeIds: ['w:root'],
      label: 'x',
      reason: 'y',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, clientCount: 0 });
  });

  it('malformed bodies are 400s, and the server survives them', async () => {
    expect((await post('/api/focus', '{not json')).status).toBe(400);
    expect((await post('/api/focus', {})).status).toBe(400);
    expect((await post('/api/focus', { runId: 'x' })).status).toBe(400);
    expect((await post('/api/focus', { nodeIds: ['a'] })).status).toBe(400);
    expect((await post('/api/focus', { runId: 'x', nodeIds: 'a' })).status).toBe(400);
    // still alive
    expect((await get('/api/index')).status).toBe(200);
  });

  it('rejects an oversized body instead of buffering it', async () => {
    const huge = JSON.stringify({ runId: 'x', nodeIds: ['n'], label: 'y'.repeat(400_000) });
    expect((await post('/api/focus', huge)).status).toBe(400);
    expect((await get('/api/index')).status).toBe(200);
  });

  // A localhost server with a write endpoint is reachable from any page the
  // user happens to have open; nothing else about rungraph is.
  it('rejects a cross-origin focus', async () => {
    const { status } = await post(
      '/api/focus',
      { runId: SESSION_RUN_ID, nodeIds: ['a'] },
      { origin: 'https://evil.example' },
    );
    expect(status).toBe(403);
  });

  it('accepts a same-origin focus from the dashboard itself', async () => {
    const { status } = await post(
      '/api/focus',
      { runId: SESSION_RUN_ID, nodeIds: ['a'] },
      { origin: server.url },
    );
    expect(status).toBe(200);
  });

  it('GET /api/focus is a 405, not a silent 404', async () => {
    const res = await fetch(server.url + '/api/focus');
    expect(res.status).toBe(405);
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
