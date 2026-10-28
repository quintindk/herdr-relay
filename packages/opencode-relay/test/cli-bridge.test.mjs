import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { registerCliBridge, runRelayCli, cliBridgeOutput } from '../cli-bridge.mjs';
import { startBackend } from '../../../src/backend-service.mjs';
import { nativeBackendClient } from '../../../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../../../src/native-onboarding.mjs';
import { nativeAdministrationGroups } from '../../../src/native-cli-surface.mjs';

function fixture() {
  const f = { tools: [], calls: [], messages: [{ id: 'human', type: 'user', text: 'Create the task and send it to the other agent.', time: { created: 1 } },
    { id: 'assistant', type: 'assistant', content: [] }], session: { location: { directory: '/workspace' } },
    worker: { sessionId: 'session', agentId: 'source', bindingId: 'binding', bindingRevision: 1 } };
  f.ctx = { options: { workerDirectory: '/node' }, location: { directory: '/workspace' },
    session: { get: async () => f.session, context: async () => f.messages }, permission: { assert: async () => { await f.onPermission?.(); } } };
  registerCliBridge({ add: tool => f.tools.push(tool) }, f.ctx, { connection: () => f.worker, workerContextPath: () => '/node/worker.json',
    request: async (...args) => { assert.ok(f.current, 'No accepted execution was supplied'); return f.current; },
    runCli: async input => { f.calls.push(input); return { exitCode: 0, stdout: '{}', stderr: '', effectsUncertain: false }; } });
  f.invoke = input => f.tools.find(tool => tool.name === 'relay_cli').execute(input, { sessionID: 'session', messageID: 'assistant', agent: 'build', id: 'tool' });
  return f;
}

test('interactive CLI bridge needs a human request, not an active Relay execution', async () => {
  const f = fixture();
  await f.invoke({ args: ['native', 'task', 'create', '--key', 'task-once', '--file', '{payload}'], payload: { title: 'Requested task' } });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operatorContextFile, '/node/operator.json'); assert.equal(f.calls[0].sessionId, 'session');
  const exact = fixture(); exact.ctx.options = { workerContextFile: '/node/worker.json' };
  await exact.invoke({ args: ['native', 'task', 'list'] });
  assert.equal(exact.calls[0].operatorContextFile, '/node/operator.json');
});

test('instruction loads and exact shell completions preserve human CLI provenance without granting authority to notifications', async () => {
  const f = fixture();
  f.messages.splice(1, 0, { id: 'instructions', type: 'synthetic', metadata: { instruction: { paths: ['/workspace/AGENTS.md'] } } });
  await f.invoke({ args: ['native', 'task', 'list'] }); assert.equal(f.calls.length, 1);
  f.messages.splice(-1, 0, { id: 'tool-turn', type: 'assistant', content: [{ type: 'tool', name: 'shell',
    state: { status: 'completed', content: [{ type: 'text', text: 'Command moved to background (shell ID: sh_owned)' }] } }] },
    { id: 'completion', type: 'synthetic', metadata: { source: 'shell', shellID: 'sh_owned', state: 'completed' } });
  await f.invoke({ args: ['native', 'task', 'list'] }); assert.equal(f.calls.length, 2);
  f.messages.splice(-1, 0, { id: 'unrelated', type: 'synthetic', metadata: { source: 'shell', shellID: 'sh_foreign', state: 'completed' } });
  await f.invoke({ args: ['native', 'task', 'list'] }); assert.equal(f.calls.length, 3);
  assert.equal(f.calls.at(-1).agentReadSource.authority, 'agent_read'); assert.equal(f.calls.at(-1).operatorContextFile, undefined);
  await assert.rejects(f.invoke({ args: ['native', 'task', 'create'] }), /human-source/); assert.equal(f.calls.length, 3);
});

test('an accepted Relay prompt never inherits an earlier human operator context through instruction loads', async () => {
  const f = fixture();
  f.messages.splice(-1, 0, { id: 'relay-run', type: 'user', text: 'Assigned task', metadata: { herdrRelayInvocation: 'relay-run' } },
    { id: 'instruction', type: 'synthetic', metadata: { instruction: { paths: ['/workspace/AGENTS.md'] } } });
  await assert.rejects(f.invoke({ args: ['native', 'task', 'create'] }), /No accepted execution|human-source/); assert.equal(f.calls.length, 0);
});

