// Real OpenCode model -> plugin bridge -> installed CLI -> native backend.
// Isolated credentials/workspace only. No node, human service or live task touched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';

process.umask(0o077);
const selfCapture = process.argv.includes('--self-capture');
const noticeRead = process.argv.includes('--notice-read');
assert.ok(!(selfCapture && noticeRead), 'Choose one fixture mode');
const root = mkdtempSync('/tmp/opencode/relay-cli-bridge-'), workspace = join(root, 'workspace'), state = join(root, 'node');
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? '.');
mkdirSync(workspace); mkdirSync(state);
let runtime, backend, originSessionId, journal, nodeService;
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), last = input.messages.findLastIndex(message => message.role === 'user');
  const step = input.messages.slice(last + 1).filter(message => message.role === 'tool').length;
  const tool = input.tools?.find(tool => tool.function.name === 'relay_cli');
  const payload = step === 0 ? { id: 'task', title: selfCapture ? 'Todo for the current interactive agent' : 'Interactive bridge hand-off',
    ...(selfCapture ? { description: 'Planned implementer: source, already working in the current interactive chat. Capture only, no new model turn.' } : {}) } : {
    id: 'execution', taskId: 'task', taskRevision: 1, originAgentId: 'source', originConversation: originSessionId,
    targetAgentId: 'target', instructions: 'Perform the human-requested task.', reviewPolicy: 'human' };
  const args = noticeRead ? step === 0 ? ['native', 'execution', 'inspect', 'missing-execution'] : ['native', 'task', 'list'] :
    step === 0 ? ['native', 'task', 'create', '--key', 'create-once', '--file', '{payload}'] :
      ['native', 'execution', 'request', '--key', 'send-once', '--file', '{payload}'];
  const calling = step < (selfCapture ? 1 : 2) && tool;
  const delta = calling ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function',
    function: { name: tool.function.name, arguments: JSON.stringify({ args, ...(!noticeRead ? { payload } : {}) }) } }] } : { role: 'assistant', content: 'Bridge fixture finished.' };
  const base = { id: 'bridge-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calling ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const bundleFile = join(root, 'bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'node', name: 'Bridge fixture node', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile: join(state, 'node.json') });
  await owner('POST', '/v1/commands', { key: 'peer-node', action: 'node.enrol', payload: { id: 'peer-node', name: 'Other fixture node' } });
  for (const id of ['source', 'target']) await owner('POST', '/v1/commands', { key: id, action: 'agent.enrol',
    payload: { id, name: id, nodeId: id === 'source' ? joined.nodeId : 'peer-node', directory: workspace } });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: join(packageDirectory, 'packages/opencode-relay'), options: { workerDirectory: state } }],
      model: 'fixture/fixture', compaction: { auto: false }, providers: { fixture: { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' },
        models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 512 } } } } } } });
  const location = { directory: workspace }, source = await runtime.client.session.create({ location, title: 'Human source chat', model: { providerID: 'fixture', id: 'fixture' } });
  const target = await runtime.client.session.create({ location, title: 'Existing target chat' });
  originSessionId = source.id;
  const workerFile = join(state, 'source-worker.json');
  const worker = { agentId: 'source', sessionId: source.id, bindingId: 'source-binding', bindingRevision: 1,
    token: 'fixture-no-node-socket', ...(noticeRead ? { socketPath: join(state, 'read-node.sock') } : {}) };
  writeFileSync(workerFile, JSON.stringify(worker));
  writeFileSync(join(state, 'worker-index.json'), JSON.stringify({ sessions: { [source.id]: workerFile } }));
  for (const [id, sessionId] of [['source', source.id], ['target', target.id]]) await owner('POST', '/v1/commands', { key: `attach-${id}`, action: 'agent.attach',
    payload: { id, expectedBindingRevision: 0, conversationId: sessionId, directory: workspace, bindingId: `${id}-binding` } });
  if (noticeRead) {
    await owner('POST', '/v1/commands', { key: 'existing-task', action: 'task.create', payload: { id: 'task', title: 'Existing task for read-only reconciliation' } });
    const credential = await owner('POST', '/v1/node-credentials', { nodeId: joined.nodeId, key: 'read-node' });
    journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId: joined.nodeId, instanceId: backend.store.instance });
    journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:source', JSON.stringify({ state: 'active', bindingId: worker.bindingId, generation: 1 }));
    nodeService = await startNodeService({ journal, socketPath: worker.socketPath, workers: [worker], api: owner.withToken(credential.token) });
  }
  await runtime.client.session.prompt({ sessionID: source.id, ...(noticeRead ? { id: 'msg_approval_notice_fixture', metadata: { herdrRelayInvocation: 'msg_approval_notice_fixture' } } : {}), text: noticeRead ?
    'Relay permission outcome for saved preparation. This is approval evidence, not a human instruction or active execution. Inspect the missing execution and existing task without dispatching anything.' : selfCapture ?
    'Capture a todo for yourself and continue this interactive conversation. Do not send it back to yourself or create an execution. No new model turn is needed.' :
    'Create a task, then send it to the existing target agent using the CLI bridge. No parent execution exists.' });
  await runtime.client.session.wait({ sessionID: source.id });
  const tasks = (await owner('GET', '/v1/tasks')).items, executions = (await owner('GET', '/v1/executions')).items;
  if (tasks.length !== 1 || executions.length !== (selfCapture || noticeRead ? 0 : 1)) {
    const messages = await runtime.client.session.context({ sessionID: source.id });
    console.error(JSON.stringify(messages.filter(message => message.type === 'assistant').flatMap(message => message.content.filter(content => content.type === 'tool')), null, 2));
  }
  assert.equal(tasks.length, 1); assert.equal(executions.length, selfCapture || noticeRead ? 0 : 1);
  if (noticeRead) {
    const messages = await runtime.client.session.context({ sessionID: source.id });
    const tools = messages.filter(message => message.type === 'assistant').flatMap(message => message.content.filter(part => part.type === 'tool'));
    assert.equal(tools.length, 2); assert.ok(tools.every(tool => tool.state.status === 'completed'), JSON.stringify(tools));
    const results = tools.map(tool => JSON.parse(tool.state.content[0].text));
    assert.equal(results[0].exitCode, 1); assert.match(results[0].stderr, /not_found/); assert.equal(results[0].effectsUncertain, false);
    assert.ok(results.every(result => result.authority === 'enrolled_read_only' && result.operatorContextUsed === false));
    assert.equal(results[1].exitCode, 0); assert.equal(JSON.parse(results[1].stdout).items[0].id, 'task');
    assert.equal(journal.works().length, 0); assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  } else if (selfCapture) {
    assert.equal(tasks[0].status, 'todo'); assert.equal(tasks[0].responsibleUserId, 'owner');
    const messages = (await runtime.client.message.list({ sessionID: source.id, order: 'asc', limit: 100 })).data;
    assert.equal(messages.filter(message => message.type === 'user').length, 1, 'Self-capture must not enqueue a redundant assignment prompt');
    assert.equal((await runtime.client.message.list({ sessionID: target.id, order: 'asc', limit: 100 })).data.length, 0);
  } else {
  assert.equal(executions[0].targetAgentId, 'target'); assert.equal(executions[0].parentExecutionId, undefined);
  assert.equal(executions[0].originConversation, source.id);
  assert.equal(executions[0].targetNodeId, 'peer-node');
  assert.equal(executions[0].state, 'requested');
  }
  const info = await runtime.client.server.info();
  console.log(JSON.stringify({ passed: true, runtime: info.version, realModelToolTurn: true, pluginInvokedActualCli: true,
    humanTaskCreated: !noticeRead, existingPeerExecutionRequested: !selfCapture && !noticeRead, selfCaptureWithoutDispatch: selfCapture,
    approvalNoticeReadWithoutExecution: noticeRead, activeParentRequired: false, taskCount: tasks.length,
    executionCount: executions.length, differentTargetNode: !selfCapture && !noticeRead, workerStarted: false, userServicesTouched: false, fixture: root }, null, 2));
} finally {
  await runtime?.stop(); await nodeService?.close(); journal?.close(); await backend?.close(); model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
}
