// Actual isolated OpenCode service, model-driven tools and node delivery. No
// user credentials, sessions, tasks or services are used or changed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { launchOwnedV2 } from './owned-runtime.mjs';
import { startBackend } from '../../src/backend-service.mjs';
import { nativeBackendClient } from '../../src/backend-client.mjs';
import { enrolInteractive } from '../../src/native-enrol.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = mkdtempSync('/tmp/opencode/relay-messages-smoke-');
const workspace = join(root, 'workspace'), state = join(root, 'node');
mkdirSync(workspace); mkdirSync(state);
let runtime, backend, daemon, recipient, requests = 0, log = '';
const wait = async (label, check) => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (daemon && daemon.exitCode !== null) throw Error(`Daemon exited: ${log}`);
    const result = await check(); if (result) return result;
    await delay(200);
  }
  throw Error(`Timed out: ${label}. Fixture retained at ${root}. Node: ${log}`);
};
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), index = input.messages.findLastIndex(m => m.role === 'user');
  const user = input.messages[index], text = typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
  const sentTools = input.messages.slice(index + 1).filter(m => m.role === 'tool');
  const sending = text.includes('MESSAGE_SMOKE_SEND');
  const name = sentTools.length === 0 ? (sending ? 'relay_message_send' : 'relay_messages') :
    sentTools.length === 1 && sending ? 'relay_messages' : null;
  const tool = name && input.tools?.find(t => t.function?.name.endsWith(name));
  if (name) assert.ok(tool, `Missing native tool ${name}`);
  const args = name === 'relay_message_send' ? { key: 'native-status', recipientAgentId: recipient.agentId,
    kind: 'status', subject: 'Connectivity recovered', body: 'Bridge running. Workload readiness is still unverified. No action requested.' } : { direction: sending ? 'sent' : 'inbox' };
  requests++;
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests}`, type: 'function',
    function: { name: tool.function.name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: sending ? 'MESSAGE_QUEUED' : 'PEER_MESSAGE_RECEIVED' };
  const base = { id: `chatcmpl-${requests}`, created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const stop = async () => {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit'); daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 15000);
  try { const [code] = await exited; assert.equal(code, 0, log); } finally { clearTimeout(timer); daemon = null; }
};
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), executable: process.env.RELAY_V2_BINARY ?? join(here, 'node_modules/.bin/opencode2'), workspace,
    config: { plugins: [{ package: here, options: { workerDirectory: state } }], model: 'messages-fixture/fixture', compaction: { auto: false },
      providers: { 'messages-fixture': { package: '@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' },
        models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 256 } } } } } } });
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const dependencies = { discover: async () => ({ url: runtime.descriptor.origin, auth: { type: 'basic', username: 'opencode', password } }), makeClient: () => runtime.client };
  const configFile = join(state, 'node.json'), enrol = async name => {
    const session = await runtime.client.session.create({ location: { directory: workspace }, title: name });
    return enrolInteractive({ api: owner, backend: { url: backend.origin }, configFile, directory: workspace,
      sessionId: session.id, name, reserved: true, transport: 'tools' }, dependencies);
  };
  const sender = await enrol('Sender fixture'); recipient = await enrol('Recipient fixture');
  const start = async () => {
    log = ''; daemon = spawn(process.execPath, [join(here, '../../src/node-cli.mjs'), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-6000); });
    await wait('node ready', () => log.includes('"state":"running"'));
  };
  await start();
  await runtime.client.session.prompt({ sessionID: sender.sessionId,
    text: 'MESSAGE_SMOKE_SEND. Send one informational status update using relay_message_send, then inspect your sent inbox. Do not create a task or dispatch work.' });
  const message = await wait('message delivered', async () => (await owner('GET', `/v1/messages?agentId=${sender.agentId}&direction=sent`)).items.find(m => m.state === 'delivered'));
  assert.equal(message.recipient.agentId, recipient.agentId);
  const before = (await runtime.client.message.list({ sessionID: recipient.sessionId, order: 'asc', limit: 100 })).data;
  assert.equal(before.filter(m => m.id === message.delivery.nativeMessageId).length, 1);
  assert.ok(before.filter(m => m.type === 'assistant').some(m => JSON.stringify(m.content).includes('PEER_MESSAGE_RECEIVED')));
  const snapshot = await owner('GET', '/v1/snapshot');
  assert.equal(snapshot.collections.task.length, 0); assert.equal(snapshot.collections.execution.length, 0);
  assert.equal(snapshot.collections.message.length, 1);
  await stop(); await start();
  await wait('recipient re-advertised after restart', async () => (await owner('GET', `/v1/agents/${recipient.agentId}`)).availability === 'available');
  const after = (await runtime.client.message.list({ sessionID: recipient.sessionId, order: 'asc', limit: 100 })).data;
  assert.equal(after.filter(m => m.id === message.delivery.nativeMessageId).length, 1);
  assert.equal((await owner('GET', `/v1/messages?agentId=${sender.agentId}&direction=sent`)).items.length, 1);
  console.log(JSON.stringify({ passed: true, runtime: (await runtime.client.server.info()).version, model: 'deterministic fixture',
    realNativeMessageSendTool: true, recipientInboxRead: true, taskIndependent: true, nativeDeliveryReceipt: true,
    restartDidNotDuplicate: true, automaticReplies: 0, physicalMachines: 1, actualHuman: false, state: root }, null, 2));
} finally {
  await stop(); await runtime?.stop(); await backend?.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