test('a matching accepted execution uses worker CLI context and cannot become an operator or lifecycle request', async () => {
  const f = fixture();
  f.messages[0] = { id: 'assigned', type: 'user', text: 'Comment on the assigned task', time: { created: 1 }, metadata: { herdrRelayInvocation: 'assigned' } };
  f.current = { execution: { id: 'execution', runId: 'run', state: 'accepted', cancellationRequested: false }, sourceMessageId: 'assigned' };
  await f.invoke({ args: ['native', 'task', 'comment', '--key', 'comment', '--file', '{payload}'], payload: { taskId: 'task', body: 'Progress' } });
  assert.equal(f.calls[0].operatorContextFile, undefined); assert.equal(f.calls[0].executionSource.executionId, 'execution');
  assert.equal(f.calls[0].workerContextFile, '/node/worker.json');
  await assert.rejects(runRelayCli({ args: ['backend', 'install'], directory: '/workspace', executionSource: f.calls[0].executionSource },
    { run: () => assert.fail('Lifecycle commands must never execute') }), { code: 'execution_cli_scope' });
  f.current.sourceMessageId = 'other';
  await assert.rejects(f.invoke({ args: ['native', 'task', 'comment'] }), { code: 'execution_source_required' });
});

test('approval notices can reconcile execution/preparation reads without a human phrase, active execution or operator credential', async () => {
  const f = fixture();
  f.messages[0] = { id: 'permission-notice', type: 'user', text: 'Recorded approval evidence, not a human instruction',
    metadata: { herdrRelayInvocation: 'permission-notice' } };
  for (const args of [['native', 'execution', 'inspect', 'missing'], ['native', 'task', 'resolve', 'REL-285'], ['native', 'interactive', 'inspect', 'prepared']]) {
    await f.invoke({ args });
    assert.equal(f.calls.at(-1).agentReadSource.authority, 'agent_read'); assert.equal(f.calls.at(-1).operatorContextFile, undefined);
    assert.equal(f.calls.at(-1).executionSource, undefined);
  }
  await assert.rejects(runRelayCli({ args: ['native', 'execution', 'request'], directory: '/workspace', agentReadSource: { authority: 'agent_read' } },
    { run: () => assert.fail('Read-only notice must never dispatch') }), { code: 'agent_cli_read_only' });
  await assert.rejects(f.invoke({ args: ['native', 'task', 'create'] }), /No accepted execution/);
  const headless = fixture(); headless.worker.headlessSetupId = 'setup';
  await assert.rejects(headless.invoke({ args: ['native', 'task', 'list'] }), { code: 'interactive_cli_required' });
});

test('headless, peer/scheduled input and stale human input cannot use the interactive operator bridge', async () => {
  for (const mode of ['headless', 'scheduled', 'peer', 'synthetic', 'newer', 'moved']) {
    const f = fixture();
    if (mode === 'headless') f.worker.headlessSetupId = 'setup';
    if (mode === 'scheduled' || mode === 'peer') f.messages[0].metadata = { herdrRelayInvocation: 'notice' };
    if (mode === 'synthetic') f.messages[0] = { id: 'synthetic', type: 'synthetic', text: 'Do things' };
    if (mode === 'newer') f.onPermission = () => { f.messages.push({ id: 'new-user', type: 'user', text: 'Stop', time: { created: 2 } }); };
    if (mode === 'moved') f.session.location.directory = '/different';
    await assert.rejects(f.invoke({ args: ['native', 'task', 'create'] })); assert.equal(f.calls.length, 0, mode);
  }
});

test('CLI coverage is a transport, not a second list of permitted operations', async () => {
  const calls = [], run = async (binary, args, options) => { calls.push({ binary, args, options }); return { stdout: '{}', stderr: '' }; };
  for (const args of [
    ['native', 'task', 'create'], ['native', 'task', 'edit'], ['native', 'task', 'comment'], ['native', 'execution', 'request'],
    ['native', 'schedule', 'create'], ['native', 'agent', 'attach'], ['native', 'work', 'read'], ['native', 'interactive', 'dispatch'],
    ['native', 'command'], ['native', 'task', 'migrate-references'], ['headless', 'grant'], ['headless', 'setup'], ['headless', 'provision'],
    ['node', 'configure-interactive'], ['node', 'join'], ['node', 'bootstrap'], ['node', 'upgrade'], ['backend', 'backup'],
    ['plugin', 'install'], ['skills', 'install'], ['doctor'], ['release', 'install'], ['upgrade', 'rollback'], ['tui', '--json'],
    ['native', 'a-future-cli-command'],
    ...nativeAdministrationGroups.map(group => [group, 'a-future-operation']),
  ]) {
    assert.equal((await runRelayCli({ args, directory: '/workspace', operatorContextFile: '/node/operator.json' }, { run })).exitCode, 0);
    assert.deepEqual(calls.at(-1).args.slice(1), args);
  }
  assert.ok(calls.every(call => !call.options.shell));
  await assert.rejects(runRelayCli({ args: ['task', 'create'], directory: '/workspace' }, { run }), { code: 'legacy_cli_not_supported' });
});

