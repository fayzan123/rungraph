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
const S6 = '66666666-6666-4666-8666-666666666666'; // lightly drifted — the coverage QUIET trigger
const S7 = '77777777-7777-4777-8777-777777777777'; // heavily drifted — the coverage LOUD trigger
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
  // The same type the clean run recognizes, but POPULATED — the shape gate
  // must let this one fall through to unrecognized, because the day the field
  // carries content is the day swallowing it silently would manufacture a
  // blind spot and still report 100% coverage.
  L.push({ type: 'atis-latch', atis: 'a payload nobody has ever seen', sessionId: S1 });
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
  await driftSessions();
  await codexFixtures();
  await hermesFixtures();
  await opencodeFixtures();

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
 * Hermes fixtures, modeled 1:1 on the real `~/.hermes/state.db` format
 * (probed live 2026-08-18, Hermes Agent v0.20.1, schema v26): one SQLite DB
 * per profile, epoch-seconds REAL timestamps, OpenAI-style `tool_calls`
 * JSON on assistant rows, `role='tool'` results pairing by `tool_call_id`,
 * `{output, exit_code, error}` terminal payloads, approval denials written
 * into results, and delegation recorded as `parent_session_id` +
 * `delegate_task` results + `[ASYNC DELEGATION BATCH COMPLETE — deleg_<id>]`
 * delivery messages.
 *
 * The `.db` files are COMMITTED, same lifecycle as the JSONL fixtures:
 * regenerated only when the corpus changes, never hand-edited. Regeneration
 * requires Node ≥ 22.13 (node:sqlite) — the guard below makes that a named
 * skip, not a crash, elsewhere.
 *
 * cwd values deliberately use `/home/dev`, which must NOT exist on dev or CI
 * machines: the Hermes project rule's tier 2 stats the cwd, and an existing
 * one would flip fixture runs out of the `✦ Hermes tasks` bucket and break
 * the detect snapshot. (Tier 2 itself is covered by a test that builds a
 * temp DB pointing at a real directory.)
 */
