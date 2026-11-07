// Real OpenCode tools and receiving sessions, native backend/HTTP admission and
// human Grants transport. Herdr placement is a fixture here. The separate real
// Herdr panel gate exercises keyboard repair and revocation. No live context is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';

process.umask(0o077);
const scratch = resolve(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(scratch, 'relay-interactive-recovery-')), workspace = join(root, 'source'), state = join(root, 'node');
for (const directory of [workspace, state]) mkdirSync(directory);
const packageDirectory = resolve(process.env.RELAY_PACKAGE_DIRECTORY ?? '.');
const load = path => import(pathToFileURL(join(packageDirectory, path)).href);
const { startBackend } = await load('src/backend-service.mjs');
const { nativeBackendClient } = await load('src/backend-client.mjs');
const { bootstrapNode } = await load('src/node-bootstrap.mjs');
const { NodeJournal } = await load('src/node-journal.mjs');
const { NativeReceivers } = await load('src/native-receivers.mjs');
const { startNodeService } = await load('src/node-service.mjs');
const { tickInteractive } = await load('src/node-interactive.mjs');
const { nativeBoard } = await load('src/native-board.mjs');
const { NativeDecisionJournal } = await load('src/native-decision-journal.mjs');
const { interactiveRepairPreview } = await load('src/interactive-repair.mjs');
const { NativeOpenCodeV2 } = await load('packages/opencode-relay/native.mjs');
const { call } = await load('src/client.mjs');
let runtime, backend, journal, service, decisions, nodeId, repairPreview, ready;
let mode = 'prepare';
const lab = join(root, 'lab');
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), last = input.messages.findLastIndex(message => message.role === 'user');
  const step = input.messages.slice(last + 1).filter(message => message.role === 'tool').length;
  const name = mode === 'repair' ? 'relay_interactive_repair' : mode === 'dispatch' ? 'relay_interactive_dispatch' : 'relay_interactive_prepare';
  const tool = input.tools?.find(tool => tool.function.name === name);
  const count = ['repair', 'dispatch'].includes(mode) ? 2 : 1;
  const args = mode === 'repair' ? step === 0 ? { operation: 'preview', id: 'lab' } : {
    operation: 'request', key: 'repair-original', id: 'repair-lab', preparationId: 'lab', expectedRevision: repairPreview.expectedRevision,
    scope: repairPreview.scope, previewHash: repairPreview.previewHash, reason: 'Correct the node-wide ceiling without creating another agent.' } :
    mode === 'dispatch' ? { key: 'dispatch-once', payload: { id: 'lab', taskId: 'captured-task', taskRevision: 1, executionId: 'captured-execution', instructions: 'Only the captured fixture task.' } } :
      { key: mode === 'prepare' ? 'original-prepare' : 'corrected-prepare', payload: { id: mode === 'prepare' ? 'lab' : 'corrected', nodeId,
        directory: lab, name: mode === 'prepare' ? 'Lab' : 'Scope matching fixture', createDirectory: true,
        permissionScope: { maxAgents: mode === 'prepare' ? 1 : 13, allowDispatch: true } } };
  const calling = step < count && tool;
  const delta = calling ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${mode}-${step}`, type: 'function',
    function: { name: tool.function.name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Fixture complete.' };
  const base = { id: 'recovery-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calling ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = backend.store.authenticate(backend.store.bootstrap().token);
  const bundle = bootstrapNode(backend.store, owner, { key: 'fixture', id: 'node', name: 'Recovery fixture', mode: 'roots', roots: [root], maxAgents: 100 });
  nodeId = bundle.nodeId;
  const operator = nativeBackendClient({ url: backend.origin, token: bundle.operatorToken }), api = operator.withToken(bundle.nodeToken);
  const command = (key, action, payload) => api('POST', '/v1/commands', { key, action, payload });
  for (let i = 0; i < 12; i++) await operator('POST', '/v1/commands', { key: `agent-${i}`, action: 'agent.enrol', payload: {
    id: i === 0 ? 'source' : `existing-${i}`, name: i === 0 ? 'Source' : `Existing ${i}`, nodeId, directory: i === 0 ? workspace : join(root, `existing-${i}`) } });
  const task = await operator('POST', '/v1/commands', { key: 'captured-task', action: 'task.create', payload: { id: 'captured-task', title: 'Captured compatibility fixture' } });
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: join(packageDirectory, 'packages/opencode-relay'), options: { workerDirectory: state } }],
      model: 'fixture/fixture', compaction: { auto: false }, providers: { fixture: { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' },
        models: { fixture: { name: 'Fixture', limit: { context: 16384, output: 512 } } } } } } });
  const source = await runtime.client.session.create({ location: { directory: workspace }, title: 'Human recovery source', model: { providerID: 'fixture', id: 'fixture' } });
  const nativePassword = JSON.parse(readFileSync(join(root, 'runtime/auth.json'), 'utf8')).password;
  await operator('POST', '/v1/commands', { key: 'attach-source', action: 'agent.attach', payload: { id: 'source', expectedBindingRevision: 0,
    conversationId: source.id, bindingId: 'source-binding', directory: workspace } });
  const socketPath = join(state, 'node.sock'), workerFile = join(state, 'source-worker.json');
  const worker = { agentId: 'source', sessionId: source.id, bindingId: 'source-binding', bindingRevision: 1, socketPath, token: 'isolated-worker' };
  writeFileSync(workerFile, JSON.stringify(worker)); writeFileSync(join(state, 'worker-index.json'), JSON.stringify({ sessions: { [source.id]: workerFile } }));
  journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId, instanceId: backend.store.instance });
  const records = new NativeReceivers(journal);
  records.put('receiver:source', { state: 'active', bindingId: worker.bindingId, generation: 1 });
  service = await startNodeService({ journal, socketPath, workers: [worker], api,
    getBackendFeatures: async () => (await api('GET', '/v1/info')).features,
    getNativeModel: async () => (await runtime.client.session.get({ sessionID: source.id })).model });
  decisions = new NativeDecisionJournal(join(root, 'human-decisions.sqlite'));
  const board = nativeBoard(operator, { decisionJournal: decisions });
  const prompt = async text => {
    await runtime.client.session.prompt({ sessionID: source.id, text }); await runtime.client.session.wait({ sessionID: source.id });
    const messages = await runtime.client.session.context({ sessionID: source.id });
    const tools = messages.filter(message => message.type === 'assistant').flatMap(message => message.content.filter(part => part.type === 'tool'));
    assert.ok(tools.length && tools.every(tool => tool.state.status === 'completed'), JSON.stringify(tools));
    return tools;
  };
  await prompt('Request the one isolated lab agent. Capture only. Do not dispatch any task.');
  const original = await board.detailGrant({ id: 'request:lab' });
  await board.decideGrant({ item: original, key: 'allow-original', decision: 'allow_scope' });
  const view = { protocol: 22, workspaces: [], tabs: [], panes: [], agents: [] };
  let workspaceCreates = 0, starts = 0;
  const rpc = async (method, input) => {
    if (method === 'session.snapshot') return { snapshot: structuredClone(view) };
    if (method === 'workspace.create') {
      workspaceCreates++;
      const workspace = { workspace_id: 'fixture-workspace', label: input.label }, tab = { workspace_id: workspace.workspace_id, tab_id: 'fixture-tab' };
      const pane = { workspace_id: workspace.workspace_id, tab_id: tab.tab_id, pane_id: 'fixture-pane', terminal_id: 'fixture-terminal', cwd: input.cwd };
      view.workspaces.push(workspace); view.tabs.push(tab); view.panes.push(pane);
      return { type: 'workspace_created', workspace, tab, root_pane: pane };
    }
    if (method === 'agent.start') {
      starts++; const pane = view.panes.find(p => p.pane_id === input.pane_id);
      view.agents.push({ ...pane, agent: 'opencode', interactive_ready: true, launch_pending: false,
        agent_session: { kind: 'id', value: input.args[1] } });
      return { type: 'agent_started' };
    }
    if (method === 'workspace.rename') { view.workspaces[0].label = input.label; return { type: 'workspace_renamed' }; }
    throw Error(`Unexpected fixture operation ${method}`);
  };
  const tick = async () => {
    await journal.poll(api);
    await tickInteractive(journal, api, { nodeId, stateDirectory: state, herdr: { socketPath: join(root, 'herdr-fixture.sock') } }, async agentId => {
      const binding = records.resolve(agentId);
      return binding && { ...binding, native: new NativeOpenCodeV2(runtime.client, binding.identity) };
    }, { rpc, native: async () => ({ url: runtime.descriptor.origin, password: nativePassword, client: runtime.client }) });
    return api('GET', '/v1/provision_requests/lab');
  };
  let waiting = await tick();
  assert.equal(waiting.state, 'waiting_capacity'); assert.equal(waiting.checkpoint.safe, true); assert.equal(existsSync(lab), false);
  assert.equal(workspaceCreates, 0); assert.equal(starts, 0);
  mode = 'corrected-prepare'; await prompt('Request the independent scope-matching fixture with ceiling 13. Do not approve it or start work.');
  const corrected = await api('GET', '/v1/grant_requests/corrected');
  assert.equal(corrected.state, 'awaiting_approval'); assert.equal(corrected.grantSelection.selectedGrantId, null);
  assert.ok(corrected.grantSelection.considered.some(item => item.reasons.includes('node_ceiling_below_requested')));
  repairPreview = interactiveRepairPreview(backend.store, owner, { id: 'lab' });
  mode = 'repair'; await prompt('Preview a linked repair of the original lab preparation and request approval of that exact correction. Keep the original agent, task and directory.');
  await board.decideGrant({ item: await board.detailGrant({ id: 'request:repair-lab' }), key: 'approve-repair', decision: 'approve_once' });
  for (let i = 0; i < 24; i++) { ready = await tick(); if (ready.state === 'ready') break; assert.notEqual(ready.state, 'blocked', JSON.stringify(ready)); }
  assert.equal(ready.state, 'ready'); assert.equal(workspaceCreates, 1); assert.equal(starts, 1);
  const receiving = await runtime.client.session.get({ sessionID: ready.receipt.conversationId });
  assert.equal(receiving.metadata.relayProvisionRequest, 'lab'); assert.equal(receiving.location.directory, lab);
  assert.equal(ready.repairHistory[0].state, 'waiting_capacity'); assert.equal(backend.store.all('provision_request').length, 1);
  mode = 'dispatch'; await prompt('Dispatch the existing captured fixture task once to the repaired agent. Reconcile the same key a second time, never create another task or execution.');
  const executions = (await api('GET', '/v1/executions')).items;
  assert.equal(executions.length, 1); assert.equal(executions[0].targetAgentId, ready.agentId);
  assert.deepEqual(await api('GET', '/v1/tasks/captured-task'), task); assert.equal(backend.store.all('task').length, 1);
  const raceScope = { mode: 'roots', roots: [root], profiles: ['build'], maxAgents: 14, allowNewEnrolments: true,
    allowCreateDirectories: true, allowReplacement: false, allowDispatch: false, reviewPolicy: 'human' };
  await board.createGrant({ key: 'race-permission', payload: { id: 'race-permission', requesterAgentId: 'source', nodeId, scope: raceScope } });
  const races = [];
  for (const id of ['race-a', 'race-b']) races.push(await command(id, 'interactive.request', { id, nodeId, directory: join(root, id), name: id,
    grantId: 'race-permission', createDirectory: true, requesterAgentId: 'source', sourceConversationId: source.id, sourceBindingRevision: 1 }));
  const reservations = await Promise.all(races.map(request => command(`reserve-${request.id}`, 'interactive.reserve', { id: request.id, expectedRevision: request.revision })));
  assert.deepEqual(reservations.map(r => r.admission.state).sort(), ['reserved', 'waiting']);
  await assert.rejects(operator('POST', '/v1/commands', { key: 'steal-slot', action: 'agent.enrol', payload: { id: 'steal', nodeId, directory: join(root, 'steal'), name: 'Steal' } }), { code: 'agent_limit' });
  assert.equal(races.some(request => existsSync(request.directory)), false);
  for (const request of reservations) {
    const result = await call({ socketPath, token: worker.token }, 'POST', '/agent/interactive-cancel', { key: `cancel-${request.id}`,
      payload: { id: request.id, expectedRevision: request.revision, reason: 'End capacity fixture' } });
    assert.equal(result.state, 'recorded'); const cancelled = result.receipt;
    await command(`inspect-${request.id}`, 'interactive.repair_checkpoint', { id: request.id, expectedRevision: cancelled.revision,
      checkpoint: { protocol: 1, safe: true, phase: 'initial', unresolved: [] } });
  }
  await board.decideGrant({ item: await board.detailGrant({ id: 'interactive:race-permission' }), key: 'revoke-race' });
  assert.equal(backend.store.get('provision_grant', 'race-permission').state, 'revoked');
  console.log(JSON.stringify({ passed: true, runtime: (await runtime.client.server.info()).version,
    realModelToolTurn: true, scopedAgentTools: true, insufficientGrantQueuedApproval: true, admissionBeforeFilesystemEffects: true,
    linkedRepairApproved: true, originalPreparationRetained: true, realReceivingSessionVerified: true, existingTaskDispatchIdempotent: true,
    concurrentCapacityReservationVerified: true, ordinaryEnrolmentCannotStealReservation: true, humanGrantRevocationVerified: true,
    herdrPlacementFixture: true, userServicesTouched: false, credentialsCopied: false, fixture: root }, null, 2));
} finally {
  await runtime?.stop(); await service?.close(); journal?.close(); decisions?.close(); await backend?.close();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
