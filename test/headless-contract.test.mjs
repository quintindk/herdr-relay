import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { headlessAuthority, headlessProbeId } from '../src/headless-setup-contract.mjs';
import { digest } from '../src/protocol.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { inspectContract, tickHeadlessContractUpdates } from '../src/node-headless-contract.mjs';
import { buildGrantsView } from '../src/grants-view.mjs';
import { nativeBoard } from '../src/native-board.mjs';

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/contract-revisions-'), store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token), command = (key, action, payload, actor = owner) => store.command(actor, { key, action, payload });
  command('node', 'node.enrol', { id: 'node', name: 'Surface' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  command('coordinator', 'agent.enrol', { id: 'mason', nodeId: 'node', directory: root, name: 'Mason' });
  command('attach', 'agent.attach', { id: 'mason', expectedBindingRevision: 0, conversationId: 'coordinator-session', directory: root, bindingId: 'coordinator-binding' });
  const contract = '.opencode/skills/sweep/SKILL.md', protocol = '.opencode/skills/sweep/protocol.md';
  mkdirSync(join(root, '.opencode/skills/sweep'), { recursive: true }); writeFileSync(join(root, contract), 'Approved instructions');
  const grant = command('grant', 'headless.grant', { id: 'grant', requesterAgentId: 'mason', nodeId: 'node', name: 'sweep', directory: root,
    model: { providerID: 'provider', id: 'model', integrationID: 'auth', connectionId: 'connection' }, permissions: { mcp: true, shell: false }, contract,
    schedule: { id: 'sweep', cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } });
  let setup = command('setup', 'headless.request', { grantId: grant.id, requesterAgentId: 'mason', sourceConversationId: 'coordinator-session', sourceBindingRevision: 1 }, node);
  const agent = command('register', 'headless.register', { id: setup.id }, node);
  command('advertise', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: setup.sessionId, bindingRevision: 1 }, node);
  const probe = command('probe', 'headless.probe', { id: setup.id }, node);
  const completed = store.save('execution', { ...probe, revision: probe.revision + 1, state: 'completed', result: { candidate: 'headless-readiness' } });
  store.event('execution.completed', completed, node, 'fixture-native-completion');
  setup = command('activate', 'headless.activate', { id: setup.id, receipt: { nativeTerminalId: 'idle', permissionsToolCallId: 'permission', permissions: grant.permissions, accessDigest: 'access' } }, node);
  command('ack', 'schedule.acknowledge', { id: 'sweep', expectedRevision: 1 }, node);
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:mason', JSON.stringify({ state: 'active', bindingId: 'coordinator-binding', generation: 1 }));
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run(`headless-op:${setup.id}`, JSON.stringify({ phase: 'ready', contractDigest: digest('Approved instructions') }));
  const api = async (method, path, body) => {
    if (method === 'POST') return store.command(node, body);
    if (path.startsWith('/v1/events')) return store.events({ cursor: new URL(path, 'http://local').searchParams.get('cursor') ?? undefined });
    if (path.endsWith('/authority')) return headlessAuthority(store, node, path.split('/')[3]);
    const [, , collection, id] = path.split('/'); return store.get(collection.slice(0, -1), id);
  };
  await journal.poll(api);
  const worker = { agentId: 'mason', sessionId: 'coordinator-session', bindingId: 'coordinator-binding', bindingRevision: 1, socketPath: join(root, 'node.sock'), token: 'worker' };
  const service = await startNodeService({ journal, api, socketPath: worker.socketPath, workers: [worker], getBackendFeatures: async () => ({ headlessContractRevisions: true, headlessSetup: true }) });
  const f = { root, store, owner, node, command, grant, setup, journal, api, worker, contract, protocol, idle: true };
  f.candidates = [{ path: contract, content: 'Separate bounded email, Teams and calendar queries. Follow protocol.md.' }, { path: protocol, content: 'Candidates first. Check original messages and later replies. Use available tools only. Report gaps.' }];
  f.preview = (files = f.candidates) => call(worker, 'POST', '/agent/headless-contract-preview', { setupId: setup.id, files });
  f.request = async (key = 'v1', files = f.candidates) => {
    const preview = await f.preview(files);
    const body = { setupId: setup.id, files, key, previewHash: preview.previewHash };
    return { preview, body, request: (await call(worker, 'POST', '/agent/headless-contract-request', body)).receipt };
  };
  f.approve = request => command(`approve-${request.id}`, 'grant.request_decide', { id: request.id, expectedRevision: request.revision, requestHash: request.requestHash, decision: 'approve_once' });
  f.tick = async () => { await journal.poll(api); await tickHeadlessContractUpdates(journal, api, async () => ({ id: setup.bindingId, native: { snapshot: async () => ({ messages: [], idle: f.idle, inbox: [] }) } })); };
  t.after(async () => { await service.close(); journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('exact instruction approval resumes at idle, pins cron revision and preserves all worker/grant/schedule identities', async t => {
  const f = await fixture(t), beforeGrant = f.store.get('headless_grant', 'grant'), beforeSchedule = f.store.get('schedule', 'sweep');
  const { request, body } = await f.request();
  assert.equal(request.kind, 'headless_contract'); assert.equal(request.state, 'awaiting_approval');
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
  const view = buildGrantsView({ requests: [request] });
  assert.equal(view.pending[0].kind, 'headless_contract'); assert.ok(view.pending[0].actions.some(s => s.includes('Candidates first')));
  assert.throws(() => f.command('self-approve', 'grant.request_decide', { id: request.id, expectedRevision: 1, requestHash: request.requestHash, decision: 'approve_once' }, f.node), { code: 'forbidden' });
  f.approve(request);
  f.idle = false; await f.tick();
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
  const intendedAt = '2026-10-27T08:00:00.000Z', id = `occurrence_${digest(['sweep', intendedAt])}`;
  const admission = { id, scheduleId: 'sweep', definitionRevision: 1, intendedAt, targetAgentId: f.setup.agentId,
    bindingId: f.setup.bindingId, conversationId: f.setup.sessionId, runId: `run_${digest(id)}` };
  assert.throws(() => f.command('pending-admit', 'schedule.admit', admission, f.node), { code: 'contract_activation_pending' });
  f.idle = true; await f.tick();
  const updated = f.store.get('headless_setup', f.setup.id);
  assert.equal(updated.appliedContractRevision, 1); assert.equal(updated.contractActivation.state, 'applied');
  assert.deepEqual(f.store.get('headless_grant', 'grant'), beforeGrant); assert.deepEqual(f.store.get('schedule', 'sweep'), beforeSchedule);
  for (const field of ['id', 'agentId', 'sessionId', 'bindingId', 'grantId', 'grantRevision', 'scheduleId']) assert.equal(updated[field], f.setup[field]);
  const inspected = inspectContract(f.journal, updated, beforeGrant);
  assert.equal(inspected.contractRevision, 1); assert.equal(inspected.contractDigest, updated.contract.digest);
  assert.match(inspected.contractInstructions, /Candidates first/);
  await call(f.worker, 'POST', '/agent/headless-contract-request', body);
  assert.equal(f.store.all('grant_request').length, 1, 'Original retry cannot create a new update or reset activation');
  const execution = f.command('new-admit', 'schedule.admit', admission, f.node);
  assert.equal(execution.contractRevision, 1); assert.equal(execution.contractDigest, updated.contract.digest);
});

test('stale preview, symlinks, capability fields and changed live content cannot be approved or overwritten', async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  await assert.rejects(call(f.worker, 'POST', '/agent/headless-contract-request', { setupId: f.setup.id, files: f.candidates, key: 'bad', previewHash: 'wrong' }), { code: 'stale_contract_preview' });
  await assert.rejects(f.preview([{ path: '../outside.md', content: 'Bad' }]), { code: 'invalid_contract_update' });
  const link = join(f.root, '.opencode/skills/sweep/link.md'); symlinkSync(join(f.root, f.contract), link);
  await assert.rejects(f.preview([...f.candidates, { path: '.opencode/skills/sweep/link.md', content: 'Redirected' }]), { code: 'job_contract_missing' });
  const { request } = await f.request();
  assert.throws(() => f.command('expanded', 'grant.request_decide', { id: request.id, expectedRevision: 1, requestHash: request.requestHash, decision: 'allow_scope', scope: { permissions: { shell: true } } }), { code: 'invalid_grant_decision' });
  f.approve(request);
  writeFileSync(join(f.root, f.contract), 'Unapproved human edit'); await f.tick();
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Unapproved human edit');
  assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 0);
  assert.throws(() => inspectContract(f.journal, f.setup, f.grant), { code: 'job_contract_changed' });
  assert.equal(preview.previewHash, request.requestHash);
});

test('crash-partial activation converges to approved bytes, and explicit rollback is another exact revision', async t => {
  const f = await fixture(t), { request } = await f.request(); f.approve(request);
  const opKey = `headless-op:${f.setup.id}`, op = JSON.parse(f.journal.db.prepare('SELECT value FROM settings WHERE key=?').get(opKey).value);
  f.journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ ...op, contractActivation: { state: 'applying', requestId: request.id } }), opKey);
  writeFileSync(join(f.root, f.contract), f.candidates[0].content);
  await f.tick(); assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 1);
  const rollbackFiles = [{ path: f.contract, content: 'Approved instructions' }, f.candidates[1]];
  const rollback = await f.request('rollback', rollbackFiles); f.approve(rollback.request); await f.tick();
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
  assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 2);
  assert.equal(f.store.all('headless_grant').length, 1); assert.equal(f.store.all('headless_setup').length, 1);
  assert.equal(f.store.all('grant_decision').length, 2);
});

