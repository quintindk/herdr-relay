// Isolated authenticated OpenCode service, general MCP permission and native execution.
// No human HOME, real account, external inbox or user service is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { enrolInteractive } from '../src/native-enrol.mjs';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from '../src/client.mjs';
import { waitHeadlessSetup } from '../src/headless-setup-wait.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { digest } from '../src/protocol.mjs';
import { DatabaseSync } from 'node:sqlite';

process.umask(0o077);
const capabilityMode = process.argv.includes('--capabilities');
const agentGrantMode = process.argv.includes('--agent-grant');
const notificationMode = process.argv.includes('--run-result-notifications');
const cronMode = process.argv.includes('--cron') || notificationMode;
const legacyRefusalMode = process.argv.includes('--legacy-contract-refusal');
const contractMode = process.argv.includes('--contract-update') || legacyRefusalMode;
const rebindMode = process.argv.includes('--connection-rebind');
const mcpDenied = process.argv.includes('--mcp-denied');
const shellAllowed = process.argv.includes('--shell'), shellMode = shellAllowed || process.argv.includes('--shell-denied');
const root = mkdtempSync('/tmp/opencode/relay-headless-setup-'), workspace = join(root, 'workspace'), state = join(root, 'node');
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? '.');
const shellOutput = join(root, 'outside-workspace-shell.txt');
mkdirSync(workspace); mkdirSync(state); mkdirSync(join(workspace, '.opencode/skills/approved-job'), { recursive: true });
writeFileSync(join(workspace, '.opencode/skills/approved-job/SKILL.md'), 'Inspect the approved fixture only. Submit a native result.');
let reads = 0, writes = 0, runtime, backend, daemon, log = '', shellDeniedHidden = false, grantProposal, contractProposal, contractPreviewHash, revisedContextSeen = false;
let runResultMessages = 0;
const mcpSessions = [];
const mcp = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const message = JSON.parse(body); if (message.id === undefined) { res.writeHead(202); res.end(); return; }
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'generic-mcp-fixture', version: '1' } };
  if (message.method === 'tools/list') result = { tools: [
    { name: 'read', description: 'Read-only bounded fixture count', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
    { name: 'send', description: 'Write only to the disposable fixture, never an external recipient', inputSchema: { type: 'object', properties: { recipient: { type: 'string' } }, required: ['recipient'], additionalProperties: false } },
  ] };
  if (message.method === 'tools/call') {
    mcpSessions.push(message.params._meta?.['ai.opencode/sessionID']);
    if (message.params.name === 'read') reads++;
    else { assert.equal(message.params.name, 'send'); assert.equal(message.params.arguments.recipient, 'fixture-only'); writes++; }
    result = { content: [{ type: 'text', text: '{"fixture":true}' }], isError: false };
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result ?? {} }));
});
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), last = input.messages.findLastIndex(m => m.role === 'user');
  if (JSON.stringify(input.messages[last]?.content).includes('Relay run result notification.')) {
    const called = input.messages.slice(last + 1).filter(message => message.role === 'tool').length;
    if (called === 0) runResultMessages++;
    assert.match(JSON.stringify(input.messages[last]?.content), /Native capability and result submission verified/);
    // Deliberately adversarial fixture: the notification must not authorise a
    // coordinator reply, even though its normal interactive tools are present.
    const reply = called === 0 && input.tools?.find(tool => tool.function.name.endsWith('relay_message_send'));
    const delta = reply ? { role: 'assistant', tool_calls: [{ index: 0, id: 'notice-reply', type: 'function', function: {
      name: reply.function.name, arguments: JSON.stringify({ key: 'must-not-send', recipientAgentId: grantProposal.requesterAgentId, body: 'Unauthorised automatic acknowledgement' }),
    } }] } : { role: 'assistant', content: 'RUN_RESULT_VISIBLE: The recorded cron result is available. This is not a new task.' };
    const base = { id: 'notice-model', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`); return;
  }
  const called = input.messages.slice(last + 1).filter(m => m.role === 'tool').length;
  const probe = JSON.stringify(input.messages[last]?.content).includes('Bounded platform readiness');
  const grantTurn = JSON.stringify(input.messages[last]?.content).includes('Create the node-local fixture grant only');
  const contractTurn = JSON.stringify(input.messages[last]?.content).includes('Propose fixture instruction revision');
  if (contractMode && !probe && !grantTurn && !contractTurn) {
    assert.match(JSON.stringify(input.messages.filter(m => m.role === 'system')), /REVISED_CONTRACT_FIXTURE/);
    assert.match(JSON.stringify(input.messages.filter(m => m.role === 'system')), /PINNED_PROTOCOL_FIXTURE/); revisedContextSeen = true;
  }
  if (agentGrantMode && !grantTurn && !contractTurn) assert.equal(Boolean(input.tools?.some(t => ['relay_headless_grant', 'relay_headless_revoke', 'relay_headless_connection'].includes(t.function.name))), false,
    'Headless workers must not acquire coordinator grant-management tools');
  if (!grantTurn && shellMode && !shellAllowed) {
    assert.equal(input.tools?.some(t => ['shell', 'relay_shell_call'].includes(t.function.name)), false, 'Denied shell must not be advertised');
    shellDeniedHidden = true;
  }
  const steps = contractTurn ? ['relay_headless_contract', 'relay_headless_contract'] : grantTurn ? ['relay_headless_grant'] : probe ? ['relay_headless_permissions', ...(capabilityMode ? ['relay_headless_capabilities'] : []), 'relay_work_submit'] :
    ['relay_mcp_tools', ...(!mcpDenied ? ['relay_mcp_call', 'relay_mcp_call'] : []), ...(shellAllowed ? ['relay_shell_call'] : []),
      ...(capabilityMode ? ['relay_headless_task', 'relay_headless_task', 'relay_headless_task'] : []), 'relay_work_submit'];
  const name = steps[called];
  const tool = name && input.tools?.find(t => t.function.name.endsWith(name));
  if (name && !tool) console.error(JSON.stringify({ missingTool: name, advertised: input.tools?.map(t => t.function.name) }));
  const taskStep = steps.slice(0, called).filter(step => step === 'relay_headless_task').length;
  const args = name === 'relay_headless_task' ? { key: taskStep === 0 ? 'schema-create' : 'schema-comment', operation: taskStep === 0 ? 'task.create' : 'comment.create',
    source: { namespace: 'external:record', externalId: 'native-schema-fixture' },
    payload: taskStep === 0 ? { title: 'Native operation-specific schema fixture' } : { taskId: `task_headless_${digest(['owner', 'external:record', 'native-schema-fixture'])}`,
      expectedRevision: 1, body: 'Only the valid comment may persist', ...(taskStep === 1 ? { reason: 'Unsupported field must fail before enqueue' } : {}) } } :
    name === 'relay_headless_contract' ? { ...contractProposal, operation: called === 0 ? 'preview' : 'request', ...(called === 1 ? { key: 'contract-once', previewHash: contractPreviewHash } : {}) } :
    name === 'relay_headless_grant' ? { key: 'grant-once', payload: grantProposal } : name === 'relay_mcp_call' ? { tool: called === 1 ? 'records_read' : 'actions_send', arguments: called === 1 ? { query: 'Fixture only' } : { recipient: 'fixture-only' },
    ...(capabilityMode ? { sourceNamespace: 'external:record' } : {}) } : name === 'relay_shell_call' ? { command: `printf '%s' 'shell-fixture' > '${shellOutput}'` } : ['relay_headless_capabilities', 'relay_headless_permissions', 'relay_mcp_tools'].includes(name) ? {} :
    { key: probe ? 'ready' : 'job', candidate: probe ? 'headless-readiness' : 'fixture-job', summary: 'Native capability and result submission verified.' };
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
  log = ''; daemon = spawn(process.execPath, [join(packageDirectory, 'src/node-cli.mjs'), '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', data => { log = (log + data).slice(-5000); });
  await wait('node startup', () => log.includes('"state":"running"'));
};
const stopNode = async () => {
  if (daemon && daemon.exitCode === null) { const child = daemon; daemon = null; const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
};
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const launchBackend = process.env.RELAY_PACKAGE_DIRECTORY ? (await import(pathToFileURL(join(packageDirectory, 'src/backend-service.mjs')))).startBackend : startBackend;
  backend = await launchBackend({ database: join(root, 'backend.sqlite') });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => owner('POST', '/v1/commands', { key, action, payload });
  const bundleFile = join(root, 'node.bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'setup-node', name: 'Fixture Surface', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile: join(state, 'node.json') });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: join(packageDirectory, 'packages/opencode-relay'), options: { workerDirectory: state } }],
      model: 'openai/fixture', compaction: { auto: false }, providers: { openai: { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' }, models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 512 } } } } },
      mcp: { servers: { records: { type: 'remote', url: `http://127.0.0.1:${mcp.address().port}/mcp`, oauth: false },
        ...(cronMode ? { actions: { type: 'remote', url: `http://127.0.0.1:${mcp.address().port}/mcp`, oauth: false } } : {}) } } } });
  const client = runtime.client;
  const integrations = (await client.integration.list({ location: { directory: workspace } })).data;
  const modelIntegration = integrations.find(i => i.id === 'openai');
  assert.ok(modelIntegration, `Fixture model integration missing; available IDs: ${integrations.map(i => i.id).join(',')}`);
  await client.integration.connect.key({ integrationID: modelIntegration.id, key: 'fixture-authorised-key', location: { directory: workspace } });
  const provider = (await client.provider.get({ providerID: 'openai', location: { directory: workspace } })).data;
  assert.ok(provider.integrationID, 'Fixture provider must expose an integration reference');
  const integration = (await client.integration.get({ integrationID: provider.integrationID, location: { directory: workspace } })).data;
  const connectionId = integration.connections.find(c => c.type === 'credential').id;
  await wait('existing MCP connection', async () => {
    const server = (await client.mcp.list({ location: { directory: workspace } })).data.find(s => s.name === 'records');
    if (server?.status.status === 'failed') throw Error('Fixture MCP transport failed');
    return server?.status.status === 'connected';
  });
  const session = await client.session.create({ location: { directory: workspace }, title: 'Fixture coordinator' });
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const dependencies = { discover: async () => ({ url: runtime.descriptor.origin, auth: { type: 'basic', username: 'opencode', password } }), makeClient: () => client };
  const coordinator = await enrolInteractive({ api: owner, backend: { url: backend.origin }, configFile: joined.configFile, directory: workspace,
    sessionId: session.id, reserved: true, transport: 'tools', name: 'Coordinator' }, dependencies);
  const registration = join(root, 'registration.json');
  // Use the existing service discovery contract rather than creating another HOME.
  const config = JSON.parse(readFileSync(joined.configFile));
  // Discovery may be injected by the fixture node through its standard registration file.
  writeFileSync(registration, JSON.stringify({ url: runtime.descriptor.origin, password, version: (await client.server.info()).version, pid: runtime.descriptor.pid }));
  config.headless = { serviceRegistration: registration }; writeFileSync(joined.configFile, JSON.stringify(config));
  grantProposal = { id: 'approved-job-grant', requesterAgentId: coordinator.agentId, nodeId: joined.nodeId, name: 'approved-worker', directory: workspace,
    model: { providerID: 'openai', id: 'fixture', integrationID: provider.integrationID, connectionId },
    permissions: { mcp: !mcpDenied, shell: shellAllowed }, contract: '.opencode/skills/approved-job/SKILL.md',
    schedule: { id: 'approved-job-weekdays', cron: cronMode ? '* * * * *' : '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none',
      ...(notificationMode ? { runResultNotifications: { inbox: true, requester: true } } : {}) },
    ...(capabilityMode ? { capabilities: { sourceNamespaces: ['external:record'], taskActions: ['task.create', 'task.update', 'comment.create', 'reference.attach'],
      artifacts: { receipts: 'artifacts/receipts', state: 'artifacts/state.json', history: 'artifacts/history', runs: 'artifacts/runs', summaries: 'artifacts/summaries' } } } : {}) };
  if (!agentGrantMode) await command('grant', 'headless.grant', grantProposal);
  await startNode(joined.configFile);
  const worker = workerConnection({ workerDirectory: state }, session.id);
  if (agentGrantMode) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await client.session.prompt({ sessionID: session.id, text: 'Create the node-local fixture grant only. Do not provision a worker, activate a schedule or run a job.' });
      await client.session.wait({ sessionID: session.id });
    }
    const grant = await owner('GET', '/v1/headless_grants/approved-job-grant');
    assert.equal(grant.state, 'active'); assert.equal(grant.revision, 1);
    assert.equal(grant.issuedBy.type, 'agent'); assert.equal(grant.issuedBy.agentId, coordinator.agentId);
    assert.equal(grant.issuedBy.nodeId, joined.nodeId);
    const snapshot = await owner('GET', '/v1/snapshot');
    assert.equal(snapshot.collections.headless_grant.length, 1);
    assert.equal(snapshot.collections.headless_setup.length, 0); assert.equal(snapshot.collections.schedule.length, 0);
    assert.equal(snapshot.collections.execution.length, 0); assert.equal(snapshot.collections.agent.length, 1);
  }
  const receipt = await call(worker, 'POST', '/agent/headless-setup', { key: 'setup-once', grantId: 'approved-job-grant' });
  assert.equal(receipt.state, 'recorded'); const id = receipt.receipt.id;
  const result = await waitHeadlessSetup(worker, receipt);
  assert.equal(result.state, 'ready', `Setup did not complete: ${result.blocker}`);
  assert.equal(reads, 0); assert.equal(writes, 0, 'Readiness must never execute external tools');
  assert.equal(existsSync(shellOutput), false, 'Readiness must never execute shell commands');
  assert.equal(result.restartRequired, false); assert.equal(result.appliedRevision, result.revision);
  const approvedSetup = await owner('GET', `/v1/headless_setups/${id}`);
  assert.notEqual(approvedSetup.sessionId, session.id);
  if (capabilityMode) {
    const setup = await owner('GET', `/v1/headless_setups/${id}`);
    assert.ok(setup.readiness.capabilities);
    const snapshot = await owner('GET', '/v1/snapshot');
    assert.equal(snapshot.collections.task.length, 1); assert.equal(snapshot.collections.comment.length, 0);
    assert.equal(snapshot.collections.task[0].title, 'Readiness: approved-worker');
    assert.equal(readFileSync(join(workspace, '.opencode/skills/approved-job/SKILL.md'), 'utf8'), 'Inspect the approved fixture only. Submit a native result.');
  }
  if (contractMode) {
    let legacyEvidence;
    if (legacyRefusalMode) {
      // Reproduce legacy transport evidence only in the disposable node journal.
      const historical = backend.store.all('execution').find(e => e.targetAgentId === approvedSetup.agentId && e.state === 'completed');
      assert.ok(historical);
      const command = { key: 'fixture-legacy-validation-refusal', action: 'headless.task', payload: {
        executionId: historical.id, runId: historical.runId, operation: 'comment.create', key: 'old-comment',
        source: { namespace: 'fixture', externalId: 'old-source' }, payload: { reason: 'Unsupported legacy field' },
      } };
      const db = new DatabaseSync(join(state, 'node.sqlite'));
      try {
        const item = { command, state: 'conflict', error: 'invalid_headless_request' };
        legacyEvidence = { key: command.key, hash: digest(command), state: item.state, data: JSON.stringify(item) };
        db.prepare('INSERT INTO outbox VALUES (?,?,?,?)').run(legacyEvidence.key, legacyEvidence.hash, legacyEvidence.state, legacyEvidence.data);
      } finally { db.close(); }
    }
    const beforeGrant = await owner('GET', '/v1/headless_grants/approved-job-grant'), beforeSchedule = await owner('GET', `/v1/schedules/${result.scheduleId}`);
    contractProposal = { setupId: id, files: [
      { path: grantProposal.contract, content: 'REVISED_CONTRACT_FIXTURE: Inspect only the fixture. Follow protocol.md and submit a native result.' },
      { path: '.opencode/skills/approved-job/protocol.md', content: 'PINNED_PROTOCOL_FIXTURE: Bounded candidate collection. Do not claim business completeness.' },
    ] };
    contractPreviewHash = (await call(worker, 'POST', '/agent/headless-contract-preview', contractProposal)).previewHash;
    await client.session.prompt({ sessionID: session.id, text: 'Propose fixture instruction revision. Preview then request approval only. Do not approve it yourself or run business tools.' });
    await client.session.wait({ sessionID: session.id });
    const requests = (await owner('GET', '/v1/grant_requests')).items.filter(r => r.kind === 'headless_contract');
    assert.equal(requests.length, 1); assert.equal(requests[0].state, 'awaiting_approval');
    assert.equal(readFileSync(join(workspace, grantProposal.contract), 'utf8'), 'Inspect the approved fixture only. Submit a native result.');
    const decisions = new NativeDecisionJournal();
    try {
      const board = nativeBoard(owner, { decisionJournal: decisions });
      const item = await board.detailGrant({ id: `request:${requests[0].id}` });
      await board.decideGrant({ item, key: 'human-instruction-revision', decision: 'approve_once' });
    } finally { decisions.close(); }
    await wait('approved contract activation', async () => (await call(worker, 'POST', '/agent/headless-status', { id })).appliedContractRevision === 1);
    const after = await owner('GET', `/v1/headless_setups/${id}`);
    for (const field of ['agentId', 'sessionId', 'bindingId', 'grantId', 'scheduleId']) assert.equal(after[field], approvedSetup[field]);
    assert.deepEqual(await owner('GET', '/v1/headless_grants/approved-job-grant'), beforeGrant);
    assert.deepEqual(await owner('GET', `/v1/schedules/${result.scheduleId}`), beforeSchedule);
    assert.equal(reads, 0); assert.equal(writes, 0, 'Approval and activation must not call external tools');
    if (legacyEvidence) {
      const db = new DatabaseSync(join(state, 'node.sqlite'), { readOnly: true });
      try { assert.deepEqual({ ...db.prepare('SELECT * FROM outbox WHERE key=?').get(legacyEvidence.key) }, legacyEvidence); }
      finally { db.close(); }
    }
  }
  if (rebindMode) {
    const beforeGrant = await owner('GET', '/v1/headless_grants/approved-job-grant');
    const beforeSetup = await owner('GET', `/v1/headless_setups/${id}`);
    const beforeSchedule = await owner('GET', `/v1/schedules/${result.scheduleId}`);
    const nodePid = daemon.pid, nativePid = (await client.server.info()).pid;
    // Replace only a disposable fixture sign-in through the native API. Never
    // enumerate secret credentials or change the user's authentication.
    await client.integration.connect.key({ integrationID: provider.integrationID, key: 'replacement-fixture-key', label: 'Replacement fixture sign-in', location: { directory: workspace } });
    const current = await wait('replacement sign-in identity', async () => {
      const { models } = await call(worker, 'POST', '/agent/headless-connections', {});
      return models.find(m => m.providerID === 'openai' && m.id === 'fixture' && m.connectionId !== connectionId);
    });
    const blocked = await call(worker, 'POST', '/agent/headless-status', { id });
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.blocker, 'model_connection_changed');
    const preview = await call(worker, 'POST', '/agent/headless-connection-preview', { setupId: id });
    assert.equal(preview.fromConnectionId, connectionId); assert.equal(preview.toConnectionId, current.connectionId);
    const payload = { setupId: id, previewHash: preview.previewHash, key: 'connection-once' };
    const applied = await call(worker, 'POST', '/agent/headless-connection-rebind', payload);
    assert.equal(applied.state, 'recorded');
    const ready = await waitHeadlessSetup(worker, applied);
    assert.equal(ready.state, 'ready', JSON.stringify(ready)); assert.ok(ready.nextFiring);
    assert.equal(ready.connectionRebind.state, 'ready');
    const afterGrant = await owner('GET', '/v1/headless_grants/approved-job-grant');
    const afterSetup = await owner('GET', `/v1/headless_setups/${id}`);
    assert.equal(afterGrant.model.connectionId, current.connectionId); assert.equal(afterGrant.revision, beforeGrant.revision + 1);
    for (const field of ['permissions', 'capabilities', 'contract', 'schedule', 'expiresAt']) assert.deepEqual(afterGrant[field], beforeGrant[field]);
    for (const field of ['agentId', 'sessionId', 'bindingId', 'grantId', 'scheduleId', 'contract', 'appliedContractRevision']) assert.deepEqual(afterSetup[field], beforeSetup[field]);
    assert.deepEqual(await owner('GET', `/v1/schedules/${result.scheduleId}`), beforeSchedule);
    await call(worker, 'POST', '/agent/headless-connection-rebind', payload);
    assert.equal((await owner('GET', `/v1/headless_setups/${id}`)).attempt, afterSetup.attempt);
    assert.equal(daemon.pid, nodePid); assert.equal((await client.server.info()).pid, nativePid);
    assert.equal(reads, 0); assert.equal(writes, 0, 'Connection readiness must not execute business tools');
    assert.equal(existsSync(shellOutput), false);
  }
  // A second server is configured after approval/setup. The boolean MCP grant
  // covers newly available tools without any per-server/tool grant amendment.
  if (!cronMode) {
  const nativeConfigPath = join(root, 'runtime/home/.config/opencode/opencode.json');
  const nativeConfig = JSON.parse(readFileSync(nativeConfigPath));
  nativeConfig.mcp.servers.actions = { type: 'remote', url: `http://127.0.0.1:${mcp.address().port}/mcp`, oauth: false };
  writeFileSync(nativeConfigPath, JSON.stringify(nativeConfig));
  await client.location.reload({ location: { directory: workspace } });
  }
  await wait('new MCP connection', async () => (await client.mcp.list({ location: { directory: workspace } })).data.some(server => server.name === 'actions' && server.status.status === 'connected'));
  if (cronMode) {
    const occurrence = await wait('actual headless cron completion', async () => {
      const items = (await owner('GET', '/v1/occurrences')).items.filter(item => item.scheduleId === result.scheduleId);
      if (items.some(item => item.state === 'failed')) throw Error(`Headless cron failed: ${JSON.stringify(items)}`);
      return items.find(item => item.state === 'completed');
    });
    const execution = await owner('GET', `/v1/executions/${occurrence.id}`);
    assert.equal(execution.headlessScheduled, true); assert.equal(execution.taskId, null);
    if (contractMode) assert.equal(execution.contractRevision, 1);
    assert.equal(execution.state, 'completed'); assert.equal(execution.targetConversationId, approvedSetup.sessionId);
    if (notificationMode) {
      const notice = (await owner('GET', '/v1/notifications')).items.find(item => item.kind === 'run_result' && item.occurrenceId === occurrence.id);
      assert.ok(notice); assert.equal(notice.summary, occurrence.summary); assert.equal(notice.requesterAgentId, coordinator.agentId);
      await wait('online requester receives recorded cron report', async () => JSON.stringify(await client.session.context({ sessionID: session.id })).includes('RUN_RESULT_VISIBLE'));
      assert.equal(runResultMessages, 1);
      assert.match(JSON.stringify(await client.session.context({ sessionID: session.id })), /Run result notifications authorise display and reads only/);
      assert.equal((await owner('GET', '/v1/snapshot')).collections.message.length, 0, 'No automatic reply or durable message queue');
      assert.equal((await owner('GET', '/v1/notifications')).items.length, 1, 'No readiness notification');
    }
    await command('pause-after-cron', 'schedule.pause', { id: result.scheduleId, expectedRevision: 1 });
    await wait('cron pause acknowledged', async () => (await owner('GET', `/v1/schedules/${result.scheduleId}`)).appliedRevision === 2);
  } else {
  const job = await command('job-task', 'task.create', { id: 'fixture-job-task', title: 'Exercise generic MCP permission' });
  await command('job-execution', 'execution.request', { id: 'fixture-job', taskId: job.id, taskRevision: job.revision, targetAgentId: result.agentId, instructions: 'Exercise the fixture job and submit its result.' });
   await wait('generic MCP job completion', async () => {
    const execution = await owner('GET', '/v1/executions/fixture-job');
    if (['failed', 'cancelled', 'rejected'].includes(execution.state)) throw Error(`Fixture job failed: ${JSON.stringify(execution)}`);
    return execution.state === 'completed';
   });
   if (contractMode) assert.equal((await owner('GET', '/v1/executions/fixture-job')).contractRevision, 1);
  }
  assert.equal(reads, mcpDenied ? 0 : 1); assert.equal(writes, mcpDenied ? 0 : 1);
  assert.equal(existsSync(shellOutput), shellAllowed);
  if (shellMode && !shellAllowed) assert.equal(shellDeniedHidden, true);
  if (shellAllowed) assert.equal(readFileSync(shellOutput, 'utf8'), 'shell-fixture');
  assert.ok(mcpSessions.every(sessionId => sessionId === approvedSetup.sessionId), 'MCP calls must retain the dedicated worker session context');
  if (capabilityMode) {
    const taskId = `task_headless_${digest(['owner', 'external:record', 'native-schema-fixture'])}`;
    assert.equal((await owner('GET', `/v1/comments?taskId=${taskId}`)).items.length, 1, 'Invalid comment must not persist');
    const transcript = await client.session.context({ sessionID: approvedSetup.sessionId });
    const rejected = transcript.filter(m => m.type === 'assistant').flatMap(m => m.content.filter(p => p.type === 'tool' && p.name === 'relay_headless_task' && p.state.input?.payload?.reason));
    assert.equal(rejected.length, 1); assert.equal(rejected[0].state.status, 'error');
  }
  const unchangedGrant = await owner('GET', '/v1/headless_grants/approved-job-grant');
  assert.equal(unchangedGrant.revision, rebindMode ? 2 : 1); assert.equal(unchangedGrant.permissions.mcp, !mcpDenied);
  if (contractMode) assert.equal(revisedContextSeen, true);
  await stopNode(); await startNode(joined.configFile);
  const restored = await call(worker, 'POST', '/agent/headless-status', { id });
  assert.equal(restored.agentId, result.agentId); assert.equal(restored.scheduleId, result.scheduleId); assert.equal(restored.appliedRevision, cronMode ? 2 : result.appliedRevision);
  const retry = await call(worker, 'POST', '/agent/headless-setup', { key: 'setup-once', grantId: 'approved-job-grant' });
  assert.equal(retry.receipt.id, id);
  assert.equal((await client.server.info()).pid, runtime.descriptor.pid);
  if (notificationMode) {
    const decisions = new NativeDecisionJournal();
    try {
      const board = nativeBoard(owner, { decisionJournal: decisions });
      const item = (await board.read()).inbox.find(item => item.kind === 'run_result');
      assert.ok(item, 'Persistent result remains unread after node restart');
      await board.decideInbox({ item, key: 'read-cron-result' });
      assert.equal((await board.read()).inbox.filter(item => item.kind === 'run_result').length, 0);
      assert.equal((await owner('GET', `/v1/occurrences/${item.occurrenceId}`)).state, 'completed');
      assert.equal(runResultMessages, 1, 'No requester replay on node restart');
    } finally { decisions.close(); }
  }
  if (agentGrantMode) {
    const revoked = await call(worker, 'POST', '/agent/headless-revoke', { key: 'revoke-once', payload: { id: 'approved-job-grant', expectedRevision: unchangedGrant.revision } });
    assert.equal(revoked.state, 'recorded'); assert.equal(revoked.receipt.state, 'revoked');
  } else await command('revoke', 'headless.revoke', { id: 'approved-job-grant', expectedRevision: unchangedGrant.revision });
  assert.equal((await owner('GET', '/v1/schedules/approved-job-weekdays')).definition.enabled, false);
  console.log(JSON.stringify({ passed: true, runtimeVersion: (await client.server.info()).version, singleCoordinatorSetup: true, existingAuthenticatedServiceReused: true, mcpAllowed: !mcpDenied,
    readCalls: reads, writeCalls: writes, shellAllowed, shellAttempted: shellAllowed, shellDeniedHidden, outsideWorkspaceShellWrite: existsSync(shellOutput), readinessHadNoExternalEffects: true, toolsAddedAfterSetupCovered: !cronMode,
    nativeResultSubmission: true, actualCronFiringVerified: cronMode, scheduleAppliedAndNextFiring: true, nodeRestartRetainedWorkerAndSchedule: true, revocationPausedSchedule: true, nodeRestartRequired: false,
    scopedTaskAndFileCanaries: capabilityMode, grantIssuedByCoordinatorWithoutOwner: agentGrantMode, agentGrantRetryIdempotent: agentGrantMode,
    exactContractApprovalAndActivation: contractMode, revisedInstructionsInNativeModelContext: revisedContextSeen,
    connectionRebindReadinessAndNextFiring: rebindMode, connectionRebindPreservedWorkerSessionScopeAndSchedule: rebindMode,
    legacyValidationRefusalDoesNotBlockActivation: legacyRefusalMode,
    operationSpecificHeadlessSchemasVerified: capabilityMode,
    persistentRunResultInboxVerified: notificationMode, onlineOnlyRequesterResultVerified: notificationMode,
    credentialsCopied: false, humanLoginRequired: false, userServicesTouched: false, fixture: root }, null, 2));
} finally {
  await stopNode();
  if (runtime) await runtime.stop(); if (backend) await backend.close();
  model.closeAllConnections(); mcp.closeAllConnections();
  await Promise.all([new Promise(resolve => model.close(resolve)), new Promise(resolve => mcp.close(resolve))]);
}