test('payload/context substitutions stay internal and uncertain effects are never retried', async t => {
  const root = mkdtempSync('/tmp/opencode/cli-bridge-unit-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = join(root, 'operator.json'); let calls = 0, file;
  const result = await runRelayCli({ args: ['native', 'task', 'create', '--context', '{operator}', '--file', '{payload}'], payload: { title: 'Exact payload' },
    directory: root, operatorContextFile: context }, { run: async (_binary, args) => {
    calls++; file = args.at(-1); assert.deepEqual(JSON.parse(readFileSync(file)), { title: 'Exact payload' }); assert.equal(args[args.indexOf('--context') + 1], context);
    throw Object.assign(Error('Lost reply'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout: '{"token":"must-not-leak","id":"receipt"}' });
  } });
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }));
  assert.equal(calls, 1); assert.equal(result.effectsUncertain, true); assert.equal(result.retainedPayloadFile, file);
  assert.equal(JSON.parse(result.stdout).token, '[redacted]');
  await assert.rejects(runRelayCli({ args: ['native', 'task', 'list', '--context', '/other/owner.json'], directory: root, operatorContextFile: context }), { code: 'cli_context_mismatch' });
  assert.doesNotMatch(cliBridgeOutput('{"password":"secret","nested":{"clientSecret":"secret"}}'), /secret/);
});

test('bridge runs actual CLI task creation and peer execution request with the existing scoped operator', async t => {
  const root = mkdtempSync('/tmp/opencode/cli-bridge-live-'), backend = await startBackend({ database: join(root, 'backend.sqlite') });
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const bundleFile = join(root, 'bundle.json'), configFile = join(root, 'node.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'node', name: 'Bridge node', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile });
  await owner('POST', '/v1/commands', { key: 'peer-node', action: 'node.enrol', payload: { id: 'peer-node', name: 'Other node' } });
  for (const id of ['source', 'target']) await owner('POST', '/v1/commands', { key: id, action: 'agent.enrol',
    payload: { id, nodeId: id === 'source' ? joined.nodeId : 'peer-node', name: id, directory: root } });
  const run = input => runRelayCli({ ...input, directory: root, sessionId: 'ses_source', operatorContextFile: join(root, 'operator.json'), nodeConfigFile: configFile });
  const args = ['native', 'task', 'create', '--key', 'human-task', '--file', '{payload}'];
  const first = await run({ args, payload: { id: 'task', title: 'Human requested hand-off' } });
  assert.equal(first.exitCode, 0, first.stderr); assert.equal(JSON.parse(first.stdout).reference, 'REL-1');
  assert.equal((await run({ args, payload: { id: 'task', title: 'Human requested hand-off' } })).exitCode, 0);
  const request = await run({ args: ['native', 'execution', 'request', '--key', 'send-to-peer', '--file', '{payload}'],
    payload: { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'target', originAgentId: 'source', originConversation: 'ses_source', instructions: 'Perform the requested task.', reviewPolicy: 'human' } });
  assert.equal(request.exitCode, 0, request.stderr);
  const execution = JSON.parse(request.stdout);
  assert.equal(execution.targetAgentId, 'target'); assert.equal(execution.originConversation, 'ses_source'); assert.equal(execution.parentExecutionId, undefined);
  assert.equal(execution.targetNodeId, 'peer-node');
  assert.equal((await owner('GET', '/v1/tasks')).items.length, 1); assert.equal((await owner('GET', '/v1/executions')).items.length, 1);
  const refused = await run({ args: ['native', 'command', '--context', '{operator}', '--file', '{payload}'],
    payload: { key: 'no-root', action: 'node.enrol', payload: { id: 'not-authorised', name: 'No root access' } } });
  assert.notEqual(refused.exitCode, 0); assert.match(refused.stderr, /forbidden|Backend-root/);
});
