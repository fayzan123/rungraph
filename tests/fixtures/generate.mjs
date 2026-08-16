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
const S3 = '33333333-3333-4333-8333-333333333333'; // clean run — the signals precision guard
const S4 = '44444444-4444-4444-8444-444444444444'; // trouble run — one of every high signal
const S5 = '55555555-5555-4555-8555-555555555555'; // secrets run — one of every scanner pattern
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
  // narration then a Grep — the narration becomes the group's "why" context.
  // One streamed API response = one message.id + requestId across both lines
  // (usage repeats verbatim; only the final line carries the stop_reason).
  const narrMsg = assistantMsg('claude-fable-5', { type: 'text', text: 'Edit is in — checking the wait pattern actually landed before rerunning CI.' }, null, 50);
  const narr = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0010', message: narrMsg });
  L.push(narr);
  const grep1 = envelope(S1, narr.uuid, { type: 'assistant', requestId: 'req_fx0010', message: { ...narrMsg, content: [{ type: 'tool_use', id: 'toolu_fx0011', name: 'Grep', input: { pattern: 'waitForURL', path: `${CWD}/tests` }, caller: { type: 'direct' } }], stop_reason: 'tool_use' } });
  L.push(grep1);
  L.push(envelope(S1, grep1.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: grep1.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0011', content: 'tests/login.spec.ts:12: await page.waitForURL(/dash/);' }] }, toolUseResult: { mode: 'content', numFiles: 1, filenames: ['tests/login.spec.ts'], numLines: 1 } }));
  // Read (no narration in between — context must NOT leak onto this group)
  const read1 = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0012', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0012', name: 'Read', input: { file_path: `${CWD}/tests/login.spec.ts` }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(read1);
  L.push(envelope(S1, read1.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: read1.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0012', content: 'await page.waitForURL(/dash/); await page.click …' }] }, toolUseResult: { type: 'text', file: { filePath: `${CWD}/tests/login.spec.ts`, content: 'await page.waitForURL(/dash/); await page.click …', numLines: 40, startLine: 1, totalLines: 40 } } }));
  // Bash with no description — label falls back to the command
  const bash3 = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0013', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0013', name: 'Bash', input: { command: 'npm run lint' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(bash3);
  L.push(envelope(S1, bash3.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: bash3.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0013', content: 'lint clean' }] }, toolUseResult: { stdout: 'lint clean', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }));
  // a tool this rungraph version has no label rule for — plain-name fallback
  const hyper = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0014', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0014', name: 'Hypervisor', input: { vm: 'ci-sandbox', op: 'checkpoint' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(hyper);
  L.push(envelope(S1, hyper.uuid, { type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: hyper.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0014', content: 'checkpoint saved' }] }, toolUseResult: { op: 'checkpoint', ok: true } }));

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

  // continuation WITHOUT a new human prompt: the workflow notification lands
  // as a user string line, then a tool call — the previous turn's sign-off
  // text must NOT leak into this group's "why" context
  L.push(envelope(S1, L.at(-2).uuid, { type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>wfx001</task-id>\n<tool-use-id>toolu_fxW001</tool-use-id>\n<status>completed</status>\n<summary>Workflow "auth-hardening" completed</summary>\n<result>{"patched":2,"green":true}</result>\n</task-notification>` } }));
  const bashGit = envelope(S1, L.at(-1).uuid, { type: 'assistant', requestId: 'req_fx0015', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fx0015', name: 'Bash', input: { command: 'git log --oneline -1', description: 'Confirm hardening commit' }, caller: { type: 'direct' } }, 'tool_use') });
  L.push(bashGit);
  L.push(envelope(S1, bashGit.uuid, { type: 'user', sourceToolAssistantUUID: bashGit.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx0015', content: 'a1b2c3d fix: auth race hardening' }] }, toolUseResult: { stdout: 'a1b2c3d fix: auth race hardening', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }));

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

  await cleanSession();
  await troubleSession();
  await secretsSession();
  await codexFixtures();

  console.error('fixtures written to', ROOT);
}

/**
 * Codex rollout fixtures, modeled 1:1 on the real `~/.codex/sessions` format
 * (verified against the 74-rollout corpus, cli 0.78.0–0.144.4, discovery
 * 2026-08-15): `{timestamp, type, payload}` envelopes, a task_started/
 * task_complete turn spine, call_id-paired tool calls, patch_apply_end file
 * records, and subagent threads as separate rollout files carrying
 * fork-inherited parent history with ORIGINAL timestamps.
 *
 * Two runs: a CLEAN one (the Codex precision guard — zero signals) and a
 * SUBAGENT one (cross-file lineage, an interrupt, a recovered tool error,
 * and two unknown-line shapes the parser must skip and count).
 */
async function codexFixtures() {
  const CODEX_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'codex');
  await rm(CODEX_ROOT, { recursive: true, force: true });
  const DAY = join(CODEX_ROOT, '2026', '08', '01');
  await mkdir(DAY, { recursive: true });

  const C1 = 'c1c1c1c1-0000-7000-8000-000000000001';
  const C2P = 'c2c2c2c2-0000-7000-8000-000000000002';
  const C2C = 'c2c2c2c2-0000-7000-8000-00000000c41d';
  const C2G = 'c2c2c2c2-0000-7000-8000-00000000c42d'; // grandchild (depth 2)
  const C3 = 'c3c3c3c3-0000-7000-8000-000000000003'; // old format (0.89, no task events)

  let codexClock = Date.parse('2026-08-01T10:00:00.000Z');
  const cts = (stepMs = 2000) => new Date((codexClock += stepMs)).toISOString();
  const line = (type, payload, timestamp = cts()) => ({ timestamp, type, payload });
  const usage = (input, output, cumIn, cumOut) => ({
    info: {
      total_token_usage: { input_tokens: cumIn, cached_input_tokens: 0, output_tokens: cumOut, reasoning_output_tokens: 0, total_tokens: cumIn + cumOut },
      last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
      model_context_window: 258400,
    },
    rate_limits: { limit_id: 'codex', primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1754050000 } },
  });
  const meta = (id, extra = {}) => ({
    id,
    timestamp: new Date(codexClock).toISOString(),
    cwd: CWD,
    originator: 'codex_vscode',
    cli_version: '0.144.4',
    source: 'vscode',
    thread_source: 'user',
    model_provider: 'openai',
    base_instructions: null,
    git: { commit_hash: 'a1b2c3d', branch: 'main', repository_url: 'git@github.com:dev/acme.git' },
    ...extra,
  });
  const turnCtx = (turnId) => ({
    turn_id: turnId,
    cwd: CWD,
    model: 'gpt-5.5-codex',
    effort: 'medium',
    approval_policy: 'on-request',
    sandbox_policy: { mode: 'workspace-write' },
    summary: 'auto',
  });

  // ---------- C1: the Codex clean run ----------
  const L1 = [];
  L1.push(line('session_meta', meta(C1)));
  L1.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c1a', model_context_window: 258400 }));
  L1.push(line('turn_context', turnCtx('turn-c1a')));
  // IDE-context wrapper: the typed text is the final section's body.
  L1.push(line('event_msg', { type: 'user_message', message: '# Context from my IDE setup:\n\n## Active file: src/forms/signup.ts\n\n## My request for Codex:\nAdd input validation to the signup form', images: [], local_images: [], text_elements: [] }));
  L1.push(line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n…duplicate the parser must skip…' }] }));
  L1.push(line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Scanning the form component**' }], content: null, encrypted_content: 'gAAAAABfixture' }));
  L1.push(line('event_msg', { type: 'agent_message', message: 'Looking at the form component first.', phase: 'commentary', memory_citation: null }));
  L1.push(line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n "signup" src/', workdir: CWD, max_output_tokens: 8000, yield_time_ms: 30000 }), call_id: 'call_c1grep', metadata: { turn_id: 'turn-c1a' } }));
  L1.push(line('response_item', { type: 'function_call_output', call_id: 'call_c1grep', output: 'Chunk ID: ab12cd\nWall time: 0.0513 seconds\nProcess exited with code 0\nOutput:\nsrc/forms/signup.ts:10: export function signup(' }));
  L1.push(line('event_msg', { type: 'token_count', ...usage(9000, 300, 9000, 300) }));
  const c1patch = 'const patch = "*** Begin Patch\\n*** Update File: /home/dev/acme/src/forms/signup.ts\\n@@\\n-  submit(email)\\n+  if (!email.includes(\\"@\\")) throw new Error(\\"invalid email\\");\\n+  submit(email)\\n*** End Patch";\nconst r = await tools.exec_command({ cmd: `apply_patch <<\'EOF\'\n${patch}\nEOF` });';
  L1.push(line('response_item', { type: 'custom_tool_call', id: 'ctc_c1', status: 'completed', call_id: 'call_c1patch', name: 'exec', input: c1patch, internal_chat_message_metadata_passthrough: { turn_id: 'turn-c1a' } }));
  // The dominant 0.144.x output shape is a REAL JSON array of content parts,
  // not a string (corpus census: 3,727 of 4,379).
  L1.push(line('response_item', { type: 'custom_tool_call_output', call_id: 'call_c1patch', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' }, { type: 'input_text', text: 'Success. Updated the following files:\nM src/forms/signup.ts\n' }] }));
  L1.push(line('event_msg', { type: 'patch_apply_end', call_id: 'exec-11111111-aaaa-4aaa-8aaa-111111111111', turn_id: 'turn-c1a', stdout: 'Success. Updated the following files:\nM src/forms/signup.ts\n', stderr: '', success: true, status: 'completed', changes: { [`${CWD}/src/forms/signup.ts`]: { type: 'update', unified_diff: '@@ -10,1 +10,2 @@\n-  submit(email)\n+  if (!email.includes("@")) throw new Error("invalid email");\n+  submit(email)', move_path: null } } }));
  L1.push(line('event_msg', { type: 'token_count', ...usage(11000, 500, 20000, 800) }));
  L1.push(line('event_msg', { type: 'agent_message', message: 'Validation added: the form now rejects addresses without an @.', phase: 'final_answer', memory_citation: null }));
  L1.push(line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Validation added: the form now rejects addresses without an @.' }] }));
  L1.push(line('event_msg', { type: 'task_complete', turn_id: 'turn-c1a', last_agent_message: 'Validation added: the form now rejects addresses without an @.', completed_at: new Date(codexClock).toISOString(), duration_ms: 42000, time_to_first_token_ms: 2800 }));
  // turn 2: a quick clean check
  L1.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c1b', model_context_window: 258400 }));
  L1.push(line('turn_context', turnCtx('turn-c1b')));
  L1.push(line('event_msg', { type: 'user_message', message: 'Run the form tests', images: [] }));
  L1.push(line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test -- signup', workdir: CWD }), call_id: 'call_c1test', metadata: { turn_id: 'turn-c1b' } }));
  L1.push(line('response_item', { type: 'function_call_output', call_id: 'call_c1test', output: 'Chunk ID: ef34ab\nWall time: 4.2 seconds\nProcess exited with code 0\nOutput:\n8 passed' }));
  L1.push(line('event_msg', { type: 'token_count', ...usage(6000, 200, 26000, 1000) }));
  L1.push(line('event_msg', { type: 'agent_message', message: 'All 8 signup tests pass.', phase: 'final_answer', memory_citation: null }));
  L1.push(line('event_msg', { type: 'task_complete', turn_id: 'turn-c1b', last_agent_message: 'All 8 signup tests pass.', completed_at: new Date(codexClock).toISOString(), duration_ms: 38000, time_to_first_token_ms: 2100 }));
  await writeFile(join(DAY, `rollout-2026-08-01T10-00-00-${C1}.jsonl`), L1.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // ---------- C2: parent with a spawned subagent ----------
  const L2 = [];
  L2.push(line('session_meta', meta(C2P, { multi_agent_version: 'v2', session_id: C2P })));
  L2.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c2a', model_context_window: 258400 }));
  L2.push(line('turn_context', turnCtx('turn-c2a')));
  const parentPromptTs = cts(); // the child's inherited copy reuses this instant
  L2.push(line('event_msg', { type: 'user_message', message: 'Map the auth module, then fix the session bug', images: [] }, parentPromptTs));
  L2.push(line('response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'auth_map', fork_turns: 'all', message: 'gAAAAABencryptedtaskpayload' }), call_id: 'call_c2spawn', metadata: { turn_id: 'turn-c2a' } }));
  L2.push(line('event_msg', { type: 'sub_agent_activity', event_id: 'call_c2spawn', occurred_at_ms: codexClock, agent_thread_id: C2C, agent_path: '/root/auth_map', kind: 'started' }));
  L2.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2spawn', output: '{"task_name":"/root/auth_map"}' }));
  L2.push(line('response_item', { type: 'function_call', name: 'wait_agent', arguments: JSON.stringify({ targets: ['/root/auth_map'], timeout_ms: 60000 }), call_id: 'call_c2wait' }));
  L2.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2wait', output: '{"message":"Wait completed.","timed_out":false}' }));
  L2.push(line('inter_agent_communication_metadata', { trigger_turn: true }));
  L2.push(line('response_item', { type: 'agent_message', author: '/root/auth_map', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/auth_map\nPayload:\nAuth map: token.js owns refresh; the session bug is the TTL reset in session.ts:41.' }] }));
  L2.push(line('event_msg', { type: 'agent_message', message: 'The map is in — patching session.ts.', phase: 'commentary', memory_citation: null }));
  L2.push(line('response_item', { type: 'custom_tool_call', id: 'ctc_c2', status: 'completed', call_id: 'call_c2patch', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/auth/session.ts\n@@\n-const TTL = 60\n+const TTL = 600\n*** End Patch' }));
  L2.push(line('response_item', { type: 'custom_tool_call_output', call_id: 'call_c2patch', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/auth/session.ts\n', metadata: { exit_code: 0, duration_seconds: 0.02 } }) }));
  L2.push(line('event_msg', { type: 'patch_apply_end', call_id: 'call_c2patch', turn_id: 'turn-c2a', stdout: 'Success. Updated the following files:\nM src/auth/session.ts\n', stderr: '', success: true, status: 'completed', changes: { [`${CWD}/src/auth/session.ts`]: { type: 'update', unified_diff: '@@ -41,1 +41,1 @@\n-const TTL = 60\n+const TTL = 600', move_path: null } } }));
  L2.push(line('event_msg', { type: 'token_count', ...usage(15000, 800, 15000, 800) }));
  L2.push(line('event_msg', { type: 'turn_aborted', turn_id: 'turn-c2a', reason: 'interrupted' }));
  L2.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c2b', model_context_window: 258400 }));
  L2.push(line('turn_context', turnCtx('turn-c2b')));
  L2.push(line('event_msg', { type: 'user_message', message: 'Just run the tests', images: [] }));
  L2.push(line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test -- session', workdir: CWD }), call_id: 'call_c2t1', metadata: { turn_id: 'turn-c2b' } }));
  L2.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2t1', output: 'Chunk ID: 9f2e11\nWall time: 3.9 seconds\nProcess exited with code 1\nOutput:\nFAIL session.spec.ts — TTL still cached' }));
  L2.push(line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test -- session --clearCache', workdir: CWD }), call_id: 'call_c2t2', metadata: { turn_id: 'turn-c2b' } }));
  L2.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2t2', output: 'Chunk ID: 9f2e12\nWall time: 4.4 seconds\nProcess exited with code 0\nOutput:\n12 passed' }));
  L2.push(line('event_msg', { type: 'token_count', ...usage(9000, 400, 24000, 1200) }));
  // Two future shapes the parser must skip + count, never crash on.
  L2.push(line('holo-sync', { verdict: 'from the future' }));
  L2.push(line('event_msg', { type: 'quantum_status', qubits: 8 }));
  L2.push(line('event_msg', { type: 'agent_message', message: 'Tests pass after clearing the cache.', phase: 'final_answer', memory_citation: null }));
  L2.push(line('event_msg', { type: 'task_complete', turn_id: 'turn-c2b', last_agent_message: 'Tests pass after clearing the cache.', completed_at: new Date(codexClock).toISOString(), duration_ms: 51000, time_to_first_token_ms: 2500 }));
  await writeFile(join(DAY, `rollout-2026-08-01T11-00-00-${C2P}.jsonl`), L2.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // ---------- C2C: the subagent rollout, with fork-inherited history ----------
  // Modeled on real 0.144.x children: the inherited block is RE-STAMPED at
  // fork time (the parent's meta lands 1ms after line 1, its history a few ms
  // later — a timestamp filter cannot cut it), sits between the second
  // session_meta and the NEW_TASK delivery, and even contains the parent's
  // own task_started/user_message/token_count lines.
  const childStart = cts();
  const stampMs = Date.parse(childStart);
  const stamp = (deltaMs) => new Date(stampMs + deltaMs).toISOString();
  const L3 = [];
  L3.push(line('session_meta', {
    ...meta(C2C, { session_id: C2P, parent_thread_id: C2P, forked_from_id: C2P }),
    thread_source: 'subagent',
    agent_nickname: 'Darwin',
    agent_path: '/root/auth_map',
    multi_agent_version: 'v2',
    source: { subagent: { thread_spawn: { parent_thread_id: C2P, depth: 1, agent_path: '/root/auth_map', agent_nickname: 'Darwin', agent_role: null } } },
  }, childStart));
  // Fork-inherited parent records — re-stamped 1–4ms after line 1.
  L3.push(line('session_meta', meta(C2P, { multi_agent_version: 'v2', session_id: C2P }), stamp(1)));
  L3.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c2a', model_context_window: 258400 }, stamp(1)));
  L3.push(line('event_msg', { type: 'user_message', message: 'Map the auth module, then fix the session bug', images: [] }, stamp(2)));
  L3.push(line('event_msg', { type: 'token_count', ...usage(15000, 800, 15000, 800) }, stamp(3)));
  // The child's own turn starts (still inside the fork burst)…
  L3.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c2c1', model_context_window: 258400 }, stamp(9)));
  L3.push(line('turn_context', turnCtx('turn-c2c1'), stamp(10)));
  // …and its own story begins at the NEW_TASK delivery.
  L3.push(line('inter_agent_communication_metadata', { trigger_turn: true }, stamp(1100)));
  L3.push(line('response_item', { type: 'agent_message', author: '/root', recipient: '/root/auth_map', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/auth_map\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'gAAAAABencrypted' }] }, stamp(1101)));
  L3.push(line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n "session" src/auth/', workdir: CWD }), call_id: 'call_c2c_grep', metadata: { turn_id: 'turn-c2c1' } }));
  L3.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2c_grep', output: 'Chunk ID: 77aa88\nWall time: 0.09 seconds\nProcess exited with code 0\nOutput:\nsrc/auth/session.ts:41: const TTL = 60' }));
  // The child spawns its OWN subagent — a depth-2 grandchild in its own rollout.
  L3.push(line('response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'token_check', fork_turns: 'all', message: 'gAAAAABgrandchildtask' }), call_id: 'call_c2g' }));
  L3.push(line('event_msg', { type: 'sub_agent_activity', event_id: 'call_c2g', occurred_at_ms: codexClock, agent_thread_id: C2G, agent_path: '/root/auth_map/token_check', kind: 'started' }));
  L3.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2g', output: '{"task_name":"/root/auth_map/token_check"}' }));
  L3.push(line('event_msg', { type: 'patch_apply_end', call_id: 'exec-22222222-bbbb-4bbb-8bbb-222222222222', turn_id: 'turn-c2c1', stdout: 'Success. Updated the following files:\nA docs/auth-map.md\n', stderr: '', success: true, status: 'completed', changes: { [`${CWD}/docs/auth-map.md`]: { type: 'add', content: '# Auth map\n\ntoken.js owns refresh.' } } }));
  L3.push(line('event_msg', { type: 'token_count', ...usage(5000, 400, 5000, 400) }));
  L3.push(line('event_msg', { type: 'agent_message', message: 'Auth map: token.js owns refresh; the session bug is the TTL reset in session.ts:41.', phase: 'final_answer', memory_citation: null }));
  L3.push(line('event_msg', { type: 'task_complete', turn_id: 'turn-c2c1', last_agent_message: 'Auth map: token.js owns refresh; the session bug is the TTL reset in session.ts:41.', completed_at: new Date(codexClock).toISOString(), duration_ms: 30000, time_to_first_token_ms: 1900 }));
  await writeFile(join(DAY, `rollout-2026-08-01T11-01-00-${C2C}.jsonl`), L3.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // ---------- C2G: the grandchild rollout (depth 2) ----------
  const L4 = [];
  L4.push(line('session_meta', {
    ...meta(C2G, { session_id: C2P, parent_thread_id: C2C, forked_from_id: C2C }),
    thread_source: 'subagent',
    agent_nickname: 'Bohr',
    agent_path: '/root/auth_map/token_check',
    multi_agent_version: 'v2',
    source: { subagent: { thread_spawn: { parent_thread_id: C2C, depth: 2, agent_path: '/root/auth_map/token_check', agent_nickname: 'Bohr', agent_role: null } } },
  }));
  L4.push(line('event_msg', { type: 'task_started', turn_id: 'turn-c2g1', model_context_window: 258400 }));
  L4.push(line('turn_context', turnCtx('turn-c2g1')));
  L4.push(line('inter_agent_communication_metadata', { trigger_turn: true }));
  L4.push(line('response_item', { type: 'agent_message', author: '/root/auth_map', recipient: '/root/auth_map/token_check', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/auth_map/token_check\nSender: /root/auth_map\nPayload:\n' }] }));
  L4.push(line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rg -n "refresh" src/auth/token.js', workdir: CWD }), call_id: 'call_c2g_grep', metadata: { turn_id: 'turn-c2g1' } }));
  L4.push(line('response_item', { type: 'function_call_output', call_id: 'call_c2g_grep', output: 'Chunk ID: 88bb99\nWall time: 0.05 seconds\nProcess exited with code 0\nOutput:\nsrc/auth/token.js:12: refresh()' }));
  L4.push(line('event_msg', { type: 'token_count', ...usage(1000, 100, 1000, 100) }));
  L4.push(line('event_msg', { type: 'agent_message', message: 'token.js refresh path is sound.', phase: 'final_answer', memory_citation: null }));
  L4.push(line('event_msg', { type: 'task_complete', turn_id: 'turn-c2g1', last_agent_message: 'token.js refresh path is sound.', completed_at: new Date(codexClock).toISOString(), duration_ms: 12000, time_to_first_token_ms: 1400 }));
  await writeFile(join(DAY, `rollout-2026-08-01T11-02-00-${C2G}.jsonl`), L4.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // ---------- C3: an old-format session (0.89 — no task events at all) ----------
  // Turn boundaries are user_message ordering; the file ends at a response
  // boundary, unmarked — which is this format's NORMAL clean ending.
  const OLD_DAY = join(CODEX_ROOT, '2026', '07', '30');
  await mkdir(OLD_DAY, { recursive: true });
  const L5 = [];
  L5.push(line('session_meta', { id: C3, timestamp: new Date(codexClock).toISOString(), cwd: CWD, originator: 'codex-tui', cli_version: '0.89.0', source: 'cli', model_provider: 'openai', base_instructions: null, git: { commit_hash: 'ffee11', branch: 'main', repository_url: 'git@github.com:dev/acme.git' } }));
  L5.push(line('event_msg', { type: 'user_message', message: 'List the auth files', images: [] }));
  L5.push(line('response_item', { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'ls src/auth', workdir: CWD }), call_id: 'call_c3ls' }));
  L5.push(line('response_item', { type: 'function_call_output', call_id: 'call_c3ls', output: 'Exit code: 0\nWall time: 0.3 seconds\nTotal output lines: 3\nOutput:\nsession.ts\ntoken.js\nredirect.ts' }));
  L5.push(line('event_msg', { type: 'token_count', ...usage(3000, 150, 3000, 150) }));
  L5.push(line('event_msg', { type: 'agent_message', message: 'Three files: session.ts, token.js, redirect.ts.', memory_citation: null }));
  L5.push(line('event_msg', { type: 'user_message', message: 'Which one owns refresh?', images: [] }));
  L5.push(line('response_item', { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'grep -n refresh src/auth/token.js', workdir: CWD }), call_id: 'call_c3grep' }));
  L5.push(line('response_item', { type: 'function_call_output', call_id: 'call_c3grep', output: 'Exit code: 0\nWall time: 0.2 seconds\nTotal output lines: 1\nOutput:\n12: export function refresh()' }));
  L5.push(line('event_msg', { type: 'token_count', ...usage(2500, 120, 5500, 270) }));
  L5.push(line('event_msg', { type: 'agent_message', message: 'token.js owns refresh (line 12).', memory_citation: null }));
  await writeFile(join(OLD_DAY, `rollout-2026-07-30T09-00-00-${C3}.jsonl`), L5.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/**
 * Session 3 — a run where nothing went wrong: no tool errors, no human
 * intervention, no decision lineage, nothing outsized. It exists to hold
 * `deriveSignals` to zero. That assertion is the precision guard for the whole
 * signal layer and the test most likely to catch threshold drift.
 */
async function cleanSession() {
  const L = [];
  const push = (extra) => {
    const l = envelope(S3, L.at(-1)?.uuid ?? null, extra);
    L.push(l);
    return l;
  };
  L.push({ type: 'mode', mode: 'normal', sessionId: S3 });

  const t1 = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Add a CHANGELOG entry for the 0.2 release' } });
  L.push({ type: 'ai-title', aiTitle: 'Add CHANGELOG entry', sessionId: S3 });
  const read = push({ type: 'assistant', requestId: 'req_fxC001', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxC001', name: 'Read', input: { file_path: `${CWD}/CHANGELOG.md` }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: read.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxC001', content: '# Changelog\n\n## 0.1.2' }] }, toolUseResult: { type: 'text', file: { filePath: `${CWD}/CHANGELOG.md`, content: '# Changelog', numLines: 3, startLine: 1, totalLines: 3 } } });
  const edit = push({ type: 'assistant', requestId: 'req_fxC002', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxC002', name: 'Edit', input: { file_path: `${CWD}/CHANGELOG.md`, old_string: '## 0.1.2', new_string: '## 0.2.0\n\n## 0.1.2' }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: edit.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxC002', content: 'Edited CHANGELOG.md' }] }, toolUseResult: { filePath: `${CWD}/CHANGELOG.md`, oldString: '## 0.1.2', newString: '## 0.2.0', originalFile: '', replaceAll: false, structuredPatch: [], userModified: false } });
  const done = push({ type: 'assistant', requestId: 'req_fxC003', message: assistantMsg('claude-fable-5', { type: 'text', text: 'Added the 0.2.0 heading above 0.1.2.' }, 'end_turn', 60) });
  push({ type: 'system', subtype: 'turn_duration', durationMs: 41000, messageCount: 4, isMeta: false });

  const t2 = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Now run the tests' } });
  const bash = push({ type: 'assistant', requestId: 'req_fxC004', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxC004', name: 'Bash', input: { command: 'npm test', description: 'Run the suite' }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t2.promptId, sourceToolAssistantUUID: bash.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxC004', content: '31 passed' }] }, toolUseResult: { stdout: '31 passed', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });
  push({ type: 'assistant', requestId: 'req_fxC005', message: assistantMsg('claude-fable-5', { type: 'text', text: 'All 31 tests pass.' }, 'end_turn', 55) });
  push({ type: 'system', subtype: 'turn_duration', durationMs: 52000, messageCount: 3, isMeta: false });
  void done;

  await writeFile(join(PROJ, `${S3}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/**
 * Session 5 — one of every secrets-scanner pattern kind, planted across the
 * four places outgoing text lives: the user's prompt, a tool output, a tool
 * input, and file content read back. Every value is OBVIOUSLY synthetic
 * (FAKE/zero bodies) while still matching the shipped anchored patterns —
 * `rungraph export` on this run must block with exit 1 and name every one.
 */
async function secretsSession() {
  const L = [];
  const push = (extra) => {
    const l = envelope(S5, L.at(-1)?.uuid ?? null, extra);
    L.push(l);
    return l;
  };
  const F4 = 'FAKE';
  const FAKE20 = F4.repeat(5);
  const FAKE36 = F4.repeat(9);
  const FAKE40 = F4.repeat(10);
  L.push({ type: 'mode', mode: 'normal', sessionId: S5 });

  // your prompt: AWS access key + GitHub classic token
  const t1 = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: `I leaked AKIA${F4.repeat(4)} and ghp_${FAKE36} in the logs — rotate both and scrub the repo` } });
  L.push({ type: 'ai-title', aiTitle: 'Rotate leaked credentials', sessionId: S5 });

  // Bash OUTPUT: an env dump with Slack, npm, Anthropic, OpenAI project keys.
  // The Slack fake must NOT use digits for the workspace-id segment: GitHub
  // push protection matches xox?-<digits>-… and blocks any push of this repo.
  const bash = push({ type: 'assistant', requestId: 'req_fxS001', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxS001', name: 'Bash', input: { command: 'env | grep -i token', description: 'Find what else is exposed' }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: bash.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxS001', content: `SLACK_TOKEN=xoxb-FAKE-FAKE-${FAKE20}\nNPM_TOKEN=npm_${FAKE36}\nANTHROPIC_API_KEY=sk-ant-api03-${FAKE20}\nOPENAI_API_KEY=sk-proj-${FAKE20}` }] }, toolUseResult: { stdout: 'redacted-for-fixture', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });

  // Edit INPUT: Google + Stripe keys landing in a config file
  const edit = push({ type: 'assistant', requestId: 'req_fxS002', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxS002', name: 'Edit', input: { file_path: `${CWD}/.env.local`, old_string: 'GOOGLE_KEY=', new_string: `GOOGLE_KEY=AIza${'0'.repeat(31)}FAKE\nSTRIPE_KEY=sk_live_${FAKE20}` }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: edit.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxS002', content: 'Edited .env.local' }] }, toolUseResult: { filePath: `${CWD}/.env.local`, oldString: 'GOOGLE_KEY=', newString: 'redacted-for-fixture', originalFile: '', replaceAll: false, structuredPatch: [], userModified: false } });

  // Read OUTPUT: file content with the remaining kinds — PEM block, SendGrid,
  // GitLab, fine-grained GitHub PAT, OpenAI legacy, AWS secret assignment
  const read = push({ type: 'assistant', requestId: 'req_fxS003', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxS003', name: 'Read', input: { file_path: `${CWD}/ops/deploy.key` }, caller: { type: 'direct' } }, 'tool_use') });
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE40}\n-----END RSA PRIVATE KEY-----`;
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: read.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxS003', content: `${pem}\nSENDGRID=SG.${'A'.repeat(22)}.${'B'.repeat(43)}\nGITLAB=glpat-${FAKE20}\nGH_PAT=github_pat_${'0'.repeat(22)}\nLEGACY=sk-${'A'.repeat(20)}T3BlbkFJ${'B'.repeat(20)}\naws_secret_access_key = ${FAKE40}` }] }, toolUseResult: { type: 'text', file: { filePath: `${CWD}/ops/deploy.key`, content: 'redacted-for-fixture', numLines: 8, startLine: 1, totalLines: 8 } } });

  push({ type: 'assistant', requestId: 'req_fxS004', message: assistantMsg('claude-fable-5', { type: 'text', text: 'All of these need rotation before anything else happens.' }, 'end_turn', 60) });
  push({ type: 'system', subtype: 'turn_duration', durationMs: 30000, messageCount: 7, isMeta: false });

  await writeFile(join(PROJ, `${S5}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/**
 * Session 4 — one of every high-severity signal, end to end through the real
 * adapter rather than a hand-built IR:
 *   retry-storm       Edit fails 3× in a row on the same file (one collapsed node)
 *   unresolved-error  the LAST Bash in the lane fails, after an earlier one passed
 *   outlier           a 25-minute turn against a 60/90s median
 */
async function troubleSession() {
  const L = [];
  const push = (extra) => {
    const l = envelope(S4, L.at(-1)?.uuid ?? null, extra);
    L.push(l);
    return l;
  };
  const TOKEN = `${CWD}/src/auth/token.js`;
  L.push({ type: 'mode', mode: 'normal', sessionId: S4 });

  const t1 = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Move the token store onto the new refresh API' } });
  L.push({ type: 'ai-title', aiTitle: 'Migrate token store', sessionId: S4 });
  const okBash = push({ type: 'assistant', requestId: 'req_fxT001', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxT001', name: 'Bash', input: { command: 'npm test -- token', description: 'Baseline the token tests' }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: okBash.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxT001', content: '12 passed' }] }, toolUseResult: { stdout: '12 passed', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });
  // Three consecutive failing Edits collapse into ONE node: callCount 3, errorCount 3.
  for (let i = 1; i <= 3; i++) {
    const e = push({ type: 'assistant', requestId: `req_fxT10${i}`, message: assistantMsg('claude-fable-5', { type: 'tool_use', id: `toolu_fxT10${i}`, name: 'Edit', input: { file_path: TOKEN, old_string: 'refreshToken(', new_string: 'refresh(' }, caller: { type: 'direct' } }, 'tool_use') });
    push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: e.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_fxT10${i}`, content: 'String to replace not found in file.', is_error: true }] }, toolUseResult: 'Error: String to replace not found in file.' });
  }
  push({ type: 'system', subtype: 'turn_duration', durationMs: 60000, messageCount: 8, isMeta: false });

  const t2 = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Read the file first, then patch it' } });
  const read = push({ type: 'assistant', requestId: 'req_fxT200', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxT200', name: 'Read', input: { file_path: TOKEN }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t2.promptId, sourceToolAssistantUUID: read.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxT200', content: 'export async function refresh_token() {}' }] }, toolUseResult: { type: 'text', file: { filePath: TOKEN, content: 'export async function refresh_token() {}', numLines: 40, startLine: 1, totalLines: 40 } } });
  push({ type: 'system', subtype: 'turn_duration', durationMs: 90000, messageCount: 3, isMeta: false });

  // A 25-minute turn against a 60s/90s median — outsized by any threshold.
  const t3 = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Ship it' } });
  const badBash = push({ type: 'assistant', requestId: 'req_fxT300', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxT300', name: 'Bash', input: { command: 'npm run build', description: 'Build the bundle' }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t3.promptId, sourceToolAssistantUUID: badBash.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxT300', content: 'error TS2304: Cannot find name refresh_token', is_error: true }] }, toolUseResult: 'Error: Exit code 2' });
  push({ type: 'assistant', requestId: 'req_fxT301', message: assistantMsg('claude-fable-5', { type: 'text', text: 'The build still fails on the renamed export.' }, 'end_turn', 70) });
  push({ type: 'system', subtype: 'turn_duration', durationMs: 1500000, messageCount: 4, isMeta: false });

  await writeFile(join(PROJ, `${S4}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

await main();