test('revocation and unsettled work fence activation without running a model or changing a contract', async t => {
  const f = await fixture(t), { request } = await f.request(); f.approve(request);
  f.journal.save({ id: 'busy', state: 'uncertain', execution: { id: 'busy', state: 'accepted', targetAgentId: f.setup.agentId } });
  await f.tick(); assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
  f.journal.save({ ...f.journal.work('busy'), state: 'native_finished', execution: { ...f.journal.work('busy').execution, state: 'failed' } });
  f.command('revoke', 'headless.revoke', { id: 'grant', expectedRevision: f.grant.revision });
  await f.tick(); assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
  assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 0);
});

test('lost activation acknowledgement reconciles the original key without rewriting content or duplicating a revision', async t => {
  const f = await fixture(t), { request } = await f.request(); f.approve(request);
  let lost = false;
  await f.journal.poll(f.api);
  const api = async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (body?.action === 'headless.contract_applied' && !lost) { lost = true; throw Error('Lost committed acknowledgement'); }
    return result;
  };
  const resolve = async () => ({ id: f.setup.bindingId, native: { snapshot: async () => ({ messages: [], idle: true, inbox: [] }) } });
  await tickHeadlessContractUpdates(f.journal, api, resolve);
  const key = `contract-applied:${f.setup.id}:1`, original = f.journal.receipt(key).command;
  assert.equal(f.journal.receipt(key).state, 'pending'); assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 1);
  await tickHeadlessContractUpdates(f.journal, f.api, resolve);
  assert.equal(f.journal.receipt(key).state, 'recorded'); assert.deepEqual(f.journal.receipt(key).command, original);
  assert.equal(f.store.get('headless_setup', f.setup.id).contract.revision, 1); assert.equal(f.store.all('grant_request').length, 1);
});

