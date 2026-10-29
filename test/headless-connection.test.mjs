import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { headlessAuthority, headlessProbeId } from '../src/headless-setup-contract.mjs';
import { connectionRebindCommand } from '../src/node-headless-connection.mjs';
import { tickHeadlessSetups } from '../src/node-headless-setup.mjs';
import { tickAutomation, reconcileScheduleDefinitions } from '../src/node-automation.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/headless-connection-'), store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (key, action, payload, actor = owner) => store.command(actor, { key, action, payload });
  command('node', 'node.enrol', { id: 'surface', name: 'Surface' });
  const node = store.authenticate(store.enrolCredential(owner, 'surface', 'node').token);
  command('coordinator', 'agent.enrol', { id: 'mason', nodeId: 'surface', name: 'Mason', directory: root });
  command('attach', 'agent.attach', { id: 'mason', expectedBindingRevision: 0, conversationId: 'coordinator-session', directory: root, bindingId: 'coordinator-binding' });
  const contract = '.opencode/skills/sweep/SKILL.md';
  mkdirSync(join(root, '.opencode/skills/sweep'), { recursive: true }); writeFileSync(join(root, contract), 'Approved sweep instructions');
  const grant = command('grant', 'headless.grant', { id: 'surface-inbox-sweep', requesterAgentId: 'mason', nodeId: 'surface', name: 'sweep', directory: root,
    model: { providerID: 'github-copilot', id: 'gpt-6.1-sol', integrationID: 'github-copilot', connectionId: 'old-sign-in' },
    permissions: { mcp: true, shell: false }, contract,
    schedule: { id: 'sweep', cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none', runResultNotifications: { inbox: true, requester: true } } });
  let setup = command('setup', 'headless.request', { grantId: grant.id, requesterAgentId: 'mason', sourceConversationId: 'coordinator-session', sourceBindingRevision: 1 }, node);
  const agent = command('register', 'headless.register', { id: setup.id }, node);
  command('advertise', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: setup.sessionId, bindingRevision: 1 }, node);
  const firstProbe = command('probe', 'headless.probe', { id: setup.id }, node);
  const completed = store.save('execution', { ...firstProbe, revision: firstProbe.revision + 1, state: 'completed', result: { candidate: 'headless-readiness' } });
  store.event('execution.completed', completed, node, 'fixture-completion');
  setup = command('activate', 'headless.activate', { id: setup.id, receipt: { nativeTerminalId: 'old-idle', permissionsToolCallId: 'old-permissions', permissions: grant.permissions, accessDigest: 'old-access' } }, node);
  command('ack', 'schedule.acknowledge', { id: 'sweep', expectedRevision: 1 }, node);
  const journal = new NodeJournal(':memory:', { nodeId: 'surface', instanceId: store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:mason', JSON.stringify({ state: 'active', bindingId: 'coordinator-binding', generation: 1 }));
  const identity = { sessionId: setup.sessionId, projectId: 'project', directory: root, createdAt: 1234 };
  const binding = { id: setup.bindingId, agentId: setup.agentId, identity, url: 'http://127.0.0.1:1234', headlessSetupId: setup.id,
    sessionPermissions: [{ action: '*', resource: '*', effect: 'deny' }] };
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run(`headless-op:${setup.id}`, JSON.stringify({ binding, attempt: 1, phase: 'ready', contractDigest: digest('Approved sweep instructions') }));
  const api = async (method, path, body) => {
    if (method === 'POST') return store.command(node, body);
    if (path === '/v1/info') return { features: { headlessConnectionRebind: true, headlessSetup: true, scheduledHeadlessAdmission: true, headlessContractRevisions: true } };
    if (path.startsWith('/v1/events')) return store.events({ cursor: new URL(path, 'http://fixture').searchParams.get('cursor') ?? undefined });
    if (path.endsWith('/authority')) return headlessAuthority(store, node, path.split('/')[3]);
    const [, , collection, id] = path.split('/'); return store.get(collection.slice(0, -1), decodeURIComponent(id));
  };
  await journal.poll(api); reconcileScheduleDefinitions(journal); await journal.flush(api);
  journal.save({ id: firstProbe.id, state: 'settled', execution: completed });
  const f = { root, store, owner, node, command, grant, setup, journal, api, binding, contract, active: 'current-sign-in', idle: true, access: true, modelAvailable: true, sends: 0 };
  const client = { session: {
    get: async () => ({ id: identity.sessionId, projectID: identity.projectId, location: { directory: root }, time: { created: identity.createdAt }, model: { providerID: grant.model.providerID, id: grant.model.id } }),
    active: async () => f.idle ? {} : { [identity.sessionId]: {} }, inbox: { list: async () => [] },
    create: () => assert.fail('Never create another worker session'), update: () => assert.fail('Never change session permissions or model'),
  }, message: { list: async () => ({ data: [], cursor: { next: null } }) }, rpc: () => ({
    inspect: async () => ({ models: f.modelAvailable ? [{ ...grant.model, connectionId: f.active }] : [], servers: [] }),
    check: async refs => ({ allowed: f.access && refs.model.connectionId === f.active, blocker: f.access ? 'model_connection_changed' : 'model_connection_unavailable', accessDigest: digest(refs), mcpToolIds: [] }),
  }) };
  f.native = async () => ({ client, url: binding.url });
  const worker = { agentId: 'mason', sessionId: 'coordinator-session', bindingId: 'coordinator-binding', bindingRevision: 1, socketPath: join(root, 'node.sock'), token: 'worker' };
  const service = await startNodeService({ journal, api, socketPath: worker.socketPath, workers: [worker], getBackendFeatures: async () => (await api('GET', '/v1/info')).features,
    getHeadlessRecoveryConnection: f.native, getHeadlessAccess: async () => {
      assert.equal(store.get('headless_grant', grant.id).model.connectionId, f.active); return {};
    } });
  Object.assign(f, { worker, preview: () => call(worker, 'POST', '/agent/headless-connection-preview', { setupId: setup.id }),
    apply: async (preview, key = 'rebind') => call(worker, 'POST', '/agent/headless-connection-rebind', { setupId: setup.id, previewHash: preview.previewHash, key }),
    tick: async () => { await journal.poll(api); await tickHeadlessSetups(journal, api, { identityVersion: 2 }, async entry => {
      assert.deepEqual(entry, binding); return binding;
    }, async () => ({ ...binding, native: { snapshot: async () => f.probeSnapshot } }), { native: f.native }); },
  });
  f.completeProbe = () => {
    const current = store.get('headless_setup', setup.id), probe = store.get('execution', headlessProbeId(current));
    const completed = store.save('execution', { ...probe, revision: probe.revision + 1, state: 'completed', result: { candidate: 'headless-readiness' } });
    store.event('execution.completed', completed, node, 'fixture-new-completion');
    journal.save({ id: probe.id, bindingId: binding.id, state: 'native_finished', execution: completed,
      invocation: { messageId: 'probe-user' }, observation: { state: 'finished', outcome: 'succeeded', messageId: 'probe-idle' } });
    f.probeSnapshot = { idle: true, inbox: [], messages: [{ id: 'probe-user', type: 'user' }, { id: 'assistant', type: 'assistant', content: [
      { type: 'tool', id: 'permission-proof', name: 'relay_headless_permissions', state: { status: 'completed', content: [{ type: 'text', text: 'Granted permission inspection only' }], metadata: { headlessPermissions: grant.permissions, headlessSetupId: setup.id } } },
      { type: 'tool', name: 'relay_work_submit', state: { status: 'completed' } },
    ] }, { id: 'probe-idle', type: 'idle' }] };
  };
  t.after(async () => { await service.close(); journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('connection recovery preserves the existing worker, native session, permissions, instructions, cron and reporting', async t => {
  const f = await fixture(t), beforeGrant = structuredClone(f.grant), beforeSetup = structuredClone(f.setup), beforeSchedule = f.store.get('schedule', 'sweep');
  const failed = { id: 'failed-business-run', state: 'settled', execution: { id: 'failed-business-run', state: 'failed', targetAgentId: f.setup.agentId },
    invocation: { messageId: 'original-failed-prompt', runId: 'failed-run', prompt: 'Do not replay this business work' }, observation: { state: 'finished', outcome: 'failed', messageId: 'failed-idle' } };
  f.journal.save(failed);
  const before = f.journal.db.prepare('SELECT * FROM work WHERE id=?').get(failed.id);
  const preview = await f.preview();
  assert.equal(preview.fromConnectionId, 'old-sign-in'); assert.equal(preview.toConnectionId, 'current-sign-in');
  assert.equal(f.store.get('headless_grant', f.grant.id).revision, 1, 'Preview is read-only');
  const receipt = await f.apply(preview); assert.equal(receipt.state, 'recorded');
  const rebound = f.store.get('headless_setup', f.setup.id), grant = f.store.get('headless_grant', f.grant.id);
  assert.equal(grant.model.connectionId, f.active); assert.equal(grant.revision, 2); assert.equal(rebound.grantRevision, 2);
  assert.equal(rebound.state, 'requested'); assert.equal(rebound.attempt, 2);
  f.command('business-task', 'task.create', { id: 'business-task', title: 'Must not start during readiness' });
  assert.throws(() => f.command('business-request', 'execution.request', { id: 'business-request', taskId: 'business-task', taskRevision: 1,
    targetAgentId: f.setup.agentId, instructions: 'Must wait for readiness' }), { code: 'headless_not_ready' });
  for (const field of ['id', 'agentId', 'sessionId', 'bindingId', 'grantId', 'scheduleId', 'contract', 'appliedContractRevision']) assert.deepEqual(rebound[field], beforeSetup[field]);
  for (const field of ['permissions', 'capabilities', 'contract', 'schedule', 'expiresAt', 'issuedBy', 'directory', 'requesterAgentId']) assert.deepEqual(grant[field], beforeGrant[field]);
  assert.deepEqual(f.store.get('schedule', 'sweep'), beforeSchedule);
  await f.tick(); await f.tick(); f.completeProbe(); await f.tick();
  const ready = f.store.get('headless_setup', f.setup.id);
  assert.equal(ready.state, 'ready'); assert.equal(ready.connectionRebind.state, 'ready');
  assert.equal(ready.readiness.nativeTerminalId, 'probe-idle');
  assert.deepEqual(f.store.get('schedule', 'sweep'), beforeSchedule, 'Readiness must not reinstall or revise the schedule');
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM work WHERE id=?').get(failed.id), before);
  assert.equal(readFileSync(join(f.root, f.contract), 'utf8'), 'Approved sweep instructions');
  assert.equal(f.store.all('headless_grant').length, 1); assert.equal(f.store.all('headless_setup').length, 1);
  const retry = await f.apply(preview); assert.deepEqual(retry, receipt);
  assert.equal(f.store.get('headless_setup', f.setup.id).attempt, 2);
  const status = await call(f.worker, 'POST', '/agent/headless-status', { id: f.setup.id });
  assert.equal(status.state, 'ready'); assert.ok(Date.parse(status.nextFiring) > Date.now());
});

test('rebind preview and apply reject stale sign-ins, scope changes, native activity and unsettled publications', async t => {
  const f = await fixture(t), preview = await f.preview();
  f.active = 'another-sign-in'; await assert.rejects(f.apply(preview), { code: 'stale_connection_preview' });
  f.active = 'current-sign-in'; f.idle = false; await assert.rejects(f.preview(), { code: 'headless_rebind_busy' });
  f.idle = true; f.modelAvailable = false; await assert.rejects(f.preview(), { code: 'model_connection_unavailable' });
  f.modelAvailable = true;
  const payload = connectionRebindCommand(preview);
  assert.throws(() => f.command('expand', 'headless.connection_rebind', { ...payload, permissions: { shell: true } }), { code: 'invalid_connection_rebind' });
  f.journal.save({ id: 'uncertain', state: 'uncertain', execution: { state: 'failed', targetAgentId: f.setup.agentId } });
  await assert.rejects(f.preview(), { code: 'headless_rebind_busy' });
  f.journal.save({ id: 'uncertain', state: 'settled', execution: { state: 'failed', targetAgentId: f.setup.agentId } });
  f.journal.queue({ key: 'uncertain-write', action: 'headless.task', payload: { executionId: 'uncertain' } });
  await assert.rejects(f.preview(), { code: 'headless_rebind_busy' });
  assert.equal(f.store.get('headless_grant', f.grant.id).model.connectionId, 'old-sign-in');
});

test('backend fences wrong coordinators, revocation, stale schedule revisions and unsettled executions atomically', async t => {
  const f = await fixture(t), preview = await f.preview(), payload = connectionRebindCommand(preview);
  assert.throws(() => f.command('node-bypass', 'headless.connection_rebind', payload, f.node), { code: 'forbidden' });
  assert.throws(() => f.command('wrong-chat', 'agent.headless_connection_rebind', { agentId: 'mason', conversationId: 'other', bindingRevision: 1, payload }, f.node), { code: 'headless_requester_scope' });
  f.store.save('execution', { id: 'active', revision: 1, state: 'accepted', targetAgentId: f.setup.agentId });
  assert.throws(() => f.command('active', 'headless.connection_rebind', payload), { code: 'headless_rebind_busy' });
  f.store.save('execution', { id: 'active', revision: 2, state: 'failed', targetAgentId: f.setup.agentId });
  f.command('pause', 'schedule.pause', { id: 'sweep', expectedRevision: 1 });
  assert.throws(() => f.command('stale-schedule', 'headless.connection_rebind', payload), { code: 'stale_revision' });
  f.command('revoke', 'headless.revoke', { id: f.grant.id, expectedRevision: 1 });
  assert.throws(() => f.command('revoked', 'headless.connection_rebind', payload), { code: 'headless_grant_inactive' });
  assert.equal(f.store.get('headless_grant', f.grant.id).model.connectionId, 'old-sign-in');
});

test('lost committed rebind replies reconcile the same key without another attempt or credential change', async t => {
  const f = await fixture(t), preview = await f.preview();
  const original = f.journal.flush.bind(f.journal); let lost = false;
  f.journal.flush = async api => original(async (method, path, body) => {
    const result = await api(method, path, body);
    if (body?.action === 'agent.headless_connection_rebind' && !lost) { lost = true; throw Error('Lost committed reply'); }
    return result;
  });
  await assert.rejects(f.apply(preview), { code: 'node_error' });
  assert.equal(f.journal.receipt('connection-rebind:mason:rebind').state, 'pending');
  assert.equal(f.store.get('headless_setup', f.setup.id).attempt, 2);
  assert.equal((await f.apply(preview)).state, 'recorded');
  assert.equal(f.store.get('headless_setup', f.setup.id).attempt, 2);
  assert.equal(f.store.get('headless_grant', f.grant.id).revision, 2);
});

test('readiness failure keeps the original schedule fenced and paused settings are never resumed', async t => {
  const f = await fixture(t);
  f.command('pause', 'schedule.pause', { id: 'sweep', expectedRevision: 1 });
  const before = f.store.get('schedule', 'sweep'), preview = await f.preview();
  await f.apply(preview); f.access = false; await f.tick();
  assert.equal(f.store.get('headless_setup', f.setup.id).state, 'blocked');
  assert.deepEqual(f.store.get('schedule', 'sweep'), before);
  f.access = true;
  f.command('retry-readiness', 'headless.request', { grantId: f.grant.id, requesterAgentId: 'mason', sourceConversationId: 'coordinator-session', sourceBindingRevision: 1, retry: true }, f.node);
  await f.tick(); await f.tick(); f.completeProbe(); await f.tick();
  assert.equal(f.store.get('headless_setup', f.setup.id).state, 'ready');
  assert.deepEqual(f.store.get('schedule', 'sweep'), before);
  assert.equal((await call(f.worker, 'POST', '/agent/headless-status', { id: f.setup.id })).nextFiring, null);
});

test('connection recovery skips pre-readiness pending ticks and backend admission rejects their replay', async t => {
  const f = await fixture(t), preview = await f.preview(); await f.apply(preview);
  const local = JSON.parse(f.journal.db.prepare('SELECT data FROM schedules WHERE id=?').get('sweep').data);
  const intendedAt = new Date(Date.now() - 30000).toISOString(), id = `occurrence_${digest(['sweep', intendedAt])}`;
  const occurrence = { id, scheduleId: 'sweep', intendedAt, definition: local.definition, state: 'pending' };
  f.journal.db.prepare('INSERT INTO occurrences VALUES (?,?,?,?)').run(id, 'sweep', 'pending', JSON.stringify(occurrence));
  const binding = { ...f.binding, native: { send: () => assert.fail('Never replay an old tick'), snapshot: async () => ({ idle: true, inbox: [], messages: [] }) } };
  await tickAutomation(f.journal, async () => binding, Date.now(), f.api);
  assert.equal(JSON.parse(f.journal.db.prepare('SELECT data FROM occurrences WHERE id=?').get(id).data).admission.reason, 'connection_readiness_pending');
  await f.tick(); await f.tick(); f.completeProbe(); await f.tick();
  await tickAutomation(f.journal, async () => binding, Date.now(), f.api);
  assert.equal(JSON.parse(f.journal.db.prepare('SELECT data FROM occurrences WHERE id=?').get(id).data).state, 'skipped');
  assert.equal(f.journal.work(id), null);
  const admission = { id, scheduleId: 'sweep', definitionRevision: 1, intendedAt, targetAgentId: f.setup.agentId,
    bindingId: f.setup.bindingId, conversationId: f.setup.sessionId, runId: `run_${digest(id)}` };
  assert.throws(() => f.command('old-admission', 'schedule.admit', admission, f.node), { code: 'headless_occurrence_stale' });
  const nextAt = JSON.parse(f.journal.db.prepare('SELECT data FROM schedules WHERE id=?').get('sweep').data).nextAt;
  const nextId = `occurrence_${digest(['sweep', nextAt])}`;
  const next = f.command('new-admission', 'schedule.admit', { ...admission, id: nextId, intendedAt: nextAt, runId: `run_${digest(nextId)}` }, f.node);
  assert.equal(next.state, 'accepted'); assert.equal(next.grantRevision, 2);
});
