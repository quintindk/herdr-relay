import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { headlessAuthority, headlessProbeId, headlessRunAuthority, headlessAccessBlockers } from '../src/headless-setup-contract.mjs';
import { assertHeadlessAccess, tickHeadlessSetups } from '../src/node-headless-setup.mjs';
import { checkHeadlessAccess } from '../packages/opencode-relay/headless-access.mjs';
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
    if (path === '/v1/headless/read') return headlessRunAuthority(store, node, body);
    if (method === 'POST') return store.command(node, body);
    if (path === '/v1/info') return { features: { activeProviderConnections: true, headlessSetup: true, scheduledHeadlessAdmission: true, headlessContractRevisions: true } };
    if (path.startsWith('/v1/events')) return store.events({ cursor: new URL(path, 'http://fixture').searchParams.get('cursor') ?? undefined });
    if (path.endsWith('/authority')) return headlessAuthority(store, node, path.split('/')[3]);
    const [, , collection, id] = path.split('/'); return store.get(collection.slice(0, -1), decodeURIComponent(id));
  };
  await journal.poll(api); reconcileScheduleDefinitions(journal); await journal.flush(api);
  journal.save({ id: firstProbe.id, state: 'settled', execution: completed });
  const f = { root, store, owner, node, command, grant, setup, journal, api, binding, contract, active: 'current-sign-in',
    integrationID: grant.model.integrationID, idle: true, access: true, modelAvailable: true, sends: 0 };
  const accessContext = { session: { hook() {}, update() {} }, tool: { hook() {}, list: async () => [] },
    provider: { get: async () => ({ data: { integrationID: f.integrationID } }) },
    integration: { connection: { active: async () => f.access ? { type: 'credential', id: f.active } : null } },
    model: { list: async () => ({ data: f.modelAvailable ? [{ providerID: grant.model.providerID, id: grant.model.id }] : [] }) },
    mcp: { list: async () => ({ data: [] }) } };
  const client = { session: {
    get: async () => ({ id: identity.sessionId, projectID: identity.projectId, location: { directory: root }, time: { created: identity.createdAt }, model: { providerID: grant.model.providerID, id: grant.model.id } }),
    active: async () => f.idle ? {} : { [identity.sessionId]: {} }, inbox: { list: async () => [] },
    create: () => assert.fail('Never create another worker session'), update: () => assert.fail('Never change session permissions or model'),
  }, message: { list: async () => ({ data: [], cursor: { next: null } }) }, rpc: () => ({
    inspect: async () => ({ models: f.modelAvailable ? [{ ...grant.model, connectionId: f.active }] : [], servers: [] }),
    check: refs => checkHeadlessAccess(accessContext, refs),
  }) };
  f.native = async () => ({ client, url: binding.url });
  const worker = { agentId: 'mason', sessionId: 'coordinator-session', bindingId: 'coordinator-binding', bindingRevision: 1, socketPath: join(root, 'node.sock'), token: 'worker' };
  const service = await startNodeService({ journal, api, socketPath: worker.socketPath, workers: [worker], getBackendFeatures: async () => (await api('GET', '/v1/info')).features,
    getHeadlessAccess: () => assertHeadlessAccess(api, client, setup.id, root) });
  Object.assign(f, { client, worker,
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

test('active provider authentication changes need no rebind, idle boundary, clean outbox or live coordinator', async t => {
  const f = await fixture(t);
  const before = { grant: f.store.get('headless_grant', f.grant.id), setup: f.store.get('headless_setup', f.setup.id), schedule: f.store.get('schedule', 'sweep') };
  f.journal.db.prepare("DELETE FROM settings WHERE key='receiver:mason'").run();
  f.idle = false;
  f.store.save('execution', { id: 'existing-business', revision: 1, state: 'accepted', targetAgentId: f.setup.agentId });
  f.journal.save({ id: 'existing-business', state: 'uncertain', execution: f.store.get('execution', 'existing-business'), invocation: { messageId: 'original-prompt' } });
  f.journal.queue({ key: 'uncertain-business-effect', action: 'headless.task', payload: { executionId: 'existing-business' } });
  const work = f.journal.db.prepare('SELECT * FROM work WHERE id=?').get('existing-business');
  const publication = f.journal.db.prepare('SELECT * FROM outbox WHERE key=?').get('uncertain-business-effect');
  for (const [integrationID, active] of [['github-copilot', 'second-sign-in'], ['replacement-auth-client', 'third-sign-in']]) {
    f.integrationID = integrationID; f.active = active;
    assert.equal((await assertHeadlessAccess(f.api, f.client, f.setup.id, f.root)).check.allowed, true);
  }
  assert.deepEqual(f.store.get('headless_grant', f.grant.id), before.grant);
  assert.deepEqual(f.store.get('headless_setup', f.setup.id), before.setup);
  assert.deepEqual(f.store.get('schedule', 'sweep'), before.schedule);
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM work WHERE id=?').get('existing-business'), work);
  assert.deepEqual(f.journal.db.prepare('SELECT * FROM outbox WHERE key=?').get('uncertain-business-effect'), publication);
});

test('an unchanged cron admits its next run after changing the active connection with the coordinator offline', async t => {
  const f = await fixture(t), beforeGrant = f.store.get('headless_grant', f.grant.id), beforeSetup = f.store.get('headless_setup', f.setup.id);
  f.journal.db.prepare("DELETE FROM settings WHERE key='receiver:mason'").run();
  f.active = 'replacement-sign-in'; f.integrationID = 'replacement-auth-client';
  const local = JSON.parse(f.journal.db.prepare("SELECT data FROM schedules WHERE id='sweep'").get().data);
  const snapshot = { idle: true, inbox: [], messages: [] };
  const binding = { ...f.binding, native: { snapshot: async () => snapshot, send: async () => {
    await assertHeadlessAccess(f.api, f.client, f.setup.id, f.root); f.sends++;
  } }, observe: () => ({ state: 'running' }) };
  await tickAutomation(f.journal, async () => binding, Date.parse(local.nextAt), f.api);
  const id = `occurrence_${digest(['sweep', local.nextAt])}`;
  assert.equal(f.store.get('execution', id).state, 'accepted'); assert.equal(f.sends, 1);
  assert.equal(f.journal.work(id).invocation.messageId.startsWith('msg_'), true);
  assert.deepEqual(f.store.get('headless_grant', f.grant.id), beforeGrant);
  assert.deepEqual(f.store.get('headless_setup', f.setup.id), beforeSetup);
  assert.equal(f.store.get('schedule', 'sweep').revision, 1);
});

test('the node automatically recovers legacy auth-only blocks without its coordinator or changing paused schedules', async t => {
  for (const reason of headlessAccessBlockers) await t.test(reason, async t => {
    const f = await fixture(t);
    f.journal.db.prepare("DELETE FROM settings WHERE key='receiver:mason'").run();
    f.command('pause', 'schedule.pause', { id: 'sweep', expectedRevision: 1 });
    const schedule = f.store.get('schedule', 'sweep'), grant = f.store.get('headless_grant', f.grant.id);
    f.command('auth-block', 'headless.block', { id: f.setup.id, reason }, f.node);
    await f.tick();
    const requested = f.store.get('headless_setup', f.setup.id);
    assert.equal(requested.state, 'requested'); assert.equal(requested.attempt, 2);
    assert.deepEqual(f.store.get('headless_grant', f.grant.id), grant);
    await f.tick(); await f.tick(); f.completeProbe(); await f.tick();
    const ready = f.store.get('headless_setup', f.setup.id);
    assert.equal(ready.state, 'ready'); assert.equal(ready.agentId, f.setup.agentId); assert.equal(ready.sessionId, f.setup.sessionId);
    assert.equal(ready.connectionRebind, undefined);
    assert.deepEqual(f.store.get('schedule', 'sweep'), schedule);
    assert.equal(f.store.all('headless_setup').length, 1); assert.equal(f.store.all('headless_grant').length, 1);
  });
});

test('automatic access recovery leaves revoked grants, cancelled schedules, unsettled readiness and other failures alone', async t => {
  for (const condition of ['unavailable', 'revoked', 'cancelled', 'unsettled', 'other-failure']) await t.test(condition, async t => {
    const f = await fixture(t), reason = condition === 'other-failure' ? 'readiness_execution_failed' : 'model_connection_changed';
    f.command('auth-block', 'headless.block', { id: f.setup.id, reason }, f.node);
    if (condition === 'unavailable') f.access = false;
    if (condition === 'revoked') f.command('revoke', 'headless.revoke', { id: f.grant.id, expectedRevision: 1 });
    if (condition === 'cancelled') f.command('cancel', 'schedule.cancel', { id: 'sweep', expectedRevision: 1, reason: 'Human cancelled' });
    if (condition === 'unsettled') {
      const probe = f.store.get('execution', headlessProbeId(f.setup));
      f.store.save('execution', { ...probe, state: 'accepted' });
    }
    const before = f.store.get('headless_setup', f.setup.id), publications = f.journal.db.prepare('SELECT count(*) n FROM outbox').get().n;
    await f.tick(); await f.tick();
    assert.deepEqual(f.store.get('headless_setup', f.setup.id), before);
    assert.equal(f.journal.db.prepare('SELECT count(*) n FROM outbox').get().n, publications);
  });
});

test('backend access recovery is owning-node-only, revisioned and cannot retry other failures or active probes', async t => {
  const f = await fixture(t);
  let blocked = f.command('auth-block', 'headless.block', { id: f.setup.id, reason: 'model_connection_changed' }, f.node);
  const payload = { id: blocked.id, expectedRevision: blocked.revision };
  assert.throws(() => f.command('owner-retry', 'headless.retry_access', payload), { code: 'forbidden' });
  assert.throws(() => f.command('stale-retry', 'headless.retry_access', { ...payload, expectedRevision: 1 }, f.node), { code: 'stale_revision' });
  const probe = f.store.get('execution', headlessProbeId(f.setup));
  f.store.save('execution', { ...probe, state: 'accepted' });
  assert.throws(() => f.command('active-retry', 'headless.retry_access', payload, f.node), { code: 'headless_probe_unsettled' });
  f.store.save('execution', probe);
  blocked = f.command('other-block', 'headless.block', { id: f.setup.id, reason: 'readiness_execution_failed' }, f.node);
  assert.throws(() => f.command('other-retry', 'headless.retry_access', { ...payload, expectedRevision: blocked.revision }, f.node), { code: 'headless_access_retry_ineligible' });
});

test('pre-upgrade connection-recovery records still fence old ticks without retaining a rebind operation', async t => {
  const f = await fixture(t);
  const historical = f.store.save('headless_setup', { ...f.setup, revision: f.setup.revision + 1, state: 'requested', attempt: 2,
    connectionRebind: { state: 'checking' } });
  f.store.event('headless.connection_rebind', historical, f.node, 'historical-recovery');
  await f.journal.poll(f.api);
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
  assert.equal(next.state, 'accepted'); assert.equal(next.grantRevision, 1);
});

test('removed rebind endpoints and backend commands cannot enqueue or mutate work', async t => {
  const f = await fixture(t), before = f.store.get('headless_setup', f.setup.id);
  const count = f.journal.db.prepare('SELECT count(*) n FROM outbox').get().n;
  for (const path of ['/agent/headless-connection-preview', '/agent/headless-connection-rebind']) {
    await assert.rejects(call(f.worker, 'POST', path, { setupId: f.setup.id }), { code: 'not_found' });
  }
  for (const action of ['headless.connection_rebind', 'agent.headless_connection_rebind']) {
    assert.throws(() => f.command(`removed-${action}`, action, { setupId: f.setup.id }, f.node));
  }
  assert.deepEqual(f.store.get('headless_setup', f.setup.id), before);
  assert.equal(f.journal.db.prepare('SELECT count(*) n FROM outbox').get().n, count);
});

test('removed connection-preview and connection-rebind CLI commands have no compatibility alias', () => {
  for (const command of ['connection-preview', 'connection-rebind']) {
    const result = spawnSync(process.execPath, ['src/cli.mjs', 'headless', command, '--file', '/never-read-removed-command.json'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'invalid_request');
    assert.doesNotMatch(result.stderr, /ENOENT|owner|credential/i, 'Removed commands fail before reading files or selecting credentials');
  }
});

test('a lost automatic recovery reply reconciles without another setup attempt or a grant rewrite', async t => {
  const f = await fixture(t);
  f.command('auth-block', 'headless.block', { id: f.setup.id, reason: 'model_connection_changed' }, f.node);
  const original = f.journal.flush.bind(f.journal); let lost = false;
  f.journal.flush = async api => original(async (method, path, body) => {
    const result = await api(method, path, body);
    if (body?.action === 'headless.retry_access' && !lost) { lost = true; throw Error('Lost committed reply'); }
    return result;
  });
  await f.tick();
  assert.equal(lost, true);
  assert.equal(f.store.get('headless_setup', f.setup.id).attempt, 2);
  await f.tick();
  assert.equal(f.store.get('headless_setup', f.setup.id).attempt, 2);
  assert.equal(f.store.get('headless_grant', f.grant.id).revision, 1);
});
