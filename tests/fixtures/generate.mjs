/**
 * Deterministic fixture generator. Emits a synthetic-but-format-faithful
 * ~/.claude/projects tree under tests/fixtures/projects/, modeled 1:1 on the
 * real transcript format (verified against a 529-file corpus, CC 2.1.201–227).
 *
 * Fully synthetic content — nothing personal is ever committed. Run:
 *   node tests/fixtures/generate.mjs
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'projects');
const PROJ = join(ROOT, '-home-dev-acme');
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const WF = 'wf_12345678-abc';
const AGENT_FLAT = 'a123456789abcdef0'; // Agent-tool subagent
const AGENT_W1 = 'aaaa000000000001f'; // workflow agent, phase Find
const AGENT_W2A = 'aaaa000000000002f'; // workflow agent, failed attempt
const AGENT_W2B = 'aaaa000000000003f'; // retry of W2A
const CWD = '/home/dev/acme';

let clock = Date.parse('2026-08-01T12:00:00.000Z');
const ts = (stepMs = 1500) => new Date((clock += stepMs)).toISOString();
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

function envelope(sessionId, prev, extra = {}) {
  return {
    parentUuid: prev,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: CWD,
    sessionId,
    version: '2.1.226',
    gitBranch: 'main',
    uuid: uuid(),
    timestamp: ts(),
    ...extra,
  };
}

function assistantMsg(model, block, stop = null, out = 50) {
  return {
    id: `msg_fx${String(++uuidN).padStart(6, '0')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [block],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 4000,
      cache_creation: { ephemeral_5m_input_tokens: 900, ephemeral_1h_input_tokens: 0 },
      output_tokens: out,
      service_tier: 'standard',
      inference_geo: 'not_available',
    },
    diagnostics: null,
  };
}

async function main() {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(PROJ, { recursive: true });

  // ---------- session 1: the kitchen sink ----------
  const L = [];
  L.push({ type: 'last-prompt', leafUuid: '00000000-0000-4000-8000-000000000001', sessionId: S1 });
  L.push({ type: 'mode', mode: 'normal', sessionId: S1 });
  L.push({ type: 'permission-mode', permissionMode: 'default', sessionId: S1 });

  const root = envelope(S1, null, {
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', toolUseID: uuid(), content: '', stdout: '', stderr: '', exitCode: 0, durationMs: 12, command: 'true' },
  });
  L.push(root);

  // turn 1: prompt → thinking → Bash ×2 (one errors) → Edit
  const t1 = envelope(S1, root.uuid, { type: 'user', promptId: uuid(), message: { role: 'user', content: 'Fix the flaky login test and make CI green' } });
  L.push(t1);
  L.push({ type: 'ai-title', aiTitle: 'Fix flaky login test', sessionId: S1 });
  const think = envelope(S1, t1.uuid, { type: 'assistant', requestId: 'req_fx0001', message: assistantMsg('claude-fable-5', { type: 'thinking', thinking: 'Look at the test first.', signature: 'sig' }) });
  L.push(think);
  const bash1 = envelope(S1, think.uuid, { type: 'assistant', requestId: 'req_fx0001', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0001', name: 'Bash', input: { command: 'npm test -- login.spec.ts', description: 'Run the login test' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(bash1);
  L.push(envelope(S1, bash1.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: bash1.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0001', content: 'FAIL login.spec.ts — timeout at auth redirect', is_error: true }] }, toolUseResult: 'Error: Exit code 1' }));
  const bash2 = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0002', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0002', name: 'Bash', input: { command: 'npm test -- login.spec.ts --retries 2', description: 'Re-run with retries' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(bash2);
  L.push(envelope(S1, bash2.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: bash2.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0002', content: 'PASS on retry — race in session fixture' }] }, toolUseResult: { stdout: 'PASS on retry — race in session fixture', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }));
  const edit1 = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0003', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0003', name: 'Edit', input: { file_path: `${CWD}/tests/login.spec.ts`, old_string: 'await page.click', new_string: 'await page.waitForURL(/dash/); await page.click' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(edit1);
  L.push(envelope(S1, edit1.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: edit1.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0003', content: 'Edited tests/login.spec.ts' }] }, toolUseResult: { filePath: `${CWD}/tests/login.spec.ts`, oldString: 'await page.click', newString: 'await page.waitForURL(/dash/); await page.click', originalFile: '', replaceAll: false, structuredPatch: [], userModified: false } }));
  const done1 = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0004', message: assistantMsg('claude-fable-5', { type: 'text', text: 'Fixed: the test raced the auth redirect. Added an explicit wait.' }, 'end_turn', 80) });
  L.push(done1);
  L.push(envelope(S1, done1.uuid, { type: 'system', subtype: 'turn_duration', durationMs: 45000, messageCount: 8, isMeta: false }));

  // turn 2: prompt → async Agent spawn → question → denial+interrupt → workflow
  const t2 = envelope(S1, L.at(-2).uuid, { type: 'user', promptId: uuid(), message: { role: 'user', content: 'Now audit the auth module for similar races, then ship a hardening workflow' } });
  L.push(t2);
  const spawnA = envelope(S1, t2.uuid, { type: 'assistant', requestId: 'req_fx0005', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxA001', name: 'Agent', input: { description: 'Audit auth module for race conditions', prompt: 'Audit src/auth for race conditions like the login.spec one. Report each with file:line.', subagent_type: 'general-purpose', run_in_background: true }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(spawnA);
  L.push(envelope(S1, spawnA.uuid, { type: 'user', promptId: t2.promptId, sourceToolAssistantUUID: spawnA.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxA001', content: `Async agent launched. agentId: ${AGENT_FLAT}` }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_FLAT, description: 'Audit auth module for race conditions', prompt: 'Audit src/auth for race conditions like the login.spec one. Report each with file:line.', resolvedModel: 'claude-fable-5', outputFile: `/tmp/tasks/${AGENT_FLAT}.output`, canReadOutputFile: true } }));

  const ask = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0006', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxQ001', name: 'AskUserQuestion', input: { questions: [{ question: 'Which hardening approach should the workflow take?', header: 'Approach', options: [{ label: 'Explicit waits (Recommended)', description: 'Add waits at each redirect' }, { label: 'Retry wrapper', description: 'Wrap flaky steps in retries' }], multiSelect: false }] }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(ask);
  L.push(envelope(S1, ask.uuid, { type: 'user', promptId: t2.promptId, sourceToolAssistantUUID: ask.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxQ001', content: 'Your questions have been answered: "Which hardening approach should the workflow take?"="Explicit waits (Recommended)". You can now continue with these answers in mind.' }] }, toolUseResult: { questions: [{ question: 'Which hardening approach should the workflow take?', header: 'Approach', options: [], multiSelect: false }], answers: { 'Which hardening approach should the workflow take?': 'Explicit waits (Recommended)' }, annotations: {} } }));

  const editDeny = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0007', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxD001', name: 'Edit', input: { file_path: `${CWD}/src/auth/session.ts`, old_string: 'const TTL = 60', new_string: 'const TTL = 600' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(editDeny);
  L.push(envelope(S1, editDeny.uuid, { type: 'user', promptId: t2.promptId, sourceToolAssistantUUID: editDeny.uuid, toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxD001', content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", is_error: true }] } }));
  L.push(envelope(S1, L.at(-1).uuid, { type: 'user', promptId: t2.promptId, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));

  const t3 = envelope(S1, L.at(-1).uuid, { type: 'user', promptId: uuid(), message: { role: 'user', content: "Don't touch the TTL. Just run the hardening workflow." } });
  L.push(t3);
  const spawnW = envelope(S1, t3.uuid, { type: 'assistant', requestId: 'req_fx0008', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxW001', name: 'Workflow', input: { script: "export const meta = { name: 'auth-hardening', description: 'Find and fix auth races', phases: [{ title: 'Find' }, { title: 'Fix' }] }\nphase('Find')\n// …" }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(spawnW);
  L.push(envelope(S1, spawnW.uuid, { type: 'user', promptId: t3.promptId, sourceToolAssistantUUID: spawnW.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxW001', content: `Workflow launched in background. Task ID: wfx001\nRun ID: ${WF}` }] }, toolUseResult: { runId: WF, scriptPath: `${CWD}/../scripts/auth-hardening-${WF}.js`, status: 'async_launched', summary: 'Find and fix auth races', taskId: 'wfx001', taskType: 'local_workflow', transcriptDir: join(PROJ, S1, 'subagents', 'workflows', WF), workflowName: 'auth-hardening' } }));

  // async agent completes; notification arrives in this turn
  L.push({ type: 'queue-operation', operation: 'enqueue', timestamp: ts(), sessionId: S1, content: `<task-notification>\n<task-id>${AGENT_FLAT}</task-id>\n<tool-use-id>toolu_fxA001</tool-use-id>\n<output-file>/tmp/tasks/${AGENT_FLAT}.output</output-file>\n<status>completed</status>\n<summary>Agent "Audit auth module for race conditions" finished</summary>\n<result>Found 2 races: src/auth/session.ts:41 (refresh vs logout), src/auth/redirect.ts:12 (double navigate).</result>\n</task-notification>` });
  L.push({ type: 'queue-operation', operation: 'dequeue', timestamp: ts(), sessionId: S1 });
  const wrap = envelope(S1, L.at(-3).uuid, { type: 'assistant', requestId: 'req_fx0009', message: assistantMsg('claude-fable-5', { type: 'text', text: 'Workflow launched; audit found 2 races. Will fold both into the Fix phase.' }, 'end_turn', 60) });
  L.push(wrap);
  L.push(envelope(S1, wrap.uuid, { type: 'system', subtype: 'turn_duration', durationMs: 30000, messageCount: 12, isMeta: false }));

  // a future line type the parser must skip + count, never crash on
  L.push({ type: 'holo-recap', sessionId: S1, payload: { verdict: 'from the future' } });
  L.push({ type: 'last-prompt', lastPrompt: "Don't touch the TTL. Just run the hardening workflow.", leafUuid: wrap.uuid, sessionId: S1 });

  await writeFile(join(PROJ, `${S1}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // ---------- flat subagent transcript ----------
  const A = [];
  let prev = null;
  const aline = (extra) => {
    const l = { ...envelope(S1, prev, extra), isSidechain: true, agentId: AGENT_FLAT };
    prev = l.uuid;
    return l;
  };
  A.push(aline({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Audit src/auth for race conditions like the login.spec one. Report each with file:line.' } }));
  A.push(aline({ type: 'assistant', requestId: 'req_fxA100', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxA100', name: 'Read', input: { file_path: `${CWD}/src/auth/session.ts` }, caller: { type: 'direct' } }, 'tool_use', 40) }));
  A.push(aline({ type: 'user', promptId: uuid(), sourceToolAssistantUUID: prev, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxA100', content: 'const TTL = 60 …' }] }, toolUseResult: { type: 'text', file: { filePath: `${CWD}/src/auth/session.ts`, content: 'const TTL = 60 …', numLines: 90, startLine: 1, totalLines: 90 } } }));
  A.push(aline({ type: 'assistant', requestId: 'req_fxA101', message: assistantMsg('claude-fable-5', { type: 'text', text: 'Found 2 races: src/auth/session.ts:41 (refresh vs logout), src/auth/redirect.ts:12 (double navigate).' }, 'end_turn', 120) }));
  await mkdir(join(PROJ, S1, 'subagents'), { recursive: true });
  await writeFile(join(PROJ, S1, 'subagents', `agent-${AGENT_FLAT}.jsonl`), A.map((x) => JSON.stringify(x)).join('\n') + '\n');
  await writeFile(join(PROJ, S1, 'subagents', `agent-${AGENT_FLAT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Audit auth module for race conditions', toolUseId: 'toolu_fxA001', spawnDepth: 1 }) + '\n');

  // ---------- workflow run ----------
  const wfDir = join(PROJ, S1, 'subagents', 'workflows', WF);
  await mkdir(wfDir, { recursive: true });
  const journal = [
    { type: 'started', key: 'v2:' + 'a'.repeat(64), agentId: AGENT_W1 },
    { type: 'started', key: 'v2:' + 'b'.repeat(64), agentId: AGENT_W2A },
    { type: 'result', key: 'v2:' + 'a'.repeat(64), agentId: AGENT_W1, result: { races: 2, files: ['src/auth/session.ts', 'src/auth/redirect.ts'] } },
    { type: 'started', key: 'v2:' + 'b'.repeat(64), agentId: AGENT_W2B },
    { type: 'result', key: 'v2:' + 'b'.repeat(64), agentId: AGENT_W2B, result: 'Patched both races; tests green.' },
  ];
  await writeFile(join(wfDir, 'journal.jsonl'), journal.map((x) => JSON.stringify(x)).join('\n') + '\n');

  const wfAgent = async (agentId, promptText, finalBlock, opts = {}) => {
    const W = [];
    let p = null;
    const wl = (extra) => {
      const l = { ...envelope(S1, p, extra), isSidechain: true, agentId };
      p = l.uuid;
      return l;
    };
    W.push(wl({ type: 'user', promptId: uuid(), message: { role: 'user', content: promptText } }));
    if (opts.apiError) {
      W.push(wl({ type: 'assistant', message: { id: uuid(), type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }], stop_reason: 'stop_sequence', stop_sequence: '', stop_details: null, usage: { input_tokens: 0, output_tokens: 0 } }, isApiErrorMessage: true }));
    } else {
      W.push(wl({ type: 'assistant', requestId: `req_${agentId}1`, message: assistantMsg('claude-fable-5', { type: 'tool_use', id: `toolu_${agentId}s`, name: 'StructuredOutput', input: finalBlock, caller: { type: 'direct' } }, 'tool_use', 90) }));
      W.push(wl({ type: 'user', promptId: uuid(), toolEndsTurn: true, sourceToolAssistantUUID: p, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${agentId}s`, content: 'Structured output provided successfully' }] } }));
    }
    await writeFile(join(wfDir, `agent-${agentId}.jsonl`), W.map((x) => JSON.stringify(x)).join('\n') + '\n');
    await writeFile(join(wfDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }) + '\n');
  };
  await wfAgent(AGENT_W1, 'Find auth races. Return {races, files[]}.', { races: 2, files: ['src/auth/session.ts', 'src/auth/redirect.ts'] });
  await wfAgent(AGENT_W2A, 'Fix the races found in phase Find.', null, { apiError: true });
  await wfAgent(AGENT_W2B, 'Fix the races found in phase Find.', undefined, {});

  const wfMetaDir = join(PROJ, S1, 'workflows');
  await mkdir(join(wfMetaDir, 'scripts'), { recursive: true });
  await writeFile(join(wfMetaDir, 'scripts', `auth-hardening-${WF}.js`), "export const meta = { name: 'auth-hardening', description: 'Find and fix auth races', phases: [{ title: 'Find' }, { title: 'Fix' }] }\n");
  await writeFile(
    join(wfMetaDir, `${WF}.json`),
    JSON.stringify({
      runId: WF,
      workflowName: 'auth-hardening',
      summary: 'Find and fix auth races',
      status: 'completed',
      taskId: 'wfx001',
      script: '…',
      scriptPath: join(wfMetaDir, 'scripts', `auth-hardening-${WF}.js`),
      startTime: Date.parse('2026-08-01T12:05:00Z'),
      timestamp: '2026-08-01T12:11:00.000Z',
      durationMs: 360000,
      totalTokens: 410,
      totalToolCalls: 3,
      agentCount: 2,
      defaultModel: 'claude-fable-5',
      phases: [{ title: 'Find' }, { title: 'Fix' }],
      logs: ['2 races found', 'both patched'],
      result: { patched: 2, green: true },
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Find' },
        { type: 'workflow_phase', index: 2, title: 'Fix' },
        { type: 'workflow_agent', index: 1, label: 'find:auth-races', phaseIndex: 1, phaseTitle: 'Find', agentId: AGENT_W1, model: 'claude-fable-5', state: 'done', queuedAt: 1754049900000, startedAt: 1754049901000, lastProgressAt: 1754050020000, attempt: 1, lastToolName: 'StructuredOutput', promptPreview: 'Find auth races…', resultPreview: '{"races":2…', tokens: 140, toolCalls: 1, durationMs: 119000 },
        { type: 'workflow_agent', index: 2, label: 'fix:auth-races (retry 1)', phaseIndex: 2, phaseTitle: 'Fix', agentId: AGENT_W2B, model: 'claude-fable-5', state: 'done', queuedAt: 1754050020000, startedAt: 1754050021000, lastProgressAt: 1754050260000, attempt: 2, lastToolName: 'StructuredOutput', promptPreview: 'Fix the races…', resultPreview: 'Patched both…', tokens: 270, toolCalls: 2, durationMs: 239000 },
      ],
    }, null, 2),
  );

  // ---------- session 2: headless, no turns ----------
  const M = [
    { type: 'last-prompt', leafUuid: '99999999-0000-4000-8000-000000000001', sessionId: S2 },
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-02T09:00:00.000Z', sessionId: S2, content: 'queued kickoff prompt' },
  ];
  await writeFile(join(PROJ, `${S2}.jsonl`), M.map((x) => JSON.stringify(x)).join('\n') + '\n');

  console.error('fixtures written to', ROOT);
}

await main();