test('approval cannot reuse a stale setup/grant preview or introduce capability changes', async t => {
  const f = await fixture(t), { request } = await f.request();
  assert.throws(() => f.command('expanded-request', 'headless.contract_request', { ...request.operation, id: 'expanded', previewHash: request.requestHash,
    requesterAgentId: 'mason', sourceConversationId: 'coordinator-session', sourceBindingRevision: 1, permissions: { shell: true } }, f.node), { code: 'invalid_contract_update' });
  f.command('revoke', 'headless.revoke', { id: 'grant', expectedRevision: 1 });
  assert.throws(() => f.approve(request), { code: 'headless_grant_inactive' });
  assert.equal(f.store.get('grant_request', request.id).state, 'awaiting_approval');
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
});

test('work requested before approval drains under its old revision instead of deadlocking instruction activation', async t => {
  const f = await fixture(t);
  f.command('pending-task', 'task.create', { id: 'pending-task', title: 'Previously requested work' });
  const requested = f.command('pending-run', 'execution.request', { id: 'pending-run', taskId: 'pending-task', taskRevision: 1,
    targetAgentId: f.setup.agentId, instructions: 'Existing bounded work' });
  const { request } = await f.request(); f.approve(request); await f.tick();
  assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 0);
  const admitted = f.command('admit-existing', 'execution.admit', { id: requested.id, expectedRevision: requested.revision,
    bindingId: f.setup.bindingId, runId: 'existing-run' }, f.node);
  assert.equal(admitted.contractRevision, 0); assert.equal(admitted.contractDigest, request.operation.fromDigest);
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved instructions');
  f.command('settle-existing', 'execution.settle', { id: admitted.id, expectedRevision: admitted.revision, outcome: 'failed', evidence: 'Isolated fixture terminal only' }, f.node);
  await f.tick(); assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, 1);
});