async function hermesFixtures() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.error('skipping hermes fixtures: node:sqlite unavailable (regeneration needs Node 22.13+)');
    return;
  }
  const HERMES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'hermes');
  await rm(HERMES_ROOT, { recursive: true, force: true });
  await mkdir(join(HERMES_ROOT, 'profiles', 'legacy'), { recursive: true });

  // Deterministic epoch-seconds clock — same discipline as the JSONL clocks.
  let sec = Date.parse('2026-08-01T12:00:00Z') / 1000;
  const t = (step = 2) => (sec += step);

  const H_CLEAN = '20260801_120000_c1ea01';
  const H_TROUBLE = '20260801_121500_780b1e';
  const H_DELEG = '20260801_123000_de1e60';
  const H_CHILD_A = '20260801_123001_c41d01';
  const H_CHILD_B = '20260801_123002_c41d02';
  const H_EMPTY = '20260801_124500_e30071';
  const H_REPO = '20260801_125000_9e0666';
  const H_GATEWAY = '20260801_125500_6a7e3a';
  const H_LEGACY = '20260701_090000_1e64c1';

  const db = new DatabaseSync(join(HERMES_ROOT, 'state.db'));
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT,
      parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
      end_reason TEXT, message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, estimated_cost_usd REAL, title TEXT,
      cwd TEXT, rewind_count INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT, git_repo_root TEXT,
      profile_name TEXT, last_activity_at REAL, hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT,
      tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER,
      finish_reason TEXT, reasoning_content TEXT,
      active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
      display_kind TEXT, display_metadata TEXT
    );
    CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
    CREATE INDEX idx_messages_session_id ON messages(session_id, id);
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(26);

  const addSession = db.prepare(
    `INSERT INTO sessions (id, source, model, parent_session_id, started_at, ended_at, end_reason,
       message_count, tool_call_count, input_tokens, output_tokens, estimated_cost_usd, title, cwd,
       git_branch, git_repo_root, last_activity_at, archived, hidden)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const addMsg = db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name,
       timestamp, token_count, finish_reason, active, display_kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const msg = (sessionId, row) =>
    addMsg.run(
      sessionId,
      row.role,
      row.content ?? null,
      row.toolCallId ?? null,
      row.toolCalls ? JSON.stringify(row.toolCalls) : null,
      row.toolName ?? null,
      row.ts ?? t(),
      row.tokens ?? null,
      row.finish ?? null,
      row.active ?? 1,
      row.displayKind ?? null,
    );
  const call = (id, name, args) => ({
    id,
    call_id: id,
    response_item_id: `fc_${id}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });

  // ---------- clean run: zero signals (the Hermes precision guard) ----------
  {
    const started = t();
    msg(H_CLEAN, { role: 'user', content: 'Draft the launch checklist for the beta', ts: started });
    msg(H_CLEAN, {
      role: 'assistant',
      content: 'Checking what the repo already has before drafting.',
      toolCalls: [call('call_hc01', 'terminal', { command: 'ls docs/' })],
      finish: 'tool_calls',
      tokens: 120,
    });
    msg(H_CLEAN, {
      role: 'tool',
      toolCallId: 'call_hc01',
      toolName: 'terminal',
      content: JSON.stringify({ output: 'GUIDE.md\nlaunch.md', exit_code: 0, error: null }),
    });
    msg(H_CLEAN, {
      role: 'assistant',
      toolCalls: [call('call_hc02', 'read_file', { path: '/home/dev/notes/launch.md' })],
      finish: 'tool_calls',
    });
    msg(H_CLEAN, {
      role: 'tool',
      toolCallId: 'call_hc02',
      toolName: 'read_file',
      content: JSON.stringify({ content: '1|# Launch\n2|- announce' }),
    });
    msg(H_CLEAN, {
      role: 'assistant',
      content: 'Checklist drafted: announce, docs pass, tag the release.',
      finish: 'stop',
      tokens: 80,
    });
    msg(H_CLEAN, { role: 'user', content: 'Looks good, save it' });
    msg(H_CLEAN, {
      role: 'assistant',
      toolCalls: [call('call_hc03', 'write_file', { path: '/home/dev/notes/launch.md', content: '# Launch\n- announce\n- docs\n- tag' })],
      finish: 'tool_calls',
    });
    msg(H_CLEAN, {
      role: 'tool',
      toolCallId: 'call_hc03',
      toolName: 'write_file',
      content: JSON.stringify({ success: true, path: '/home/dev/notes/launch.md' }),
    });
    msg(H_CLEAN, { role: 'assistant', content: 'Saved.', finish: 'stop', tokens: 40 });
    const ended = t();
    addSession.run(H_CLEAN, 'cli', 'deepseek-v4-flash', null, started, ended, 'cli_close', 10, 3, 4200, 900, 0.0021, 'Draft the launch checklist', '/home/dev', null, null, ended, 0, 0);
  }

  // ---------- trouble run: one of every intervention-adjacent shape ----------
  // retry storm (terminal ×3, every call exit 1), a clarify answer, a
  // "denied by user" result, and an unresolved patch error at EOF — plus one
  // unknown role and one unknown display_kind (skip + count), a hidden row
  // (skip, NOT counted), a model_switch row, and one inactive (rewound) row.
  {
    const started = t();
    msg(H_TROUBLE, { role: 'user', content: 'Wire the deploy script into CI', ts: started });
    msg(H_TROUBLE, {
      role: 'assistant',
      content: 'Running the deploy dry-run to see where it stands.',
      toolCalls: [
        call('call_ht01', 'terminal', { command: 'npm run deploy -- --dry-run' }),
        call('call_ht02', 'terminal', { command: 'npm run deploy -- --dry-run --verbose' }),
        call('call_ht03', 'terminal', { command: 'npm run deploy -- --dry-run --legacy' }),
      ],
      finish: 'tool_calls',
    });
    for (const id of ['call_ht01', 'call_ht02', 'call_ht03']) {
      msg(H_TROUBLE, {
        role: 'tool',
        toolCallId: id,
        toolName: 'terminal',
        content: JSON.stringify({ output: 'deploy.sh: missing CI_TOKEN', exit_code: 1, error: null }),
      });
    }
    // The clarify sits between the storm and the next terminal group — a
    // fourth consecutive terminal call would otherwise collapse INTO the
    // storm node and dissolve it.
    msg(H_TROUBLE, {
      role: 'assistant',
      toolCalls: [call('call_ht05', 'clarify', { question: 'Which CI provider should the deploy target?', choices: ['GitHub Actions', 'Buildkite'] })],
      finish: 'tool_calls',
    });
    msg(H_TROUBLE, {
      role: 'tool',
      toolCallId: 'call_ht05',
      toolName: 'clarify',
      content: JSON.stringify({
        question: 'Which CI provider should the deploy target?',
        choices_offered: ['GitHub Actions', 'Buildkite'],
        user_response: 'GitHub Actions',
      }),
    });
    // Advisory suffix after the JSON — the salvage path must tolerate it.
    msg(H_TROUBLE, {
      role: 'assistant',
      toolCalls: [call('call_ht04', 'terminal', { command: 'cat .ci/config.yml' })],
      finish: 'tool_calls',
    });
    msg(H_TROUBLE, {
      role: 'tool',
      toolCallId: 'call_ht04',
      toolName: 'terminal',
      content:
        JSON.stringify({ output: 'token: $CI_TOKEN', exit_code: 0, error: null }) +
        '\n\n[Tool loop warning: same_tool_failure_warning; count=3]',
    });
    msg(H_TROUBLE, {
      role: 'assistant',
      toolCalls: [call('call_ht06', 'terminal', { command: 'gh secret set CI_TOKEN' })],
      finish: 'tool_calls',
    });
    msg(H_TROUBLE, {
      role: 'tool',
      toolCallId: 'call_ht06',
      toolName: 'terminal',
      content: JSON.stringify({
        output: '',
        exit_code: -1,
        error: 'BLOCKED: Action denied by user. The user has NOT consented to this action. Do NOT retry this command.',
      }),
    });
    msg(H_TROUBLE, {
      role: 'assistant',
      toolCalls: [call('call_ht07', 'patch', { path: '/home/dev/ci/deploy.sh', mode: 'replace', old_string: 'exit 1', new_string: 'exit 0' })],
      finish: 'tool_calls',
    });
    msg(H_TROUBLE, {
      role: 'tool',
      toolCallId: 'call_ht07',
      toolName: 'patch',
      content: JSON.stringify({ success: false, error: 'Could not find a match for old_string in the file' }),
    });
    msg(H_TROUBLE, { role: 'assistant', content: 'Blocked on the token secret — stopping here.', finish: 'stop' });
    // Format-drift rows the grammar must skip + count …
    msg(H_TROUBLE, { role: 'system', content: 'a role this grammar does not know' });
    msg(H_TROUBLE, { role: 'user', content: 'from the future', displayKind: 'holo_recap' });
    // … a hidden row (skipped, NOT counted), a model switch, a rewound row.
    msg(H_TROUBLE, { role: 'user', content: 'internal bookkeeping', displayKind: 'hidden' });
    msg(H_TROUBLE, { role: 'user', content: 'Switched model to deepseek-v4-pro', displayKind: 'model_switch' });
    msg(H_TROUBLE, { role: 'user', content: 'an abandoned rewound branch prompt', active: 0 });
    const ended = t();
    addSession.run(H_TROUBLE, 'cli', 'deepseek-v4-flash', null, started, ended, 'cli_close', 17, 7, 9800, 2100, 0.0058, 'Wire the deploy script into CI', '/home/dev', null, null, ended, 0, 0);
  }

  // ---------- delegation run: two parallel subagents, delivery, live tail ----
  {
    const started = t();
    msg(H_DELEG, { role: 'user', content: 'Research both frameworks and compare them', ts: started });
    msg(H_DELEG, {
      role: 'assistant',
      content: 'Fanning this out to two research subagents.',
      toolCalls: [call('call_hd01', 'delegate_task', { goal: 'Research framework A performance', context: 'Focus on benchmarks' })],
      finish: 'tool_calls',
    });
    msg(H_DELEG, {
      role: 'tool',
      toolCallId: 'call_hd01',
      toolName: 'delegate_task',
      content: JSON.stringify({
        status: 'dispatched',
        mode: 'background',
        count: 2,
        delegation_id: 'deleg_fx0001',
        goals: ['Research framework A performance', 'Research framework B ecosystem'],
        note: 'Subagents are running in the background.',
      }),
    });
    // Agent-initiated continuation — folded into the flow, never a turn.
    msg(H_DELEG, { role: 'user', content: '[auto-continue]', displayKind: 'auto_continue' });
    msg(H_DELEG, {
      role: 'user',
      content:
        '[ASYNC DELEGATION BATCH COMPLETE — deleg_fx0001]\n' +
        'A background fan-out of 2 subagent(s) you dispatched earlier has finished.\n\n' +
        '--- ✓ TASK 1/2: Research framework A performance\nFramework A wins on cold-start latency.\n\n' +
        '--- ✓ TASK 2/2: Research framework B ecosystem\nFramework B has the larger plugin ecosystem.',
    });
    msg(H_DELEG, {
      role: 'assistant',
      content: 'Both reports are in: A is faster, B has the ecosystem.',
      finish: 'stop',
    });
    msg(H_DELEG, {
      role: 'assistant',
      content: 'Writing the comparison up now.',
      toolCalls: [call('call_hd02', 'write_file', { path: '/home/dev/notes/comparison.md', content: '# A vs B' })],
      finish: 'tool_calls',
    });
    // No result row for call_hd02 and ended_at NULL: the live-tail shape —
    // this exact call must parse as status 'running'.
    const lastActivity = t();
    addSession.run(H_DELEG, 'cli', 'deepseek-v4-flash', null, started, null, null, 8, 2, 15000, 3200, 0.011, 'Compare the two frameworks', '/home/dev', null, null, lastActivity, 0, 0);

    const aStart = started + 4;
    msg(H_CHILD_A, { role: 'user', content: 'Research framework A performance', ts: aStart });
    msg(H_CHILD_A, {
      role: 'assistant',
      toolCalls: [call('call_hda1', 'terminal', { command: 'ab -n 100 http://localhost:3000/' })],
      finish: 'tool_calls',
      ts: aStart + 2,
    });
    msg(H_CHILD_A, {
      role: 'tool',
      toolCallId: 'call_hda1',
      toolName: 'terminal',
      content: JSON.stringify({ output: 'Requests per second: 4200', exit_code: 0, error: null }),
      ts: aStart + 4,
    });
    msg(H_CHILD_A, { role: 'assistant', content: 'Framework A wins on cold-start latency.', finish: 'stop', ts: aStart + 6 });
    addSession.run(H_CHILD_A, 'subagent', 'deepseek-v4-pro', H_DELEG, aStart, aStart + 8, 'agent_close', 4, 1, 5000, 400, 0.003, null, null, null, null, aStart + 8, 0, 0);

    const bStart = started + 5;
    msg(H_CHILD_B, { role: 'user', content: 'Research framework B ecosystem', ts: bStart });
    msg(H_CHILD_B, {
      role: 'assistant',
      toolCalls: [call('call_hdb1', 'read_file', { path: '/home/dev/notes/plugins.md' })],
      finish: 'tool_calls',
      ts: bStart + 2,
    });
    msg(H_CHILD_B, {
      role: 'tool',
      toolCallId: 'call_hdb1',
      toolName: 'read_file',
      content: JSON.stringify({ content: '1|# Plugins\n2|- 300 entries' }),
      ts: bStart + 4,
    });
    msg(H_CHILD_B, { role: 'assistant', content: 'Framework B has the larger plugin ecosystem.', finish: 'stop', ts: bStart + 6 });
    addSession.run(H_CHILD_B, 'subagent', 'deepseek-v4-pro', H_DELEG, bStart, bStart + 8, 'agent_close', 4, 1, 3000, 250, 0.002, null, null, null, null, bStart + 8, 0, 0);
  }

  // ---------- empty session: no messages at all — title falls to the id ----
  {
    const started = t();
    addSession.run(H_EMPTY, 'cli', 'deepseek-v4-flash', null, started, started + 1, 'cli_close', 0, 0, 0, 0, 0, null, '/home/dev', null, null, started + 1, 0, 0);
  }

  // ---------- repo run: git_repo_root groups it with the acme fixtures ------
  {
    const started = t();
    msg(H_REPO, { role: 'user', content: 'Add a deploy script to the acme repo', ts: started });
    msg(H_REPO, {
      role: 'assistant',
      toolCalls: [call('call_hr01', 'search_files', { pattern: 'deploy', path: '/home/dev/acme/scripts/deploy.sh', target: 'files' })],
      finish: 'tool_calls',
    });
    msg(H_REPO, {
      role: 'tool',
      toolCallId: 'call_hr01',
      toolName: 'search_files',
      content: JSON.stringify({ total_count: 1, files: ['/home/dev/acme/scripts/deploy.sh'] }),
    });
    msg(H_REPO, {
      role: 'assistant',
      toolCalls: [call('call_hr02', 'write_file', { path: '/home/dev/acme/scripts/deploy.sh', content: '#!/bin/sh\necho deploy' })],
      finish: 'tool_calls',
    });
    msg(H_REPO, {
      role: 'tool',
      toolCallId: 'call_hr02',
      toolName: 'write_file',
      content: JSON.stringify({ success: true, path: '/home/dev/acme/scripts/deploy.sh' }),
    });
    msg(H_REPO, { role: 'assistant', content: 'Deploy script added.', finish: 'stop' });
    const ended = t();
    addSession.run(H_REPO, 'cli', 'deepseek-v4-flash', null, started, ended, 'cli_close', 6, 2, 3100, 700, 0.0018, 'Add a deploy script', '/home/dev/acme', 'main', '/home/dev/acme', ended, 0, 0);
  }

  // ---------- gateway session: view-only, resume must gate it out ----------
  {
    const started = t();
    msg(H_GATEWAY, { role: 'user', content: 'Remind me what shipped this week', ts: started });
    msg(H_GATEWAY, { role: 'assistant', content: 'The beta checklist and the deploy script.', finish: 'stop' });
    const ended = t();
    addSession.run(H_GATEWAY, 'telegram', 'deepseek-v4-flash', null, started, ended, 'cli_close', 2, 0, 900, 120, 0.0004, 'Weekly recap over Telegram', null, null, null, ended, 0, 0);
  }

  // ---------- archived + hidden: shown-but-marked vs skipped ----------------
  {
    const started = t();
    addSession.run('20260801_130000_a2c41d', 'cli', 'deepseek-v4-flash', null, started, started + 2, 'cli_close', 0, 0, 10, 5, 0.0001, 'An archived task', '/home/dev', null, null, started + 2, 1, 0);
    addSession.run('20260801_130500_41dde0', 'cli', 'deepseek-v4-flash', null, started + 10, started + 12, 'cli_close', 0, 0, 10, 5, 0.0001, 'A hidden task', '/home/dev', null, null, started + 12, 0, 1);
  }

  db.close();

  // ---------- profiles/legacy/state.db: an older, narrower schema ----------
  // Missing cwd/git/last_activity_at/hidden on sessions and display_kind/
  // token_count/active on messages — every read must degrade field-by-field.
  const old = new DatabaseSync(join(HERMES_ROOT, 'profiles', 'legacy', 'state.db'));
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT,
      parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
      end_reason TEXT, message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT,
      tool_name TEXT, timestamp REAL NOT NULL
    );
  `);
  const oldSession = old.prepare(
    'INSERT INTO sessions (id, source, model, started_at, ended_at, end_reason, message_count, tool_call_count, input_tokens, output_tokens, title) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  );
  const oldMsg = old.prepare(
    'INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp) VALUES (?,?,?,?,?,?,?)',
  );
  {
    const started = t();
    oldMsg.run(H_LEGACY, 'user', 'Check the backup cron still runs', null, null, null, started);
    oldMsg.run(
      H_LEGACY,
      'assistant',
      '',
      null,
      JSON.stringify([call('call_hl01', 'terminal', { command: 'crontab -l' })]),
      null,
      t(),
    );
    oldMsg.run(
      H_LEGACY,
      'tool',
      JSON.stringify({ output: '0 3 * * * backup.sh', exit_code: 0, error: null }),
      'call_hl01',
      null,
      'terminal',
      t(),
    );
    const ended = t();
    oldSession.run(H_LEGACY, 'cli', 'deepseek-v3', started, ended, 'cli_close', 3, 1, 800, 90, 'Check the backup cron');
  }
  old.close();
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
  // `atis-latch` in the shape all 220 corpus samples had: contentless. The
  // clean run is the coverage precision guard — it must stay at 100% read, so
  // this line proves the type is recognized BY SHAPE and not merely skipped.
  L.push({ type: 'atis-latch', atis: '', sessionId: S3 });

  await writeFile(join(PROJ, `${S3}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/**
 * Sessions 6 and 7 — the COVERAGE corpus, the same way S3/S4 are the signals
 * corpus. Both derive zero signals on purpose: the coverage triggers exist for
 * exactly the moment the UI would otherwise imply completeness, so a fixture
 * that also has chips would test the wrong thing.
 *
 * S6 is the drift that actually happened: one unknown metadata type, a few
 * percent of the transcript, nothing missing from the graph → QUIET.
 * S7 is the drift the loud trigger exists for: the assistant records themselves
 * gone unreadable, so most of the run is simply not there → LOUD.
 */
