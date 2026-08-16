import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startServer } from '../src/server.js';
import { detect, parse } from '../src/adapters/claude-code/index.js';
import { matchNodes } from '../src/find.js';
import {
  pinFixtureMtimes,
  FIXTURE_ROOT,
  CODEX_FIXTURE_ROOT,
  SESSION_RUN_ID,
  WORKFLOW_RUN_ID,
  CLEAN_RUN_ID,
  TROUBLE_RUN_ID,
  FIXTURE_RUN_COUNT,
} from './helpers.js';

let server;
beforeAll(async () => {
  await pinFixtureMtimes();
  process.env.RUNGRAPH_CLAUDE_PROJECTS = FIXTURE_ROOT;
  process.env.RUNGRAPH_CODEX_SESSIONS = CODEX_FIXTURE_ROOT;
  server = await startServer({ preferredPort: 4599 });
});
afterAll(async () => {
  delete process.env.RUNGRAPH_CLAUDE_PROJECTS;
  delete process.env.RUNGRAPH_CODEX_SESSIONS;
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

describe('the Host guard', () => {
  // fetch() will not let a caller forge Host, so speak raw http.
  const withHost = (host, path = '/api/index') =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path,
          // null = send NO Host header at all (node adds one unless told not to)
          setHost: false,
          headers: host === null ? {} : { host },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end();
    });

  // Binding 127.0.0.1 never prevented the DNS-rebinding read: a hostile page
  // resolving its own domain to 127.0.0.1 arrives same-origin, and only the
  // Host header betrays it.
  it('rejects a foreign Host on a read endpoint', async () => {
    expect(await withHost(`evil.example:${server.port}`)).toBe(403);
    expect(await withHost('evil.example')).toBe(403);
  });

  it('rejects a foreign Host on /api/export', async () => {
    expect(
      await withHost(`evil.example:${server.port}`, `/api/export?runs=${encodeURIComponent(CLEAN_RUN_ID)}`),
    ).toBe(403);
  });

  it('rejects a wrong-port and a missing Host', async () => {
    expect(await withHost('127.0.0.1:1')).toBe(403);
    // Node itself 400s a Host-less HTTP/1.1 request before our handler runs;
    // our own guard would 403 it. Either way it never reaches a read.
    expect([400, 403]).toContain(await withHost(null));
  });

  it('accepts all three local spellings', async () => {
    expect(await withHost(`127.0.0.1:${server.port}`)).toBe(200);
    expect(await withHost(`localhost:${server.port}`)).toBe(200);
    expect(await withHost(`[::1]:${server.port}`)).toBe(200);
    expect(await withHost('localhost')).toBe(200); // no port stated is fine
  });

  it('guards the static frontend too', async () => {
    expect(await withHost('evil.example', '/')).toBe(403);
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
      expect(view.body.runs).toHaveLength(1);
      expect(view.body.runs[0]).toMatchObject({ runId: SESSION_RUN_ID, clientCount: 1 });
      expect(Date.parse(view.body.runs[0].connectedAt)).toBeGreaterThan(0);

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

  // With two tabs on two runs, "this run" was a coin flip: Map order is
  // insertion order, so the default answer was the tab open the LONGEST.
  it('GET /api/view reports the most recently opened run first', async () => {
    const first = await openWatch(WORKFLOW_RUN_ID);
    const second = await openWatch(SESSION_RUN_ID);
    try {
      const { body } = await get('/api/view');
      expect(body.runs.map((r) => r.runId)).toEqual([SESSION_RUN_ID, WORKFLOW_RUN_ID]);
    } finally {
      await first.close();
      await second.close();
    }
  }, 20000);

  // Broadcast, not narrowcast: a tab showing another run has to hear about the
  // answer to be able to follow it there. Being told "here is a url, go paste
  // it" is the loop failing at the last inch.
  it('POST /api/focus reaches a client watching a DIFFERENT run', async () => {
    const elsewhere = await openWatch(WORKFLOW_RUN_ID);
    try {
      const { body } = await post('/api/focus', {
        runId: SESSION_RUN_ID,
        nodeIds: ['a:toolu_fxA001'],
        label: 'the audit',
        reason: 'because',
      });
      expect(body).toMatchObject({ ok: true, clientCount: 0, otherClients: 1 });

      const frame = await elsewhere.waitFor((f) => f.type === 'focus' && !f.replayed);
      expect(frame).toMatchObject({ runId: SESSION_RUN_ID, alreadyWatching: false });
    } finally {
      await elsewhere.close();
    }
  }, 20000);

  // A tab already on the target run will handle it, so tabs on other runs must
  // stay put — otherwise asking about run B drags every window onto B.
  it('marks alreadyWatching when a tab is on the target run', async () => {
    const onTarget = await openWatch(SESSION_RUN_ID);
    try {
      await post('/api/focus', { runId: SESSION_RUN_ID, nodeIds: ['a:toolu_fxA001'] });
      const frame = await onTarget.waitFor((f) => f.type === 'focus' && !f.replayed);
      expect(frame.alreadyWatching).toBe(true);
    } finally {
      await onTarget.close();
    }
  }, 20000);

  // What makes a cold start work: the answer is held, so a tab opened *because*
  // the agent asked for it arrives already pointed at it.
  it('replays a held focus to a client that connects afterwards', async () => {
    await post('/api/focus', {
      runId: WORKFLOW_RUN_ID,
      nodeIds: ['w:root'],
      label: 'the workflow',
      reason: 'held for a browser that had not arrived yet',
    });
    const late = await openWatch(WORKFLOW_RUN_ID);
    try {
      const frame = await late.waitFor((f) => f.type === 'focus');
      expect(frame).toMatchObject({
        runId: WORKFLOW_RUN_ID,
        label: 'the workflow',
        replayed: true,
      });
    } finally {
      await late.close();
    }
  }, 20000);

  it('GET /api/focus is a 405, not a silent 404', async () => {
    const res = await fetch(server.url + '/api/focus');
    expect(res.status).toBe(405);
  });

  // Deliberately not "the first frame is a snapshot": a client can legitimately
  // receive a replayed focus before its snapshot, which is exactly why the
  // frontend holds an agent focus until the matching graph is in hand.
  it('SSE watch delivers a snapshot', async () => {
    const res = await fetch(`${server.url}/api/watch/${encodeURIComponent(WORKFLOW_RUN_ID)}`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body.cancel();

    const watch = await openWatch(WORKFLOW_RUN_ID);
    try {
      const snapshot = await watch.waitFor((f) => f.type === 'snapshot', 8000);
      expect(snapshot).toBeDefined();
      expect(snapshot.graph.meta.runId).toBe(WORKFLOW_RUN_ID);
    } finally {
      await watch.close();
    }
  }, 20000);
});