for (const mode of ['legacy_refusal', 'uncertain', 'revision_conflict', 'tampered_hash', 'unrelated']) test(`contract activation classifies historical publications without deleting evidence: ${mode}`, async t => {
  const f = await fixture(t), { request } = await f.request(); f.approve(request);
  f.journal.save({ id: 'old-sweep', state: 'settled', execution: { id: 'old-sweep', state: 'completed', targetAgentId: f.setup.agentId } });
  const command = { key: 'old-publication', action: 'headless.task', payload: { executionId: mode === 'unrelated' ? 'other-agent-run' : 'old-sweep',
    id: 'not-an-execution', operation: 'comment.create', payload: { reason: 'Unsupported legacy field' } } };
  const item = { ...f.journal.queue(command), state: 'conflict', error: mode === 'revision_conflict' ? 'stale_revision' : 'invalid_headless_request',
    ...(mode === 'uncertain' ? { outcome: 'uncertain', effectsUncertain: true } : {}) };
  f.journal.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(item.state, JSON.stringify(item), command.key);
  if (mode === 'tampered_hash') f.journal.db.prepare('UPDATE outbox SET hash=? WHERE key=?').run('changed', command.key);
  const before = f.journal.db.prepare('SELECT * FROM outbox WHERE key=?').get(command.key);
  await f.tick();
  const allowed = ['legacy_refusal', 'unrelated'].includes(mode);
  assert.equal(f.store.get('headless_setup', f.setup.id).appliedContractRevision, allowed ? 1 : 0);
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM outbox WHERE key=?').get(command.key), before);
  if (!allowed) {
    const status = await call(f.worker, 'POST', '/agent/headless-status', { id: f.setup.id });
    assert.equal(status.contractActivation.wait.reason, 'unresolved_publication');
    assert.deepEqual(status.contractActivation.wait.publicationKeys, ['old-publication']);
  }
});

test('activation reports the exact work, binding and native-input waits and clears them after success', async t => {
  const f = await fixture(t), { request } = await f.request(); f.approve(request);
  f.journal.save({ id: 'old-run', state: 'terminal_unresolved', execution: { id: 'old-run', state: 'completed', targetAgentId: f.setup.agentId } });
  await f.tick();
  const status = () => call(f.worker, 'POST', '/agent/headless-status', { id: f.setup.id });
  assert.deepEqual((await status()).contractActivation.wait.executionIds, ['old-run']);
  f.journal.save({ ...f.journal.work('old-run'), state: 'settled' });
  await tickHeadlessContractUpdates(f.journal, f.api, async () => null);
  assert.equal((await status()).contractActivation.wait.reason, 'worker_binding_unavailable');
  await tickHeadlessContractUpdates(f.journal, f.api, async () => ({ id: f.setup.bindingId, native: { snapshot: async () => ({ idle: true, inbox: [{}] }) } }));
  assert.equal((await status()).contractActivation.wait.reason, 'native_input_pending');
  f.idle = false; await f.tick();
  assert.equal((await status()).contractActivation.wait.reason, 'native_session_busy');
  f.idle = true; await f.tick();
  assert.equal((await status()).contractActivation.wait, null);
});

test('Schedule exposes approved/unapplied contract state rather than a false active next-run preview', async t => {
  const f = await fixture(t), { request } = await f.request(); f.approve(request);
  const board = nativeBoard(async (method, path) => {
    assert.equal(method, 'GET');
    if (path === '/v1/info') return { userId: 'owner', instanceId: f.store.instance };
    const [, , collection, id] = path.split('?')[0].split('/'), kind = collection.slice(0, -1);
    return id ? f.store.get(kind, id) : { items: f.store.all(kind) };
  });
  const state = (await board.read()).routines[0];
  assert.equal(state.state, 'awaiting_contract_activation'); assert.equal(state.nextRunAt, null);
  assert.match(state.delivery.reason, /revision 1, applied 0/);
  assert.equal((await board.detailRoutine({ scheduleId: 'sweep' })).state, state.state);
  await f.tick();
  assert.equal((await board.read()).routines[0].state, 'active');
});
