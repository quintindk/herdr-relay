import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';
import { tickInteractive } from '../src/node-interactive.mjs';
import { interactiveAuthority } from '../src/interactive-contract.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { bootstrapNode } from '../src/node-bootstrap.mjs';
import { issueGrantApprovalSession } from '../src/grants.mjs';
import { createServer } from 'node:net';
import { tickAgentNotices } from '../src/node-notices.mjs';

function fixture(t, { managed = false } = {}) {
  const root = mkdtempSync('/tmp/opencode/native-interactive-');
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  const actors = {}, operators = {};
  for (const id of ['source', 'destination']) {
    const bundle = bootstrapNode(store, owner, { key: id, id, name: id, mode: 'roots', roots: [root], maxAgents: 25 });
    actors[id] = store.authenticate(bundle.nodeToken); operators[id] = store.authenticate(bundle.operatorToken);
  }
  command(owner, 'source-agent', 'agent.enrol', { id: 'initiator', nodeId: 'source', name: 'Initiator', directory: root });
  command(owner, 'source-attach', 'agent.attach', { id: 'initiator', expectedBindingRevision: 0, conversationId: 'ses_source', directory: root, bindingId: 'source-binding' });
  const grant = { id: 'grant', requesterAgentId: 'initiator', nodeId: 'destination', mode: 'roots', roots: [root],
    allowNewEnrolments: true, allowCreateDirectories: true, allowReplacement: true, allowDispatch: true, reviewPolicy: 'human', maxAgents: 10 };
  if (!managed) command(owner, 'grant', 'interactive.grant', grant);
  const request = command(actors.source, 'request', 'interactive.request', { id: 'preparation', ...(!managed ? { grantId: 'grant' } : {}), nodeId: 'destination',
    requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1,
    directory: join(root, 'discussion'), name: 'Discussion', createDirectory: true, topic: 'Discuss only the supplied topic.',
    ...(managed ? { permissionScope: { allowDispatch: true }, model: { id: 'inherited', providerID: 'fixture' } } : {}) });
  const journal = new NodeJournal(':memory:', { nodeId: 'destination', instanceId: store.instance });
  const receivers = new NativeReceivers(journal);
  if (!managed) receivers.put(`interactive-request:${request.id}`, request);
  const config = { nodeId: 'destination', stateDirectory: root, interactive: { mode: 'roots', roots: [root], herdrSocketPath: join(root, 'herdr.sock'),
    allowNewEnrolments: true, allowCreateDirectories: true, allowReplacement: true, model: { id: 'configured', providerID: 'fixture' } } };
  const f = { root, store, owner, actors, command, grant, request, journal, receivers, config, workspaceCreates: 0, starts: 0, nativeCreates: 0,
    view: { protocol: 22, workspaces: [], tabs: [], panes: [], agents: [] }, sessions: new Map() };
  f.approve = decision => {
    const ui = store.authenticate(issueGrantApprovalSession(store, operators.source, { terminalId: 'human' }).token);
    return command(ui, 'approve-managed', 'grant.request_decide', { id: request.id, expectedRevision: request.revision,
      requestHash: request.requestHash, decision });
  };
  f.apiFor = actor => async (method, path, body) => {
    if (method === 'POST') return store.command(actor, body);
    const url = new URL(path, 'http://test'), [, plural, id, suffix] = url.pathname.slice(1).split('/');
    if (suffix === 'authority') return interactiveAuthority(store, actor, id);
    const kind = plural.slice(0, -1);
    return id ? store.get(kind, id) : store.query(kind, Object.fromEntries([...url.searchParams].map(([k, v]) => [k, k === 'limit' ? Number(v) : v])));
  };
  f.api = f.apiFor(actors.destination);
  f.rpc = async (method, input) => {
    if (method === 'session.snapshot') return { snapshot: structuredClone(f.view) };
    if (method === 'workspace.rename') {
      if (f.failRename) throw Error('Naming unavailable');
      const workspace = f.view.workspaces.find(workspace => workspace.workspace_id === input.workspace_id);
      assert.ok(workspace); workspace.label = input.label;
      return { type: 'workspace_renamed', workspace };
    }
    if (method === 'workspace.create') {
      f.workspaceCreates++;
      const id = `w-test-${f.workspaceCreates}`;
      const workspace = { workspace_id: id, active_tab_id: `${id}:t1`, label: input.label };
      const tab = { workspace_id: id, tab_id: `${id}:t1` };
      const pane = { pane_id: `${id}:p1`, terminal_id: `terminal-${f.workspaceCreates}`, workspace_id: workspace.workspace_id, tab_id: tab.tab_id, cwd: input.cwd };
      f.view.workspaces.push(workspace); f.view.tabs.push(tab); f.view.panes.push(pane);
      if (f.revokeDuringWorkspace) command(owner, 'revoke', 'interactive.revoke', { id: 'grant', expectedRevision: 1 });
      if (f.loseWorkspaceReply) { f.loseWorkspaceReply = false; throw Object.assign(Error('lost workspace reply'), { code: 'herdr_uncertain' }); }
      return { type: 'workspace_created', workspace, tab, root_pane: pane };
    }
    if (method === 'agent.start') {
      f.starts++;
      assert.equal(input.args[0], '--session'); assert.ok(f.sessions.has(input.args[1]));
      const pane = f.view.panes.find(p => p.pane_id === input.pane_id);
      const agent = { ...pane, agent: 'opencode', name: input.name, interactive_ready: true, launch_pending: false,
        agent_session: { agent: 'opencode', kind: 'id', value: input.args[1] } };
      f.view.agents.push(agent); pane.agent = 'opencode';
      if (f.loseStartReply) { f.loseStartReply = false; throw Object.assign(Error('lost start reply'), { code: 'herdr_uncertain' }); }
      return { type: 'agent_started', agent };
    }
    throw Error(`Unexpected Herdr mutation: ${method}`);
  };
  f.native = async () => ({ url: 'http://127.0.0.1:1234', password: 'disposable', client: { session: {
    get: async ({ sessionID }) => {
      if (!f.sessions.has(sessionID)) throw Object.assign(Error('missing'), { status: 404 });
      return f.sessions.get(sessionID);
    }, create: async input => { f.nativeCreates++; const s = { ...input, projectID: 'global', time: { created: 1 } }; f.sessions.set(s.id, s); return s; },
  } } });
  f.resolve = async agentId => { const binding = receivers.resolve(agentId); return binding && { ...binding, native: { snapshot: async () => ({ idle: true, inbox: [], messages: [] }) } }; };
  f.tick = async () => {
    for (const r of store.all('provision_request')) receivers.put(`interactive-request:${r.id}`, r);
    await tickInteractive(journal, f.api, config, f.resolve, { rpc: f.rpc, native: f.native });
    return store.get('provision_request', request.id, false) ?? store.get('grant_request', request.id);
  };
  f.ready = async () => { for (let i = 0; i < 20; i++) { const r = await f.tick(); if (['ready', 'blocked'].includes(r.state)) return r; } throw Error(JSON.stringify(receivers.get(`interactive-op:${request.id}`))); };
  t.after(() => { journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('addressed interactive preparation opens an empty native chat, enrols/attaches and publishes exact placement without assigning work', async t => {
  const f = fixture(t), ready = await f.ready();
  assert.equal(ready.state, 'ready'); assert.equal(f.workspaceCreates, 1); assert.equal(f.starts, 1); assert.equal(f.nativeCreates, 1);
  assert.equal(ready.receipt.conversationId, f.request.desiredSessionId);
  assert.equal(f.view.workspaces[0].label, f.request.name);
  assert.equal(f.store.all('task').length, 0); assert.equal(f.store.all('execution').length, 0);
  assert.equal(f.sessions.get(f.request.desiredSessionId).metadata.relayDiscussionTopic, f.request.topic);
  assert.deepEqual(f.sessions.get(f.request.desiredSessionId).model, { id: 'configured', providerID: 'fixture' });
  assert.equal(f.receivers.get(`interactive-context:${ready.receipt.bindingId}`).authority, 'discussion_context_only');
  await f.tick(); assert.equal(f.starts, 1);
  assert.equal(JSON.stringify(ready).includes('disposable'), false);
});

test('human approval resumes the saved operation through Herdr, enrolment, attachment and separate permitted dispatch', async t => {
  const f = fixture(t, { managed: true });
  delete f.config.interactive;
  f.config.herdr = { socketPath: join(f.root, 'herdr.sock') };
  assert.equal((await f.tick()).state, 'awaiting_approval');
  assert.equal(existsSync(f.request.directory), false); assert.equal(f.workspaceCreates, 0); assert.equal(f.nativeCreates, 0);
  f.approve('approve_once');
  const ready = await f.ready();
  assert.equal(ready.state, 'ready'); assert.equal(f.workspaceCreates, 1); assert.equal(f.nativeCreates, 1); assert.equal(f.starts, 1);
  assert.equal(f.store.get('agent', ready.agentId).bindingId, ready.receipt.bindingId);
  assert.deepEqual(ready.receipt.model, { id: 'inherited', providerID: 'fixture' });
  assert.equal(f.store.all('execution').length, 0);
  const sourceJournal = new NodeJournal(':memory:', { nodeId: 'source', instanceId: f.store.instance });
  t.after(() => sourceJournal.close());
  sourceJournal.reconcileSnapshot(f.store.snapshot());
  const prompts = [], binding = { id: 'source-binding', conversationId: 'ses_source',
    native: { snapshot: async () => ({ idle: true, messages: [], inbox: [] }), send: async invocation => prompts.push(invocation.prompt) },
    observe: () => ({ state: 'finished', outcome: 'succeeded' }) };
  await tickAgentNotices(sourceJournal, f.apiFor(f.actors.source), async () => binding);
  assert.equal(prompts.length, 1); assert.match(prompts[0], /not a new human instruction/);
  const payload = { id: ready.id, requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1,
    taskId: 'bounded', executionId: 'bounded', title: 'Approved handover', instructions: 'Only the original authorised check.' };
  const execution = f.command(f.actors.source, 'managed-dispatch', 'interactive.dispatch', payload);
  assert.equal(execution.targetAgentId, ready.agentId); assert.equal(execution.reviewPolicy, 'human');
  await f.tick(); assert.deepEqual(f.command(f.actors.source, 'managed-dispatch', 'interactive.dispatch', payload), execution);
  assert.equal(f.store.all('execution').length, 1); assert.equal(f.starts, 1);
  sourceJournal.reconcileSnapshot(f.store.snapshot());
  await tickAgentNotices(sourceJournal, f.apiFor(f.actors.source), async () => binding);
  assert.equal(prompts.length, 1, 'Dispatch and snapshot recovery do not wake the requester twice');
});

test('managed permission waits without filesystem effects when no driver is known or its observation is offline', async t => {
  const f = fixture(t, { managed: true }); delete f.config.interactive;
  f.approve('allow_scope');
  assert.equal((await f.tick()).state, 'waiting_driver');
  assert.equal(existsSync(f.request.directory), false); assert.equal(f.starts, 0);
  f.config.herdr = { socketPath: join(f.root, 'herdr.sock') };
  const rpc = f.rpc; f.rpc = async () => { throw Error('Driver offline'); };
  assert.equal((await f.tick()).state, 'waiting_driver'); assert.equal(existsSync(f.request.directory), false);
  f.rpc = rpc;
  assert.equal((await f.ready()).state, 'ready');
});

test('verified enrolled TUI driver registration supplies managed provisioning without a legacy policy', async t => {
  const f = fixture(t, { managed: true }); delete f.config.interactive;
  const socket = join(f.root, 'verified.sock');
  let session = 'wrong-session';
  const server = createServer(connection => connection.on('data', data => {
    const request = JSON.parse(String(data));
    connection.end(`${JSON.stringify({ id: request.id, result: { snapshot: { protocol: 22,
      agents: [{ agent: 'opencode', agent_session: { kind: 'id', value: session } }] } } })}\n`);
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  const worker = { agentId: 'local-driver', sessionId: 'ses_driver', bindingId: 'driver-binding', bindingRevision: 1, token: 'driver-token' };
  f.receivers.put('receiver:local-driver', { state: 'active', bindingId: worker.bindingId, generation: 1 });
  const nodeSocket = join(f.root, 'driver-node.sock');
  const service = await startNodeService({ journal: f.journal, socketPath: nodeSocket, workers: [worker], api: f.api });
  t.after(async () => { await service.close(); await new Promise(resolve => server.close(resolve)); });
  const connection = { socketPath: nodeSocket, token: worker.token };
  await assert.rejects(call(connection, 'POST', '/agent/interactive-driver', { herdrSocketPath: socket }), { code: 'native_placement_mismatch' });
  assert.equal(f.receivers.list('interactive-driver').length, 0);
  session = worker.sessionId;
  assert.equal((await call(connection, 'POST', '/agent/interactive-driver', { herdrSocketPath: socket })).state, 'registered');
  f.approve('approve_once');
  assert.equal((await f.ready()).state, 'ready');
  assert.equal(f.receivers.get(`interactive-op:${f.request.id}`).driverSocket, socket);
});

test('ambiguous discovered drivers wait until explicitly selected, then remain pinned for recovery', async t => {
  const f = fixture(t, { managed: true }); delete f.config.interactive;
  for (const id of ['one', 'two']) {
    const socket = join(f.root, `${id}.sock`), server = createServer(connection => connection.end());
    await new Promise(resolve => server.listen(socket, resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    f.receivers.put(`interactive-driver:${id}`, { agentId: id, herdrSocketPath: socket });
  }
  f.approve('allow_scope');
  assert.equal((await f.tick()).state, 'waiting_driver'); assert.equal(existsSync(f.request.directory), false);
  f.config.herdr = { socketPath: join(f.root, 'two.sock') };
  await f.tick();
  assert.equal(f.receivers.get(`interactive-op:${f.request.id}`).driverSocket, f.config.herdr.socketPath);
  f.config.herdr.socketPath = join(f.root, 'one.sock');
  assert.equal((await f.ready()).state, 'ready');
  assert.equal(f.receivers.get(`interactive-op:${f.request.id}`).driverSocket, join(f.root, 'two.sock'));
});

test('provisioned workspace naming failure does not undo or duplicate the active attachment', async t => {
  const f = fixture(t); f.failRename = true;
  assert.equal((await f.ready()).state, 'ready');
  assert.equal(f.receivers.get(`interactive-op:${f.request.id}`).workspaceNameState, 'unconfirmed');
  assert.equal(f.receivers.receiver(f.request.agentId).state, 'active');
  await f.tick(); assert.equal(f.starts, 1); assert.equal(f.nativeCreates, 1);
});

for (const loss of ['loseWorkspaceReply', 'loseStartReply']) test(`${loss} reconciles exact observations without repeating Herdr effects`, async t => {
  const f = fixture(t); f[loss] = true;
  assert.equal((await f.ready()).state, 'ready');
  assert.equal(f.workspaceCreates, 1); assert.equal(f.starts, 1); assert.equal(f.nativeCreates, 1);
});

test('revocation during workspace creation prevents native launch and leaves partial resources for inspection', async t => {
  const f = fixture(t); f.revokeDuringWorkspace = true;
  const result = await f.ready();
  assert.equal(result.state, 'blocked'); assert.equal(f.workspaceCreates, 1); assert.equal(f.starts, 0);
  assert.equal(f.view.workspaces.length, 1);
});

test('lost committed attachment reconciles locally after grant revocation without publishing false readiness', async t => {
  const f = fixture(t), api = f.api;
  let lost = false;
  f.api = async (method, path, body) => {
    const result = await api(method, path, body);
    if (body?.action === 'interactive.attach' && !lost) {
      lost = true;
      f.command(f.owner, 'revoke-after-attach', 'interactive.revoke', { id: 'grant', expectedRevision: 1 });
      throw Error('Lost committed attachment reply');
    }
    return result;
  };
  for (let i = 0; i < 12 && !lost; i++) await f.tick();
  assert.ok(lost); assert.equal(f.receivers.receiver(f.request.agentId).state, 'pending');
  await f.journal.flush(f.api); await f.tick();
  assert.equal(f.receivers.receiver(f.request.agentId).state, 'active');
  assert.equal(f.store.get('provision_request', f.request.id).state, 'blocked');
  assert.equal(f.store.all('execution').length, 0);
});

test('a lost workspace request with no observation is never replayed, including after later cancellation', async t => {
  const f = fixture(t);
  const rpc = f.rpc;
  f.rpc = async (method, input) => { if (method === 'workspace.create') { f.workspaceCreates++; throw Object.assign(Error('lost'), { code: 'herdr_uncertain' }); } return rpc(method, input); };
  for (let i = 0; i < 9; i++) await f.tick();
  let request = f.store.get('provision_request', f.request.id);
  assert.equal(request.state, 'uncertain'); assert.equal(f.workspaceCreates, 1); assert.equal(f.starts, 0);
  f.command(f.owner, 'cancel', 'interactive.cancel', { id: request.id, expectedRevision: request.revision, reason: 'Stop fixture' });
  await f.tick(); assert.equal(f.workspaceCreates, 1);
});

test('readiness is separate from one bounded authorised dispatch and retains human review policy', async t => {
  const f = fixture(t); await f.ready();
  const payload = { id: f.request.id, requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1,
    taskId: 'bounded-task', executionId: 'bounded-execution', title: 'Bounded check', instructions: 'Do only this check.' };
  const execution = f.command(f.actors.source, 'dispatch', 'interactive.dispatch', payload);
  assert.equal(execution.reviewPolicy, 'human'); assert.equal(execution.targetAgentId, f.request.agentId);
  assert.equal(execution.originAgentId, 'initiator'); assert.equal(execution.allowDelegation, undefined);
  assert.deepEqual(f.command(f.actors.source, 'dispatch', 'interactive.dispatch', payload), execution);
  assert.throws(() => f.command(f.actors.source, 'dispatch-again', 'interactive.dispatch', payload), { code: 'provisioning_not_ready' });
  assert.equal(f.store.all('task').length, 1); assert.equal(f.store.all('execution').length, 1);
});

test('ensure reuses an existing interactive receiver, while explicit replacement creates a new binding without closing the old pane', async t => {
  const f = fixture(t), original = await f.ready();
  const ensure = f.command(f.actors.source, 'ensure', 'interactive.request', { id: 'ensure', grantId: 'grant', nodeId: 'destination',
    requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1, agentId: original.agentId });
  for (let i = 0; i < 12 && f.store.get('provision_request', ensure.id).state !== 'ready'; i++) await f.tick();
  const reused = f.store.get('provision_request', ensure.id);
  assert.equal(reused.state, 'ready'); assert.equal(reused.receipt.reused, true);
  assert.equal(reused.receipt.bindingId, original.receipt.bindingId);
  assert.equal(f.workspaceCreates, 1); assert.equal(f.starts, 1);
  f.command(f.actors.source, 'replace', 'interactive.request', { id: 'replace', grantId: 'grant', nodeId: 'destination',
    requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1, agentId: original.agentId, instance: 'replace' });
  for (let i = 0; i < 14 && f.store.get('provision_request', 'replace').state !== 'ready'; i++) await f.tick();
  const replacement = f.store.get('provision_request', 'replace');
  assert.equal(replacement.state, 'ready'); assert.equal(replacement.receipt.generation, 2);
  assert.notEqual(replacement.receipt.conversationId, original.receipt.conversationId);
  assert.equal(f.view.agents.length, 2); assert.equal(f.store.all('agent').filter(a => a.nodeId === 'destination').length, 1);
  assert.equal(f.receivers.resolve(original.agentId, { bindingId: original.receipt.bindingId }).identity.sessionId, original.receipt.conversationId);
});

test('a changed receiver after readiness refuses dispatch without creating a task', async t => {
  const f = fixture(t), ready = await f.ready();
  f.command(f.owner, 'replace-outside', 'agent.attach', { id: ready.agentId, expectedBindingRevision: 1,
    conversationId: 'ses_elsewhere', directory: f.request.directory, bindingId: 'elsewhere' });
  assert.throws(() => f.command(f.actors.source, 'stale-work', 'interactive.dispatch', { id: f.request.id, requesterAgentId: 'initiator',
    sourceConversationId: 'ses_source', sourceBindingRevision: 1, taskId: 'task', executionId: 'execution', title: 'Check', instructions: 'Check' }), { code: 'stale_binding' });
  assert.equal(f.store.all('task').length, 0);
});

test('new sessions pin the inherited requester model, and existing sessions retain their human-selected model', async t => {
  const f = fixture(t);
  delete f.config.interactive.model;
  const request = f.store.get('provision_request', f.request.id);
  // Fixture seed represents the source connector's verified native-model capture.
  f.store.save('provision_request', { ...request, model: { id: 'gpt-6.1-sol', providerID: 'github-copilot', variant: 'high' } });
  const ready = await f.ready();
  assert.deepEqual(ready.receipt.model, { id: 'gpt-6.1-sol', providerID: 'github-copilot', variant: 'high' });
  const session = f.sessions.get(ready.receipt.conversationId);
  session.model = { id: 'human-choice', providerID: 'fixture' };
  f.command(f.actors.source, 'keep-human-model', 'interactive.request', { id: 'keep-human-model', grantId: 'grant', nodeId: 'destination',
    requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1, agentId: ready.agentId });
  for (let i = 0; i < 12 && f.store.get('provision_request', 'keep-human-model').state !== 'ready'; i++) await f.tick();
  assert.deepEqual(f.store.get('provision_request', 'keep-human-model').receipt.model, { id: 'human-choice', providerID: 'fixture' });
  assert.equal(f.nativeCreates, 1);
});

test('source and destination authority cannot be widened or granted by a node credential', async t => {
  const f = fixture(t);
  assert.throws(() => f.command(f.actors.source, 'self-grant', 'interactive.grant', { ...f.grant, id: 'self' }), { code: 'forbidden' });
  assert.throws(() => f.command(f.actors.destination, 'foreign-source', 'interactive.request', { ...f.request, id: 'foreign' }), { code: 'invalid_request' });
  assert.throws(() => f.command(f.actors.source, 'outside', 'interactive.request', { id: 'outside', grantId: 'grant', nodeId: 'destination',
    requesterAgentId: 'initiator', sourceConversationId: 'ses_source', sourceBindingRevision: 1, directory: '/outside', name: 'Outside' }), { code: 'provisioning_directory_forbidden' });
  assert.throws(() => f.command(f.actors.destination, 'raw-enrol', 'agent.enrol', { id: 'raw', nodeId: 'destination', name: 'Raw', directory: f.root }), { code: 'forbidden' });
});

test('node-local scoped tools forward through the backend even when the source and destination share a physical host', async t => {
  const f = fixture(t);
  const sourceJournal = new NodeJournal(':memory:', { nodeId: 'source', instanceId: f.store.instance });
  sourceJournal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:initiator', JSON.stringify({ state: 'active', bindingId: 'source-binding', generation: 1 }));
  const socketPath = join(f.root, 'source.sock');
  const worker = { agentId: 'initiator', sessionId: 'ses_source', bindingId: 'source-binding', bindingRevision: 1, token: 'worker' };
  const service = await startNodeService({ journal: sourceJournal, socketPath, workers: [worker], api: f.apiFor(f.actors.source) });
  t.after(async () => { await service.close(); sourceJournal.close(); });
  const connection = { socketPath, token: 'worker' };
  assert.equal((await call(connection, 'POST', '/agent/interactive-grants', {})).items.length, 1);
  assert.equal((await call(connection, 'POST', '/agent/interactive-status', { id: f.request.id })).state, 'requested');
  await assert.rejects(call(connection, 'POST', '/agent/interactive-prepare', { key: 'spoof', payload: { id: 'spoof', requesterAgentId: 'foreign' } }), { code: 'invalid_request' });
  sourceJournal.save({ id: 'job', bindingId: worker.bindingId, nativeConversationId: worker.sessionId, state: 'observing', execution: { state: 'accepted', targetAgentId: worker.agentId } });
  const preparation = await call(connection, 'POST', '/agent/interactive-prepare', { key: 'during-work', payload: {
    id: 'during-work', grantId: 'grant', nodeId: 'destination', directory: join(f.root, 'during-work'), name: 'During work' } });
  assert.equal(preparation.state, 'recorded');
  assert.equal(preparation.receipt.state, 'requested');
  assert.equal(f.store.all('execution').length, 0, 'Preparation does not dispatch another execution');
});
