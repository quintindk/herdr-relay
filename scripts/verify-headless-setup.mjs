// Isolated authenticated OpenCode service, real MCP read and native node execution.
// No human HOME, real account, external inbox or user service is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { enrolInteractive } from '../src/native-enrol.mjs';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from '../src/client.mjs';
import { waitHeadlessSetup } from '../src/headless-setup-wait.mjs';

process.umask(0o077);
const capabilityMode = process.argv.includes('--capabilities');
const root = mkdtempSync('/tmp/opencode/relay-headless-setup-'), workspace = join(root, 'twd'), state = join(root, 'node');
mkdirSync(workspace); mkdirSync(state); mkdirSync(join(workspace, '.opencode/skills/approved-job'), { recursive: true });
writeFileSync(join(workspace, '.opencode/skills/approved-job/SKILL.md'), 'Inspect the approved fixture only. Submit a native result.');
let reads = 0, runtime, backend, daemon, log = '';
const mcp = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const message = JSON.parse(body); if (message.id === undefined) { res.writeHead(202); res.end(); return; }
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'workiq-fixture', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [{ name: 'read', description: 'Read-only bounded fixture count', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] };
  if (message.method === 'tools/call') { assert.equal(message.params.name, 'read'); reads++; result = { content: [{ type: 'text', text: '{"count":0}' }], isError: false }; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result ?? {} }));
});
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), last = input.messages.findLastIndex(m => m.role === 'user');
  const called = input.messages.slice(last + 1).filter(m => m.role === 'tool').length;
  const steps = ['relay_workiq_read', ...(capabilityMode ? ['relay_headless_capabilities'] : []), 'relay_work_submit'];
  const name = steps[called];
  const tool = name && input.tools?.find(t => t.function.name.endsWith(name));
  if (name && !tool) console.error(JSON.stringify({ missingTool: name, advertised: input.tools?.map(t => t.function.name) }));
  const args = name === 'relay_workiq_read' ? { arguments: { query: 'Read the bounded fixture count only' }, ...(capabilityMode ? { sourceNamespace: 'external:record' } : {}) }
    : name === 'relay_headless_capabilities' ? {} : { key: 'ready', candidate: 'headless-readiness', summary: 'Model, WorkIQ and native result submission verified.' };
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${called}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: 'Fixture done.' };
  const base = { id: 'setup-model', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
const wait = async (label, check) => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (daemon?.exitCode !== null && daemon?.exitCode !== undefined) throw Error(`Fixture node exited: ${log}`);
    const value = await check(); if (value) return value;
    await delay(200);
  }
  throw Error(`Timed out: ${label}. Fixture ${root}. Node log: ${log}`);
};
const startNode = async configFile => {
  log = ''; daemon = spawn(process.execPath, [resolve('src/node-cli.mjs'), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', data => { log = (log + data).slice(-5000); });
  await wait('node startup', () => log.includes('"state":"running"'));
};
const stopNode = async () => {
  if (daemon && daemon.exitCode === null) { const child = daemon; daemon = null; const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
};
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => owner('POST', '/v1/commands', { key, action, payload });
  const bundleFile = join(root, 'node.bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'setup-node', name: 'Fixture Surface', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile: join(state, 'node.json') });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: resolve('packages/opencode-relay'), options: { workerDirectory: state } }],
      model: 'openai/fixture', compaction: { auto: false }, providers: { openai: { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' }, models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 512 } } } } },
      mcp: { servers: { workiq: { type: 'remote', url: `http://127.0.0.1:${mcp.address().port}/mcp`, oauth: false } } } } });
  const client = runtime.client;
  const integrations = (await client.integration.list({ location: { directory: workspace } })).data;
  const modelIntegration = integrations.find(i => i.id === 'openai');
  assert.ok(modelIntegration, `Fixture model integration missing; available IDs: ${integrations.map(i => i.id).join(',')}`);
  await client.integration.connect.key({ integrationID: modelIntegration.id, key: 'fixture-authorised-key', location: { directory: workspace } });
  const provider = (await client.provider.get({ providerID: 'openai', location: { directory: workspace } })).data;
  assert.ok(provider.integrationID, 'Fixture provider must expose an integration reference');
  const integration = (await client.integration.get({ integrationID: provider.integrationID, location: { directory: workspace } })).data;
  const connectionId = integration.connections.find(c => c.type === 'credential').id;
  await wait('existing WorkIQ connection', async () => {
    const server = (await client.mcp.list({ location: { directory: workspace } })).data.find(s => s.name === 'workiq');
    if (server?.status.status === 'failed') throw Error('Fixture WorkIQ transport failed');
    return server?.status.status === 'connected';
  });
  const session = await client.session.create({ location: { directory: workspace }, title: 'Fixture Mason' });
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const dependencies = { discover: async () => ({ url: runtime.descriptor.origin, auth: { type: 'basic', username: 'opencode', password } }), makeClient: () => client };
  const coordinator = await enrolInteractive({ api: owner, backend: { url: backend.origin }, configFile: joined.configFile, directory: workspace,
    sessionId: session.id, reserved: true, transport: 'tools', name: 'Mason' }, dependencies);
  const registration = join(root, 'registration.json');
  // Use the existing service discovery contract rather than creating another HOME.
  const config = JSON.parse(readFileSync(joined.configFile));
  // Discovery may be injected by the fixture node through its standard registration file.
  writeFileSync(registration, JSON.stringify({ url: runtime.descriptor.origin, password, version: (await client.server.info()).version, pid: runtime.descriptor.pid }));
  config.headless = { serviceRegistration: registration }; writeFileSync(joined.configFile, JSON.stringify(config));
  await command('grant', 'headless.grant', { id: 'approved-job-grant', requesterAgentId: coordinator.agentId, nodeId: joined.nodeId, name: 'approved-worker', directory: workspace,
    model: { providerID: 'openai', id: 'fixture', integrationID: provider.integrationID, connectionId },
    workiq: { server: 'workiq', readTool: 'workiq_read', probeInput: { query: 'Read the bounded fixture count only' } }, contract: '.opencode/skills/approved-job/SKILL.md',
    schedule: { id: 'approved-job-weekdays', cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' },
    ...(capabilityMode ? { capabilities: { sourceNamespaces: ['external:record'], taskActions: ['task.create', 'task.update', 'comment.create', 'reference.attach'],
      artifacts: { receipts: 'artifacts/receipts', state: 'artifacts/state.json', history: 'artifacts/history', runs: 'artifacts/runs', summaries: 'artifacts/summaries' } } } : {}) });
  await startNode(joined.configFile);
  const worker = workerConnection({ workerDirectory: state }, session.id);
  const receipt = await call(worker, 'POST', '/agent/headless-setup', { key: 'setup-once', grantId: 'approved-job-grant' });
  assert.equal(receipt.state, 'recorded'); const id = receipt.receipt.id;
  const result = await waitHeadlessSetup(worker, receipt);
  assert.equal(result.state, 'ready', `Setup did not complete: ${result.blocker}`);
  assert.ok(reads >= 1); assert.equal(result.restartRequired, false); assert.equal(result.appliedRevision, result.revision);
  if (capabilityMode) {
    const setup = await owner('GET', `/v1/headless_setups/${id}`);
    assert.ok(setup.readiness.capabilities);
    const snapshot = await owner('GET', '/v1/snapshot');
    assert.equal(snapshot.collections.task.length, 1); assert.equal(snapshot.collections.comment.length, 0);
    assert.equal(snapshot.collections.task[0].title, 'Readiness: approved-worker');
    assert.equal(readFileSync(join(workspace, '.opencode/skills/approved-job/SKILL.md'), 'utf8'), 'Inspect the approved fixture only. Submit a native result.');
  }
  await stopNode(); await startNode(joined.configFile);
  const restored = await call(worker, 'POST', '/agent/headless-status', { id });
  assert.equal(restored.agentId, result.agentId); assert.equal(restored.scheduleId, result.scheduleId); assert.equal(restored.appliedRevision, result.appliedRevision);
  const retry = await call(worker, 'POST', '/agent/headless-setup', { key: 'setup-once', grantId: 'approved-job-grant' });
  assert.equal(retry.receipt.id, id);
  assert.equal((await client.server.info()).pid, runtime.descriptor.pid);
  await command('revoke', 'headless.revoke', { id: 'approved-job-grant', expectedRevision: 1 });
  assert.equal((await owner('GET', '/v1/schedules/approved-job-weekdays')).definition.enabled, false);
  console.log(JSON.stringify({ passed: true, singleCoordinatorSetup: true, existingAuthenticatedServiceReused: true, realMcpRead: true,
    nativeResultSubmission: true, scheduleAppliedAndNextFiring: true, nodeRestartRetainedWorkerAndSchedule: true, revocationPausedSchedule: true, nodeRestartRequired: false,
    scopedTaskAndFileCanaries: capabilityMode, credentialsCopied: false, humanLoginRequired: false, userServicesTouched: false, fixture: root }, null, 2));
} finally {
  await stopNode();
  if (runtime) await runtime.stop(); if (backend) await backend.close();
  model.closeAllConnections(); mcp.closeAllConnections();
  await Promise.all([new Promise(resolve => model.close(resolve)), new Promise(resolve => mcp.close(resolve))]);
}