async function driftSessions() {
  // ---------- S6: light drift, quiet ----------
  const L = [];
  const push = (extra) => {
    const l = envelope(S6, L.at(-1)?.uuid ?? null, extra);
    L.push(l);
    return l;
  };
  L.push({ type: 'mode', mode: 'normal', sessionId: S6 });
  L.push({ type: 'ai-title', aiTitle: 'Bump version to 0.3.1', sessionId: S6 });
  // Four ordinary edit turns — enough real records that one unreadable line is
  // a FEW PERCENT of the run, which is the drift that actually happened.
  const files = ['package.json', 'CHANGELOG.md', 'README.md', 'docs/GUIDE.md'];
  files.forEach((file, i) => {
    const t = push({ type: 'user', promptId: uuid(), message: { role: 'user', content: `Bump the version in ${file}` } });
    const call = push({ type: 'assistant', requestId: `req_fxD${i}0`, message: assistantMsg('claude-fable-5', { type: 'tool_use', id: `toolu_fxD${i}0`, name: 'Edit', input: { file_path: `${CWD}/${file}`, old_string: '0.3.0', new_string: '0.3.1' }, caller: { type: 'direct' } }, 'tool_use') });
    push({ type: 'user', promptId: t.promptId, sourceToolAssistantUUID: call.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_fxD${i}0`, content: `Edited ${file}` }] }, toolUseResult: { filePath: `${CWD}/${file}`, oldString: '0.3.0', newString: '0.3.1', originalFile: '', replaceAll: false, structuredPatch: [], userModified: false } });
    push({ type: 'assistant', requestId: `req_fxD${i}1`, message: assistantMsg('claude-fable-5', { type: 'text', text: `Bumped ${file} to 0.3.1.` }, 'end_turn', 40) });
    push({ type: 'system', subtype: 'turn_duration', durationMs: 22000, messageCount: 3, isMeta: false });
  });
  // The drift itself: ONE metadata type this rungraph does not know, of the
  // kind a newly-shipped CLI version starts emitting. Contentless as far as
  // anyone can tell — but nothing in the product could establish that, which
  // is the entire reason the quiet trigger exists.
  L.push({ type: 'flux-marker', flux: '', sessionId: S6 });
  await writeFile(join(PROJ, `${S6}.jsonl`), L.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // ---------- S7: heavy drift, loud ----------
  const H = [];
  const hpush = (extra) => {
    const l = envelope(S7, H.at(-1)?.uuid ?? null, extra);
    H.push(l);
    return l;
  };
  H.push({ type: 'mode', mode: 'normal', sessionId: S7 });
  const h1 = hpush({ type: 'user', promptId: uuid(), message: { role: 'user', content: 'Migrate the storage layer to the new client' } });
  H.push({ type: 'ai-title', aiTitle: 'Migrate storage layer', sessionId: S7 });
  const hread = hpush({ type: 'assistant', requestId: 'req_fxE001', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxE101', name: 'Read', input: { file_path: `${CWD}/src/storage/client.ts` }, caller: { type: 'direct' } }, 'tool_use') });
  hpush({ type: 'user', promptId: h1.promptId, sourceToolAssistantUUID: hread.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxE101', content: 'export class Client {}' }] }, toolUseResult: { type: 'text', file: { filePath: `${CWD}/src/storage/client.ts`, content: 'export class Client {}', numLines: 1, startLine: 1, totalLines: 1 } } });
  hpush({ type: 'assistant', requestId: 'req_fxE002', message: assistantMsg('claude-fable-5', { type: 'text', text: 'Read the client. Continuing.' }, 'end_turn', 40) });
  hpush({ type: 'system', subtype: 'turn_duration', durationMs: 31000, messageCount: 3, isMeta: false });
  // …and then the bulk of the run, in a shape this version cannot read at all.
  // This is the failure mode the rate gate is calibrated for: not a metadata
  // sprinkle, but the assistant turns themselves going missing.
  for (let i = 0; i < 26; i++) {
    H.push({ type: 'turn-capsule', capsule: `c${i}`, sessionId: S7, timestamp: ts() });
  }
  await writeFile(join(PROJ, `${S7}.jsonl`), H.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

/**
 * Session 5 — one of every secrets-scanner pattern kind, planted across the
 * five places outgoing text lives: the user's prompt, a tool output, a tool
 * input, file content read back, and a NODE LABEL. The label is the only one
 * of the five reachable without get_detail — find_nodes and get_graph return
 * labels — so it is the case that pins redaction to the MCP choke point
 * rather than to one tool. Every value is OBVIOUSLY synthetic
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

  // Bash with NO description: toolNodeLabel falls back to the command, so this
  // key rides in the node LABEL and reaches find_nodes/get_graph without anyone
  // calling get_detail. AWS is deliberate — toolNodeLabel truncates at 40 chars,
  // and a 20-char AKIA key is one of the few patterns short enough to survive
  // intact. Longer ones (a Bearer sk-ant-… header) get cut mid-key and no longer
  // match, which is precisely why this narrow case needs pinning: it is easy to
  // assume labels are safe because most secrets do not fit in one.
  const hunt = push({ type: 'assistant', requestId: 'req_fxS005', message: assistantMsg('claude-fable-5', { type: 'tool_use', id: 'toolu_fxS005', name: 'Bash', input: { command: `grep -r AKIA${F4.repeat(4)} .` }, caller: { type: 'direct' } }, 'tool_use') });
  push({ type: 'user', promptId: t1.promptId, sourceToolAssistantUUID: hunt.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fxS005', content: 'src/legacy/deploy.sh:3' }] }, toolUseResult: { stdout: 'src/legacy/deploy.sh:3', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } });

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

/**
 * opencode fixtures, modeled 1:1 on the real
 * `~/.local/share/opencode/opencode.db` format (probed live 2026-08-20
 * against a corpus spanning opencode 1.15.6 → 1.18.19): ONE global SQLite
 * database with `project` / `session` / `message` / `part` tables, epoch-
 * MILLISECOND timestamps, JSON `data` blobs on messages and parts, subagent
 * sessions carrying `parent_id`, and `task` tool parts naming their child
 * session outright in `state.metadata.sessionId`.
 *
 * The `.db` file is COMMITTED, same lifecycle as the JSONL fixtures:
 * regenerated only when the corpus changes, never hand-edited. Regeneration
 * requires Node ≥ 22.13 (node:sqlite) — the guard below makes that a named
 * skip, not a crash, elsewhere.
 *
 * Deliberate shapes worth knowing before editing:
 * - Session ids are NOT in time order. Real opencode ids sort DESCENDING with
 *   time while message and part ids sort ascending, so the fixture ids are
 *   scrambled on purpose: any ordering that reads ids instead of
 *   `time_created` fails on this corpus.
 * - Worktrees use `/home/dev/…`, which must NOT exist on dev or CI machines,
 *   exactly as the Hermes fixtures do.
 * - `session.time_created` sits ~30ms BEFORE the session's first message on
 *   every genuine run (the row is written just before the message). Only the
 *   fork inverts that, which is what `copiedHistory` detects.
 */
async function opencodeFixtures() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    console.error('skipping opencode fixtures: node:sqlite unavailable (regeneration needs Node 22.13+)');
    return;
  }
  const OC_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'opencode');
  await rm(OC_ROOT, { recursive: true, force: true });
  await mkdir(OC_ROOT, { recursive: true });

  const db = new DatabaseSync(join(OC_ROOT, 'opencode.db'));
  // The 1.18.19 shape, including the columns 1.15.x did not have
  // (`workspace_id`, `path`, `agent`, `model`, `cost`, the five `tokens_*`,
  // and `metadata`). The narrower 1.15.x schema is covered by a temp DB in
  // tests/opencode.test.js — one committed fixture cannot hold two schemas.
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT,
      icon_url TEXT, icon_color TEXT, time_created INTEGER, time_updated INTEGER,
      time_initialized INTEGER, sandboxes TEXT, commands TEXT, icon_url_override TEXT
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT,
      directory TEXT, title TEXT, version TEXT, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
      summary_diffs INTEGER, revert TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER, time_compacting INTEGER,
      time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, metadata TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT, data TEXT
    );
    CREATE INDEX idx_part_session ON part(session_id);
    CREATE INDEX idx_part_message ON part(message_id, id);
    CREATE INDEX idx_message_session ON message(session_id, time_created, id);
    CREATE INDEX idx_session_project ON session(project_id);
    CREATE INDEX idx_session_parent ON session(parent_id);
  `);
  // The transient table exists and is deliberately POPULATED: the adapter
  // must issue no query against it, and a fixture that left it empty could
  // not tell "not read" from "nothing to read".
  db.prepare('INSERT INTO session_message (id, session_id, type, data) VALUES (?,?,?,?)').run(
    'smsg_fx000001', 'ses_fx9000000000000000clean', 'agent-switched', '{"agent":"plan"}',
  );

  const ACME = '/home/dev/acme';
  const NOTES = '/home/dev/notes';
  const insProject = db.prepare(
    'INSERT INTO project (id, worktree, vcs, name, time_created, time_updated) VALUES (?,?,?,?,?,?)',
  );
  const insSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, directory, title, version, revert,
       time_created, time_updated, time_archived, agent, model, cost,
       tokens_input, tokens_output, tokens_cache_read, tokens_cache_write)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)',
  );
  const insPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)',
  );

  // Deterministic epoch-MILLISECOND clock — opencode's unit.
  let clockMs = Date.parse('2026-08-01T12:00:00Z');
  const t = (step = 2000) => (clockMs += step);
  let msgN = 0;
  let prtN = 0;
  const mid = () => `msg_fx${String(++msgN).padStart(8, '0')}`;
  const pid = () => `prt_fx${String(++prtN).padStart(8, '0')}`;
  const MODEL = { id: 'nemotron-3.5-lightning-free', providerID: 'opencode', variant: 'default' };

  insProject.run('prj_fxacme', ACME, 'git', 'acme', clockMs, clockMs);
  insProject.run('prj_fxnotes', NOTES, 'git', 'notes', clockMs, clockMs);

  /** One `part` row. */
  const part = (sid, messageId, data, at = t(200)) => {
    const id = pid();
    insPart.run(id, messageId, sid, at, at, JSON.stringify(data));
    return id;
  };
  /** A `role='user'` message plus its text part — a turn. */
  const userMsg = (sid, text, over = {}) => {
    const id = over.id ?? mid();
    const at = over.at ?? t();
    insMessage.run(id, sid, at, at, JSON.stringify({
      role: 'user',
      time: { created: at },
      agent: over.agent ?? 'build',
      model: { providerID: MODEL.providerID, modelID: MODEL.id, variant: MODEL.variant },
      summary: { diffs: 0 },
    }));
    if (typeof text === 'string') part(sid, id, { type: 'text', text }, at + 10);
    return id;
  };
  /**
   * A `role='assistant'` message — a STEP, not a turn. `tokens.input` is the
   * UNCACHED delta; true context is input + cache.read + cache.write, which
   * is what the adapter must take a per-turn MAX of.
   */
  const assistantMsg = (sid, parentID, over = {}) => {
    const id = over.id ?? mid();
    const at = over.at ?? t();
    // `tokensRaw` writes the block verbatim — the only way to produce a
    // `tokens` object with NO `input` key, which is the shape the drift
    // assertion exists for.
    const tokens = over.tokensRaw !== undefined
      ? over.tokensRaw
      : {
          total: 0,
          input: over.input ?? 500,
          output: over.output ?? 50,
          reasoning: 0,
          cache: { write: over.cacheWrite ?? 0, read: over.cacheRead ?? 0 },
        };
    const data = {
      parentID,
      role: 'assistant',
      mode: over.agent ?? 'build',
      agent: over.agent ?? 'build',
      variant: 'default',
      path: { cwd: over.cwd ?? ACME, root: over.cwd ?? ACME },
      cost: 0,
      ...(tokens ? { tokens } : {}),
      modelID: MODEL.id,
      providerID: MODEL.providerID,
      time: { created: at, completed: at + 800 },
      // An aborted message carries an `error` key and NO `finish` at all —
      // the exact shape a deliberate Esc produced on 1.18.19.
      ...(over.error ? { error: over.error } : { finish: over.finish === undefined ? 'stop' : over.finish }),
    };
    insMessage.run(id, sid, at, at, JSON.stringify(data));
    return id;
  };
  /** step-start / step-finish, one pair per uninterrupted assistant message. */
  const stepStart = (sid, m) => part(sid, m, { type: 'step-start' }, t(30));
  const stepFinish = (sid, m, reason = 'stop') =>
    part(sid, m, { type: 'step-finish', reason, snapshot: 'a1b2c3d4e5f6', tokens: {}, cost: 0 }, t(30));
  /** One `tool` part. `title` absent → the label derives from the input. */
  let callN = 0;
  const toolPart = (sid, m, tool, input, over = {}) => {
    const start = t(300);
    const state = over.error !== undefined
      // The error shape has NO title, output or metadata — measured, not assumed.
      ? { status: 'error', input, error: over.error, time: { start, end: start + 200 } }
      : {
          status: over.status ?? 'completed',
          input,
          output: over.output ?? 'ok',
          metadata: { truncated: false, ...over.metadata },
          ...(over.title !== undefined ? { title: over.title } : {}),
          time: { start, end: start + 200 },
        };
    return part(sid, m, { type: 'tool', tool, callID: `call_fx${String(++callN).padStart(6, '0')}`, state }, start);
  };
  const session = (id, over = {}) => {
    const created = over.created ?? clockMs;
    insSession.run(
      id,
      over.projectId ?? 'prj_fxacme',
      over.parent ?? null,
      over.directory ?? ACME,
      over.title ?? null,
      over.version ?? '1.18.19',
      over.revert ?? null,
      created,
      over.updated ?? clockMs,
      over.archived ?? null,
      over.agent === undefined ? 'build' : over.agent,
      over.model === undefined ? JSON.stringify(MODEL) : over.model,
      over.cost ?? 0.0042,
      over.tokensInput ?? 0,
      over.tokensOutput ?? 0,
      over.cacheRead ?? 0,
      over.cacheWrite ?? 0,
    );
  };

  // ---------- clean: zero signals, zero unread, and the MAX-vs-SUM turn ----
  {
    const S = 'ses_fx9000000000000000clean';
    const first = t();
    const u1 = userMsg(S, 'Add a CHANGELOG entry for the 0.2 release', { at: first });
    // Six steps whose TRUE context climbs 8k → 13k while raw input is noise.
    // SUM(context) is 63,000 and MAX is 13,000 — a 4.85× gap. A parser that
    // summed would report 63k here, which is both wrong and enough to trip
    // the outlier floor on an entirely ordinary turn.
    const steps = [
      { input: 8000, cacheRead: 0 },
      { input: 1000, cacheRead: 8000 },
      { input: 1200, cacheRead: 8800 },
      { input: 1000, cacheRead: 10000 },
      { input: 900, cacheRead: 11100 },
      { input: 800, cacheRead: 12200 },
    ];
    steps.forEach((tok, i) => {
      const a = assistantMsg(S, u1, { ...tok, output: 50, finish: i === steps.length - 1 ? 'stop' : 'tool-calls' });
      stepStart(S, a);
      if (i === 0) part(S, a, { type: 'reasoning', text: 'Read the changelog first.', time: { start: clockMs, end: clockMs } }, t(30));
      if (i === 0) part(S, a, { type: 'text', text: 'Checking what the changelog already has.' }, t(30));
      // `title` present on this one: opencode writes it on ~98% of tool parts
      // and it is the label SUBJECT wherever it is non-empty.
      if (i === 1) toolPart(S, a, 'read', { filePath: `${ACME}/CHANGELOG.md` }, { title: 'CHANGELOG.md', output: '# Changelog\n\n## 0.1.2' });
      if (i === 3) {
        toolPart(S, a, 'edit', { filePath: `${ACME}/CHANGELOG.md`, oldString: '## 0.1.2', newString: '## 0.2.0\n\n## 0.1.2' }, { output: 'ok' });
        part(S, a, { type: 'patch', hash: 'f00dcafe', files: [`${ACME}/CHANGELOG.md`] }, t(30));
      }
      if (i === steps.length - 1) part(S, a, { type: 'text', text: 'Added the 0.2.0 heading above 0.1.2.' }, t(30));
      stepFinish(S, a, i === steps.length - 1 ? 'stop' : 'tool-calls');
    });
    const u2 = userMsg(S, 'Now run the tests');
    const a2 = assistantMsg(S, u2, { input: 3000, cacheRead: 0, output: 40 });
    stepStart(S, a2);
    toolPart(S, a2, 'bash', { command: 'npm test', description: 'Run the suite' }, { output: '31 passed' });
    part(S, a2, { type: 'text', text: 'All 31 tests pass.' }, t(30));
    stepFinish(S, a2);
    session(S, { created: first - 30, updated: t(), title: 'Add a CHANGELOG entry', version: '1.18.19', tokensInput: 12900, tokensOutput: 340, cacheRead: 50100 });
  }

  // ---------- batch: 14 reads, 5 errors, on DIFFERENT paths -----------------
  // The node-status invariant's regression guard. Every one of the five misses
  // is a different non-existent file — the model probing a namespace, retrying
  // nothing — so the node is `completed` and fires no retry-storm. Under the
  // naive reading ("any error makes the node an error") it would clear
  // retryErrors: 3 and report a storm that did not happen.
  {
    const S = 'ses_fxd0000000000000batch';
    const first = t();
    const u = userMsg(S, 'Read every component stylesheet', { at: first });
    const a = assistantMsg(S, u, { input: 4000, cacheRead: 1000, output: 60 });
    stepStart(S, a);
    for (let i = 1; i <= 9; i++) {
      toolPart(S, a, 'read', { filePath: `${ACME}/client/src/components/Comp${i}.tsx` }, { output: 'export default …' });
    }
    for (const name of ['WorkflowNode', 'NodePanel', 'EdgePanel', 'SkillsPanel', 'DiscoverTab']) {
      toolPart(S, a, 'read', { filePath: `${ACME}/client/src/components/${name}.css` }, {
        error: `File not found: ${ACME}/client/src/components/${name}.css`,
      });
    }
    part(S, a, { type: 'text', text: 'Nine components have styles; five have none.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 28, updated: t(), title: 'Read component stylesheets' });
  }

  // ---------- trouble: one of every reachable high-severity signal ----------
  {
    const S = 'ses_fx8000000000000trouble';
    const first = t();
    // turn 1 — retry storm, an answered question, and a denial
    const u1 = userMsg(S, 'Wire the deploy script into CI', { at: first });
    const a1 = assistantMsg(S, u1, { input: 18000, cacheRead: 2000, output: 80, finish: 'tool-calls' });
    stepStart(S, a1);
    part(S, a1, { type: 'text', text: 'Patching the deploy script now.' }, t(30));
    for (let i = 0; i < 3; i++) {
      toolPart(S, a1, 'edit', { filePath: `${ACME}/ci/deploy.sh`, oldString: 'exit 1', newString: 'exit 0' }, {
        error: 'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.',
      });
    }
    toolPart(S, a1, 'question', {
      questions: [{
        question: 'Which CI provider should the deploy target?',
        header: 'CI provider',
        options: [{ label: 'GitHub Actions', description: 'Use Actions' }, { label: 'Buildkite', description: 'Use Buildkite' }],
      }],
    }, {
      output: 'User has answered your questions: "Which CI provider should the deploy target?"="GitHub Actions".',
      // The REAL shape: one array per question, holding the labels picked for
      // it. A flat filter over this yields '' and the chip reads "answered:"
      // with nothing after it.
      metadata: { answers: [['GitHub Actions']] },
    });
    toolPart(S, a1, 'read', { filePath: `${ACME}/.ci/config.yml` }, { output: 'token: $CI_TOKEN' });
    toolPart(S, a1, 'glob', { pattern: '**/*.pem' }, {
      error: 'The user rejected permission to use this specific tool call.',
    });
    stepFinish(S, a1, 'tool-calls');

    // turn 2 — the outlier, and the interrupt (after a websearch, so the
    // unresolved bash below is still the LAST bash in the lane)
    const u2 = userMsg(S, 'Ship it');
    const a2 = assistantMsg(S, u2, { input: 40000, cacheRead: 160000, output: 200, finish: 'tool-calls' });
    stepStart(S, a2);
    toolPart(S, a2, 'websearch', { query: 'github actions oidc deploy' }, { output: '3 results' });
    stepFinish(S, a2, 'tool-calls');
    const a2b = assistantMsg(S, u2, {
      input: 900, cacheRead: 200, output: 0,
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    });
    stepStart(S, a2b); // deliberately unmatched — no step-finish on an abort

    // turn 3 — small, so the run's median stays low enough for turn 2 to read
    // as outsized against it
    const u3 = userMsg(S, 'Never mind the search, just check the file');
    const a3 = assistantMsg(S, u3, { input: 14000, cacheRead: 1000, output: 40 });
    stepStart(S, a3);
    toolPart(S, a3, 'read', { filePath: `${ACME}/ci/deploy.sh` }, { output: '#!/bin/sh' });
    stepFinish(S, a3);

    // turn 4 — the unresolved trailing error
    const u4 = userMsg(S, 'Run the deploy dry-run');
    const a4 = assistantMsg(S, u4, { input: 11000, cacheRead: 1000, output: 30 });
    stepStart(S, a4);
    toolPart(S, a4, 'bash', { command: 'npm run deploy -- --dry-run', description: 'Deploy dry-run' }, {
      error: 'Command failed with exit code 1: deploy.sh: missing CI_TOKEN',
    });
    part(S, a4, { type: 'text', text: 'Blocked on the token secret — stopping here.' }, t(30));
    stepFinish(S, a4);
    session(S, { created: first - 33, updated: t(), title: 'Wire the deploy script into CI', tokensInput: 84800, tokensOutput: 350, cacheRead: 164200 });
  }

  // ---------- subagent: both reconciliation mismatches, in one run ---------
  {
    const S = 'ses_fx7000000000000000task';
    const CHILD = 'ses_fx7a00000000000child01';
    const ORPHAN = 'ses_fx7b00000000000child02';
    const MISSING = 'ses_fx7c00000000000missing';
    const first = t();
    const u = userMsg(S, 'Map the auth module, then fix the session bug', { at: first });
    const a = assistantMsg(S, u, { input: 9000, cacheRead: 1000, output: 90, finish: 'tool-calls' });
    stepStart(S, a);
    part(S, a, { type: 'text', text: 'Fanning this out to an explore subagent.' }, t(30));
    toolPart(S, a, 'task', { description: 'Explore project structure', prompt: 'Map src/auth and report each file.', subagent_type: 'explore' }, {
      output: `task_id: ${CHILD} (for resuming to continue this task if needed)\n\n<task_result>\ntoken.js owns refresh; session.ts:41 resets the TTL.\n</task_result>`,
      metadata: { truncated: false, sessionId: CHILD, parentSessionId: S, model: 'opencode/nemotron-3.5-lightning-free' },
    });
    // A task part naming a session row that no longer exists: `sourcesUnread`
    // +1 — a referenced source rungraph could not open AT ALL.
    toolPart(S, a, 'task', { description: 'Audit the token store', prompt: 'Audit src/auth/token.js.', subagent_type: 'explore' }, {
      output: `task_id: ${MISSING}`,
      metadata: { truncated: false, sessionId: MISSING, parentSessionId: S },
    });
    part(S, a, { type: 'text', text: 'The map is in — session.ts:41 is the bug.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 40, updated: t(), title: 'Map the auth module' });

    const cFirst = t();
    const cu = userMsg(CHILD, 'Map src/auth and report each file.', { at: cFirst, agent: 'explore' });
    const ca = assistantMsg(CHILD, cu, { agent: 'explore', input: 5000, cacheRead: 0, output: 120 });
    stepStart(CHILD, ca);
    toolPart(CHILD, ca, 'read', { filePath: `${ACME}/src/auth/token.js` }, { output: 'export function refresh() {}' });
    part(CHILD, ca, { type: 'text', text: 'token.js owns refresh; session.ts:41 resets the TTL.' }, t(30));
    stepFinish(CHILD, ca);
    session(CHILD, { created: cFirst - 8, updated: t(), parent: S, agent: 'explore', title: 'Explore project structure (@explore subagent)' });

    // A child with parent_id but NO surviving task part — compaction pruned
    // it. It still gets a lane, with a synthetic spawn edge, and NO coverage
    // penalty: the child itself was read completely.
    const oFirst = t();
    const ou = userMsg(ORPHAN, 'Check the redirect helper.', { at: oFirst, agent: 'explore' });
    const oa = assistantMsg(ORPHAN, ou, { agent: 'explore', input: 3000, cacheRead: 0, output: 60 });
    stepStart(ORPHAN, oa);
    toolPart(ORPHAN, oa, 'read', { filePath: `${ACME}/src/auth/redirect.ts` }, { output: 'export function go() {}' });
    part(ORPHAN, oa, { type: 'text', text: 'redirect.ts is sound.' }, t(30));
    stepFinish(ORPHAN, oa);
    session(ORPHAN, { created: oFirst - 9, updated: t(), parent: S, agent: 'explore', title: 'Check the redirect helper (@explore subagent)' });
  }

  // ---------- drift: quiet (one unknown type) and loud (most of the run) ---
  {
    const S = 'ses_fx6000000000000quiet0';
    const first = t();
    const bumped = ['package.json', 'CHANGELOG.md', 'README.md', 'docs/GUIDE.md'];
    for (const [i, file] of bumped.entries()) {
      const u = userMsg(S, `Bump the version in ${file}`, i === 0 ? { at: first } : {});
      const a = assistantMsg(S, u, { input: 2000, cacheRead: 500, output: 30 });
      stepStart(S, a);
      toolPart(S, a, 'edit', { filePath: `${ACME}/${file}`, oldString: '0.3.0', newString: '0.3.1' }, { output: 'ok' });
      part(S, a, { type: 'patch', hash: 'beefbeef', files: [`${ACME}/${file}`] }, t(30));
      part(S, a, { type: 'text', text: `Bumped ${file} to 0.3.1.` }, t(30));
      stepFinish(S, a);
    }
    // ONE part type this rungraph does not know, of the kind a newly-shipped
    // opencode version starts emitting. A few percent of the run, nothing
    // missing from the graph → the coverage QUIET trigger.
    const uq = userMsg(S, 'Anything else?');
    const aq = assistantMsg(S, uq, { input: 800, cacheRead: 200, output: 20 });
    stepStart(S, aq);
    part(S, aq, { type: 'flux-marker', flux: '' }, t(30));
    part(S, aq, { type: 'text', text: 'That is all four files.' }, t(30));
    stepFinish(S, aq);
    session(S, { created: first - 25, updated: t(), title: 'Bump version to 0.3.1' });
  }
  {
    const S = 'ses_fx5000000000000000loud';
    const first = t();
    const u = userMsg(S, 'Migrate the storage layer to the new client', { at: first });
    const a = assistantMsg(S, u, { input: 3000, cacheRead: 0, output: 40 });
    stepStart(S, a);
    toolPart(S, a, 'read', { filePath: `${ACME}/src/storage/client.ts` }, { output: 'export class Client {}' });
    // …and then the bulk of the run, in a shape this version cannot read at
    // all. Not a metadata sprinkle: the working records themselves are gone.
    for (let i = 0; i < 30; i++) {
      part(S, a, { type: 'turn-capsule', capsule: `c${i}` }, t(30));
    }
    session(S, { created: first - 31, updated: t(), title: 'Migrate storage layer' });
  }

  // ---------- truncation: preview only, and NO spill file ------------------
  // The only real case. opencode's `tool-output/` spill files do not survive
  // (two existed at 16:16 and the directory was empty afterwards while 58
  // truncated parts still referenced content), so the preview is the ceiling
  // and coverage must stay clean: rungraph did not fail to read anything.
  {
    const S = 'ses_fx4000000000000trunca';
    const first = t();
    const u = userMsg(S, 'Show me the whole build log', { at: first });
    const a = assistantMsg(S, u, { input: 6000, cacheRead: 1000, output: 40 });
    stepStart(S, a);
    toolPart(S, a, 'bash', { command: 'npm run build', description: 'Build the bundle' }, {
      output: '',
      metadata: { truncated: true, loaded: false, display: true, preview: '> build\n> vite build\n\ntransforming (1) index.html' },
    });
    toolPart(S, a, 'read', { filePath: `${ACME}/dist/bundle.js` }, {
      output: '',
      metadata: { truncated: true, loaded: false, preview: '(function(){"use strict";' },
    });
    part(S, a, { type: 'text', text: 'The build succeeded; the log was too long to keep.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 22, updated: t(), title: 'Show the build log' });
  }

  // ---------- secrets: every pattern kind, across all five outgoing sites --
  // The fifth site is a NODE LABEL, which for opencode comes from
  // `state.title` — attacker-influenced (a file path, a search query). Labels
  // reach find_nodes and get_graph with no payload fetched at all, which is
  // what pins redaction to the callTool choke point rather than to get_detail.
  {
    const S = 'ses_fx3000000000000secret';
    const F4 = 'FAKE';
    const FAKE20 = F4.repeat(5);
    const FAKE36 = F4.repeat(9);
    const FAKE40 = F4.repeat(10);
    const first = t();
    const u = userMsg(S, `I leaked AKIA${F4.repeat(4)} and ghp_${FAKE36} in the logs — rotate both and scrub the repo`, { at: first });
    const a = assistantMsg(S, u, { input: 5000, cacheRead: 0, output: 60, finish: 'tool-calls' });
    stepStart(S, a);
    // site 2 — tool OUTPUT
    toolPart(S, a, 'bash', { command: 'env | grep -i token', description: 'Find what else is exposed' }, {
      output: `SLACK_TOKEN=xoxb-FAKE-FAKE-${FAKE20}\nNPM_TOKEN=npm_${FAKE36}\nANTHROPIC_API_KEY=sk-ant-api03-${FAKE20}\nOPENAI_API_KEY=sk-proj-${FAKE20}`,
    });
    // site 3 — tool INPUT
    toolPart(S, a, 'edit', {
      filePath: `${ACME}/.env.local`,
      oldString: 'GOOGLE_KEY=',
      newString: `GOOGLE_KEY=AIza${'0'.repeat(31)}FAKE\nSTRIPE_KEY=sk_live_${FAKE20}`,
    }, { output: 'ok' });
    // site 4 — file content read back
    toolPart(S, a, 'read', { filePath: `${ACME}/ops/deploy.key` }, {
      output: `-----BEGIN RSA PRIVATE KEY-----\n${FAKE40}\n-----END RSA PRIVATE KEY-----\nSENDGRID=SG.${'A'.repeat(22)}.${'B'.repeat(43)}\nGITLAB=glpat-${FAKE20}\nGH_PAT=github_pat_${'0'.repeat(22)}\nLEGACY=sk-${'A'.repeat(20)}T3BlbkFJ${'B'.repeat(20)}\naws_secret_access_key = ${FAKE40}`,
    });
    // site 5 — the NODE LABEL, via state.title. AWS is deliberate: the label
    // is capped at 40 chars and a 20-char AKIA key is one of the few patterns
    // short enough to survive the cut intact.
    toolPart(S, a, 'grep', { pattern: `AKIA${F4.repeat(4)}`, path: ACME }, {
      title: `AKIA${F4.repeat(4)}`,
      output: 'src/legacy/deploy.sh:3',
    });
    part(S, a, { type: 'text', text: 'All of these need rotation before anything else happens.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 19, updated: t(), title: 'Rotate leaked credentials', projectId: 'prj_fxnotes', directory: NOTES });
  }

  // ---------- archived: a plain timestamp, shown and flagged ---------------
  // Transcribed from the real archived capture session: `PATCH /session/:id`
  // with `{time:{archived:<epoch ms>}}` writes the number straight through.
  // There is no soft-delete and no separate archive endpoint.
  {
    const S = 'ses_fx2000000000000archiv';
    const first = t();
    const u = userMsg(S, 'Remind me what shipped this week', { at: first });
    const a = assistantMsg(S, u, { input: 1200, cacheRead: 0, output: 25 });
    stepStart(S, a);
    part(S, a, { type: 'text', text: 'The beta checklist and the deploy script.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 16, updated: t(), archived: 1787258000000, title: 'Command session archiving' });
  }

  // ---------- reverted: the exclusion SPLIT, both halves in one run --------
  // Work-quality signals skip reverted nodes because they are claims about
  // output the revert discarded. Interventions survive, because a revert rolls
  // back work, not the record of what a person decided. Asserting only the
  // first half would let a blanket exclusion pass.
  {
    const S = 'ses_fx1000000000000revert';
    const first = t();
    const u1 = userMsg(S, 'Add a health endpoint to the server', { at: first });
    const a1 = assistantMsg(S, u1, { input: 7000, cacheRead: 500, output: 60, finish: 'tool-calls' });
    stepStart(S, a1);
    toolPart(S, a1, 'read', { filePath: `${ACME}/src/server.ts` }, { output: 'export function serve() {}' });
    toolPart(S, a1, 'edit', { filePath: `${ACME}/src/server.ts`, oldString: 'serve()', newString: 'serve() // health' }, { output: 'ok' });
    part(S, a1, { type: 'patch', hash: 'aa11bb22', files: [`${ACME}/src/server.ts`] }, t(30));
    stepFinish(S, a1, 'tool-calls');

    // Everything from HERE was rolled back. `revert.messageID` names the
    // TURN, not a step: opencode resolves an assistant id to the user message
    // that began the turn.
    const boundary = mid();
    userMsg(S, 'Now rip out the old router', { id: boundary });
    const a2 = assistantMsg(S, boundary, { input: 8000, cacheRead: 1000, output: 70, finish: 'tool-calls' });
    stepStart(S, a2);
    for (let i = 0; i < 3; i++) {
      toolPart(S, a2, 'edit', { filePath: `${ACME}/src/router.ts`, oldString: 'legacyRoute(', newString: 'route(' }, {
        error: 'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.',
      });
    }
    toolPart(S, a2, 'bash', { command: 'rm -rf src/router', description: 'Delete the old router' }, {
      error: 'The user rejected permission to use this specific tool call.',
    });
    stepFinish(S, a2, 'tool-calls');
    session(S, {
      created: first - 23,
      updated: t(),
      title: 'Add a health endpoint',
      revert: JSON.stringify({ messageID: boundary, snapshot: '72752f23e1e5fd98ead02b11d98dcc903c7c7095', diff: '' }),
    });
  }

  // ---------- interrupted: the marker, and the near-miss that must not fire -
  {
    const S = 'ses_fx0000000000000000int';
    const first = t();
    const u1 = userMsg(S, 'Rewrite the whole test suite in one go', { at: first });
    const a1 = assistantMsg(S, u1, { input: 9000, cacheRead: 400, output: 40, finish: 'tool-calls' });
    stepStart(S, a1);
    toolPart(S, a1, 'bash', { command: 'rm -rf tests && mkdir tests', description: 'Start the suite over' }, { output: '' });
    stepFinish(S, a1, 'tool-calls');
    const a1b = assistantMsg(S, u1, {
      input: 500, cacheRead: 9000, output: 0,
      error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
    });
    stepStart(S, a1b); // unmatched on purpose: 2 starts, 1 finish in this turn

    // The NEAR MISS: a missing `finish` with no MessageAbortedError. On a live
    // tail that means "still generating", so firing an interrupt chip at it
    // would be exactly the false flag the precision rule forbids.
    const u2 = userMsg(S, 'Just show me the config instead');
    const a2 = assistantMsg(S, u2, { input: 2000, cacheRead: 500, output: 20, finish: null });
    stepStart(S, a2);
    toolPart(S, a2, 'read', { filePath: `${ACME}/vitest.config.ts` }, { output: 'export default {}' });
    stepFinish(S, a2);
    session(S, { created: first - 27, updated: t(), title: 'Rewrite the test suite' });
  }

  // ---------- fork: a root session that COPIED another's history ------------
  // `POST /session/:id/fork` produces parent_id NULL, every message and part
  // copied, and NO lineage field of any kind. The only provable trace is that
  // the rows predate the session row — a causal impossibility unless they were
  // copied, which is why the SIGN of the delta is the rule and not its size.
  // It also does not inherit `agent`, which is why the agent falls back to the
  // modal message agent.
  {
    const S = 'ses_fxa000000000000000fork';
    const first = t();
    const u = userMsg(S, 'Read notes.txt and summarise it', { at: first });
    const a = assistantMsg(S, u, { input: 4000, cacheRead: 200, output: 45 });
    stepStart(S, a);
    toolPart(S, a, 'read', { filePath: `${NOTES}/notes.txt` }, { output: 'buy milk' });
    part(S, a, { type: 'text', text: 'It is a shopping list.' }, t(30));
    stepFinish(S, a);
    session(S, {
      created: first + 1533672, // AFTER its own first message — the fork tell
      updated: t(),
      title: 'Reading notes.txt contents (fork #1)',
      agent: null,
      model: null,
      projectId: 'prj_fxnotes',
      directory: NOTES,
    });
  }

  // ---------- compaction: a turn nobody typed, and the pseudo-agent --------
  // Compaction writes a `role=user` message holding exactly one `compaction`
  // part and NO text part, then one `role=assistant` message stamped
  // `agent: "compaction"`. The discriminator is structural, not textual.
  //
  // It lands FIRST here on purpose: a session resumed over the context limit
  // compacts before the user types, and that is the only order in which the
  // "a compaction never supplies an untitled run's title" rule is actually
  // exercised.
  {
    const S = 'ses_fxb00000000000compact';
    const first = t();
    const uc = mid();
    insMessage.run(uc, S, first, first, JSON.stringify({
      role: 'user', time: { created: first }, agent: 'build',
      model: { providerID: MODEL.providerID, modelID: MODEL.id, variant: MODEL.variant },
      summary: { diffs: 0 },
    }));
    part(S, uc, { type: 'compaction', auto: true, overflow: false, tail_start_id: 'msg_fx00000000' }, first + 5);
    const ac = assistantMsg(S, uc, { agent: 'compaction', input: 90000, cacheRead: 5000, output: 900 });
    stepStart(S, ac);
    part(S, ac, { type: 'text', text: 'Summary of the conversation so far: …' }, t(30));
    stepFinish(S, ac);

    const u = userMsg(S, 'Carry on with the migration');
    const a = assistantMsg(S, u, { input: 3000, cacheRead: 90000, output: 50 });
    stepStart(S, a);
    toolPart(S, a, 'write', { filePath: `${ACME}/src/migrate.ts`, content: 'export {}' }, { output: 'ok' });
    part(S, a, { type: 'text', text: 'Migration file written.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 18, updated: t(), title: null, agent: null });
  }

  // ---------- revert ACROSS a subagent lane --------------------------------
  // `revert` is written on the session row the user was looking at, never on
  // the child it dispatched — so a lane inside a reverted region has no
  // boundary of its own and must INHERIT the parent's. Without that the agent
  // node is struck through while every node inside its lane renders
  // unqualified, and work-quality signals fire on work that was thrown away.
  {
    const S = 'ses_fxe0000000000revertlane';
    const CHILD = 'ses_fxe1000000000lanechild';
    const first = t();
    const u1 = userMsg(S, 'Add request logging to the server', { at: first });
    const a1 = assistantMsg(S, u1, { input: 6000, cacheRead: 400, output: 50, finish: 'tool-calls' });
    stepStart(S, a1);
    toolPart(S, a1, 'read', { filePath: `${ACME}/src/server.ts` }, { output: 'export function serve() {}' });
    stepFinish(S, a1, 'tool-calls');

    // Everything from HERE was rolled back — the dispatch included.
    const boundary = mid();
    userMsg(S, 'Now have a subagent rewrite the router', { id: boundary });
    const a2 = assistantMsg(S, boundary, { input: 7000, cacheRead: 800, output: 60, finish: 'tool-calls' });
    stepStart(S, a2);
    toolPart(S, a2, 'task', { description: 'Rewrite the router', prompt: 'Replace legacyRoute with route.', subagent_type: 'build' }, {
      output: `task_id: ${CHILD}\n\n<task_result>\nCould not find the old router calls.\n</task_result>`,
      metadata: { truncated: false, sessionId: CHILD, parentSessionId: S },
    });
    stepFinish(S, a2, 'tool-calls');
    session(S, {
      created: first - 26,
      updated: t(),
      title: 'Add request logging',
      revert: JSON.stringify({ messageID: boundary, snapshot: 'c0ffee11c0ffee11c0ffee11c0ffee11c0ffee11', diff: '' }),
    });

    const cFirst = t();
    const cu = userMsg(CHILD, 'Replace legacyRoute with route.', { at: cFirst });
    const ca = assistantMsg(CHILD, cu, { input: 4000, cacheRead: 200, output: 40, finish: 'tool-calls' });
    stepStart(CHILD, ca);
    // Three failing edits: a textbook retry-storm, on work the user reverted.
    for (let i = 0; i < 3; i++) {
      toolPart(CHILD, ca, 'edit', { filePath: `${ACME}/src/router.ts`, oldString: 'legacyRoute(', newString: 'route(' }, {
        error: 'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.',
      });
    }
    stepFinish(CHILD, ca, 'tool-calls');
    session(CHILD, { created: cFirst - 11, updated: t(), parent: S, title: 'Rewrite the router (@build subagent)' });
  }

  // ---------- a REFUSED task, an in-flight one, and a refused batch --------
  // opencode permission-gates `task` BEFORE it creates the child session row,
  // so a refused subagent lands with the exact rejection string and no
  // `metadata.sessionId`. Routing every `task` to the lane builder swallows the
  // whole intervention AND charges coverage for a session that was never
  // written — rendering "the user refused a subagent" as "nothing happened,
  // and something was unreadable".
  {
    const S = 'ses_fxf00000000000denytask';
    const first = t();
    const u1 = userMsg(S, 'Fan this out to a subagent', { at: first });
    const a1 = assistantMsg(S, u1, { input: 5000, cacheRead: 300, output: 40, finish: 'tool-calls' });
    stepStart(S, a1);
    toolPart(S, a1, 'task', { description: 'Audit the auth module', prompt: 'Audit src/auth.', subagent_type: 'explore' }, {
      error: 'The user rejected permission to use this specific tool call.',
    });
    stepFinish(S, a1, 'tool-calls');

    // A dispatch opencode has not recorded a child for yet — the live-tail
    // moment between the tool call and `metadata({sessionId})`. Nothing was
    // written, so nothing was unread.
    const u2 = userMsg(S, 'Fine, try the other one');
    const a2 = assistantMsg(S, u2, { input: 5200, cacheRead: 400, output: 30, finish: 'tool-calls' });
    stepStart(S, a2);
    toolPart(S, a2, 'task', { description: 'Audit the router', prompt: 'Audit src/router.', subagent_type: 'explore' }, {
      status: 'running',
      output: '',
      metadata: { truncated: false },
    });

    // A refused PARALLEL BATCH: three denied calls in one step must read as
    // ONE person saying no, not three.
    const u3 = userMsg(S, 'Then just find the pem files');
    const a3 = assistantMsg(S, u3, { input: 5400, cacheRead: 500, output: 30, finish: 'tool-calls' });
    stepStart(S, a3);
    for (const n of [1, 2, 3]) {
      toolPart(S, a3, 'glob', { pattern: `**/*${n}.pem` }, {
        error: 'The user rejected permission to use this specific tool call.',
      });
    }
    stepFinish(S, a3, 'tool-calls');
    session(S, { created: first - 17, updated: t(), title: 'Fan out to a subagent' });
  }

  // ---------- shape drift: tokens present, `input` gone --------------------
  // The one narrow assertion. `selectList` protects SQL columns; a renamed key
  // inside a JSON blob yields a smaller-but-plausible number with
  // `unrecognized` still at 0, and coverage cannot catch it by construction.
  {
    const S = 'ses_fxc0000000000000shape';
    const first = t();
    const u = userMsg(S, 'Summarise the release notes', { at: first });
    const a = assistantMsg(S, u, {
      tokensRaw: { total: 0, promptTokens: 4000, output: 50, reasoning: 0, cache: { write: 0, read: 0 } },
    });
    stepStart(S, a);
    part(S, a, { type: 'text', text: 'Three fixes and one feature.' }, t(30));
    stepFinish(S, a);
    session(S, { created: first - 21, updated: t(), title: 'Summarise the release notes' });
  }

  db.close();
}
