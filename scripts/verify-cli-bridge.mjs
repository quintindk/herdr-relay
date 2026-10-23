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

process.umask(0o077);
const root = mkdtempSync('/tmp/opencode/relay-cli-bridge-'), workspace = join(root, 'workspace'), state = join(root, 'node');
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? '.');
mkdirSync(workspace); mkdirSync(state);
let runtime, backend, originSessionId;
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), last = input.messages.findLastIndex(message => message.role === 'user');
  const step = input.messages.slice(last + 1).filter(message => message.role === 'tool').length;
  const tool = input.tools?.find(tool => tool.function.name === 'relay_cli');
  const payload = step === 0 ? { id: 'task', title: 'Interactive bridge hand-off' } : {
    id: 'execution', taskId: 'task', taskRevision: 1, originAgentId: 'source', originConversation: originSessionId,
    targetAgentId: 'target', instructions: 'Perform the human-requested task.', reviewPolicy: 'human' };
  const args = step === 0 ? ['native', 'task', 'create', '--key', 'create-once', '--file', '{payload}'] :
    ['native', 'execution', 'request', '--key', 'send-once', '--file', '{payload}'];
  const delta = step < 2 && tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function',
    function: { name: tool.function.name, arguments: JSON.stringify({ args, payload }) } }] } : { role: 'assistant', content: 'Bridge fixture finished.' };
  const base = { id: 'bridge-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: step < 2 && tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
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
  writeFileSync(workerFile, JSON.stringify({ agentId: 'source', sessionId: source.id, bindingId: 'source-binding', bindingRevision: 1, token: 'fixture-no-node-socket' }));
  writeFileSync(join(state, 'worker-index.json'), JSON.stringify({ sessions: { [source.id]: workerFile } }));
  for (const [id, sessionId] of [['source', source.id], ['target', target.id]]) await owner('POST', '/v1/commands', { key: `attach-${id}`, action: 'agent.attach',
    payload: { id, expectedBindingRevision: 0, conversationId: sessionId, directory: workspace, bindingId: `${id}-binding` } });
  await runtime.client.session.prompt({ sessionID: source.id, text: 'Create a task, then send it to the existing target agent using the CLI bridge. No parent execution exists.' });
  await runtime.client.session.wait({ sessionID: source.id });
  const tasks = (await owner('GET', '/v1/tasks')).items, executions = (await owner('GET', '/v1/executions')).items;
  if (tasks.length !== 1 || executions.length !== 1) {
    const messages = await runtime.client.session.context({ sessionID: source.id });
    console.error(JSON.stringify(messages.filter(message => message.type === 'assistant').flatMap(message => message.content.filter(content => content.type === 'tool')), null, 2));
  }
  assert.equal(tasks.length, 1); assert.equal(executions.length, 1);
  assert.equal(executions[0].targetAgentId, 'target'); assert.equal(executions[0].parentExecutionId, undefined);
  assert.equal(executions[0].originConversation, source.id);
  assert.equal(executions[0].targetNodeId, 'peer-node');
  assert.equal(executions[0].state, 'requested');
  const info = await runtime.client.server.info();
  console.log(JSON.stringify({ passed: true, runtime: info.version, realModelToolTurn: true, pluginInvokedActualCli: true,
    humanTaskCreated: true, existingPeerExecutionRequested: true, activeParentRequired: false, taskCount: tasks.length,
    executionCount: executions.length, differentTargetNode: true, workerStarted: false, userServicesTouched: false, fixture: root }, null, 2));
} finally {
  await runtime?.stop(); await backend?.close(); model.closeAllConnections();
  await new Promise(resolve => model.close(resolve));
}
