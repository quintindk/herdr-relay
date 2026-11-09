import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { installLocalSchedule } from '../src/node-schedules.mjs';
import { tickAutomation } from '../src/node-automation.mjs';
import { tickNode } from '../src/node-execution.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

function fixture(t, disk = false) {
  const root = mkdtempSync('/tmp/opencode/receivers-');
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Machine' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'node-token').token);
  const f = { root, store, owner, node, command, sends: [], filename: disk ? join(root, 'node.sqlite') : ':memory:' };
  f.journal = new NodeJournal(f.filename, { nodeId: 'node', instanceId: store.instance });
  f.receivers = new NativeReceivers(f.journal);
  const enrolment = f.receivers.enrol({ name: 'Wright', directory: root, transport: 'cli' });
  f.agentId = enrolment.id;
  command(owner, 'agent', 'agent.enrol', { id: f.agentId, nodeId: 'node', name: 'Wright', directory: root });
  f.attach = (sessionId, expectedGeneration, key = sessionId) => {
    const operation = f.receivers.prepare({ agentId: f.agentId, identity: { sessionId, projectId: 'project', directory: root, createdAt: 1 },
      url: 'http://127.0.0.1:4096', authFile: join(root, 'auth.json'), expectedGeneration, key });
    if (operation.state === 'pending') f.receivers.confirm(operation, command(owner, operation.command.key, operation.command.action, operation.command.payload));
    return operation.binding;
  };
  f.resolve = async (id, pinned) => {
    const entry = f.receivers.resolve(id, pinned);
    if (!entry) return null;
    return { ...entry, native: {
      snapshot: async () => ({ idle: true, inbox: [], messages: [] }),
      send: async invocation => {
        f.sends.push({ bindingId: entry.id, sessionId: entry.identity.sessionId, invocation });
        if (f.uncertain) throw Error('lost native reply');
        const work = f.journal.works().find(w => w.invocation?.messageId === invocation.messageId);
        f.journal.save({ ...work, staged: { kind: 'result', key: 'submit', payload: { candidate: work.id, summary: entry.identity.sessionId } } });
      },
    }, observe: () => f.uncertain ? { state: 'uncertain' } : { state: 'finished', outcome: 'succeeded', messageId: 'terminal' } };
  };
  f.api = async (method, path, body) => {
    if (method === 'POST') return store.command(node, body);
    if (path.startsWith('/v1/events')) return store.events({ cursor: new URL(path, 'http://local').searchParams.get('cursor') ?? undefined });
    const [collection, id] = path.slice('/v1/'.length).split('/');
    return store.get({ executions: 'execution', tasks: 'task', questions: 'question' }[collection], id);
  };
  t.after(() => { f.journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('persistent cron follows the stable agent across fresh chats, journal reopen and offline execution without recreating its definition', async t => {
  const f = fixture(t, true);
  const first = f.attach('ses_first', 0);
  const clock = Date.parse('2026-10-21T06:00:00Z');
  const definition = { nodeId: 'node', targetAgentId: f.agentId, cron: '* * * * *', instructions: 'One check', enabled: true };
  f.command(f.owner, 'install', 'schedule.install', { id: 'persistent', definition });
  installLocalSchedule(f.journal, { ...definition, id: 'persistent', revision: 1 }, clock);
  await tickAutomation(f.journal, f.resolve, clock + 60000);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].bindingId, first.id);
  f.journal.close();
  f.journal = new NodeJournal(f.filename, { nodeId: 'node', instanceId: f.store.instance });
  f.receivers = new NativeReceivers(f.journal);
  const second = f.attach('ses_second', 1);
  await tickAutomation(f.journal, f.resolve, clock + 120000);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].bindingId, second.id);
  assert.equal(f.sends[1].sessionId, 'ses_second');
  await tickAutomation(f.journal, f.resolve, clock + 120000);
  assert.equal(f.sends.length, 2);
  await f.journal.flush(f.api);
  assert.equal(f.store.all('occurrence').length, 2);
  assert.equal(f.store.get('schedule', 'persistent').revision, 1);
  assert.equal(f.store.get('schedule', 'persistent').definition.targetAgentId, f.agentId);
});

test('replacement never replays an uncertain old occurrence and old pinned observation does not use the new receiver', async t => {
  const f = fixture(t);
  const first = f.attach('ses_old', 0);
  const clock = Date.parse('2026-10-21T06:00:00Z');
  installLocalSchedule(f.journal, { id: 'job', revision: 1, nodeId: 'node', targetAgentId: f.agentId, at: new Date(clock + 1000).toISOString(),
    enabled: true, instructions: 'Check' }, clock);
  f.uncertain = true;
  await tickAutomation(f.journal, f.resolve, clock + 1000);
  const original = f.journal.works()[0];
  f.attach('ses_new', 1);
  await tickAutomation(f.journal, f.resolve, clock + 2000);
  assert.equal(f.sends.length, 1);
  assert.equal(f.journal.work(original.id).bindingId, first.id);
  assert.deepEqual(f.journal.work(original.id).invocation, original.invocation);
  assert.equal(f.journal.work(original.id).state, 'uncertain');
  assert.throws(() => f.attach('ses_old', 2, 'reclaim-busy'), { code: 'native_session_reserved' });
});

test('attachment intent atomically fences a stale scheduler snapshot before native send', async t => {
  const f = fixture(t);
  f.attach('ses_old', 0);
  const clock = Date.parse('2026-10-21T06:00:00Z');
  installLocalSchedule(f.journal, { id: 'job', revision: 1, nodeId: 'node', targetAgentId: f.agentId, at: new Date(clock + 1000).toISOString(),
    enabled: true, instructions: 'Check' }, clock);
  const resolve = async id => {
    const binding = await f.resolve(id);
    return { ...binding, native: { ...binding.native, snapshot: async () => {
      f.attach('ses_new', 1);
      return { idle: true, inbox: [], messages: [] };
    } } };
  };
  await tickAutomation(f.journal, resolve, clock + 1000);
  assert.equal(f.sends.length, 0); assert.equal(f.journal.works().length, 0);
  await tickAutomation(f.journal, f.resolve, clock + 1000);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].sessionId, 'ses_new');
});

test('unadmitted requests resolve the new receiver, but admitted attempts remain pinned after replacement', async t => {
  const f = fixture(t);
  f.attach('ses_old', 0);
  f.command(f.owner, 'task', 'task.create', { id: 'task', title: 'Work' });
  const execution = f.command(f.owner, 'request', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1,
    targetAgentId: f.agentId, instructions: 'Check' });
  assert.equal(execution.targetConversationId, null);
  const second = f.attach('ses_new', 1);
  // Avoid event transport here. The backend request and exact native boundary
  // are exercised, while this test's journal projection is seeded explicitly.
  f.journal.save({ id: execution.id, execution, state: 'pending' });
  const api = async (method, path, body) => path.startsWith('/v1/events') ? { items: [], cursor: 'cursor', hasMore: false } : f.api(method, path, body);
  await tickNode(f.journal, api, f.resolve);
  const admitted = f.store.get('execution', execution.id);
  assert.equal(admitted.bindingId, second.id); assert.equal(admitted.targetConversationId, 'ses_new');
  f.attach('ses_third', 2);
  await tickNode(f.journal, api, f.resolve);
  assert.equal(f.sends.length, 1); assert.equal(f.journal.work(execution.id).bindingId, second.id);
});

test('a receiver replacement racing backend admission retries only after a definitive no-admission refusal', async t => {
  const f = fixture(t);
  f.attach('ses_old', 0);
  f.command(f.owner, 'task', 'task.create', { id: 'task', title: 'Work' });
  const execution = f.command(f.owner, 'request', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1,
    targetAgentId: f.agentId, instructions: 'Check' });
  f.journal.save({ id: execution.id, execution, state: 'pending' });
  let replaced = false;
  const api = async (method, path, body) => {
    if (path.startsWith('/v1/events')) return { items: [], cursor: 'cursor', hasMore: false };
    if (body?.action === 'execution.admit' && !replaced) { replaced = true; f.attach('ses_new', 1); }
    return f.api(method, path, body);
  };
  await assert.rejects(tickNode(f.journal, api, f.resolve), { code: 'stale_binding' });
  assert.equal(f.sends.length, 0);
  await tickNode(f.journal, api, f.resolve);
  assert.equal(f.journal.work(execution.id).state, 'pending');
  await tickNode(f.journal, api, f.resolve);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].sessionId, 'ses_new');
  assert.equal(f.journal.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='superseded'").get().n, 1);
});

test('replacement chats manage the same persistent cron with scoped credentials, while stale/foreign credentials cannot take over schedules or executions', async t => {
  const f = fixture(t);
  const first = f.attach('ses_first', 0);
  const second = f.attach('ses_second', 1);
  const workers = [first, second].map((binding, index) => ({ agentId: f.agentId, bindingId: binding.id,
    bindingRevision: binding.receiverGeneration, sessionId: binding.identity.sessionId, token: `token-${index}` }));
  const socketPath = join(f.root, 'node.sock');
  const service = await startNodeService({ journal: f.journal, socketPath, workers, api: f.api });
  t.after(() => service.close());
  const connection = index => ({ socketPath, token: workers[index].token });
  const create = { key: 'create', payload: { id: 'persistent', definition: { instructions: 'Check', cron: '* * * * *', enabled: false } } };
  await assert.rejects(call(connection(0), 'POST', '/agent/schedule-install', create), { code: 'receiver_replaced' });
  const installed = await call(connection(1), 'POST', '/agent/schedule-install', create);
  assert.equal(installed.state, 'recorded');
  assert.deepEqual(await call(connection(1), 'POST', '/agent/schedule-install', create), installed);
  assert.equal(f.store.get('schedule', 'persistent').definition.targetAgentId, f.agentId);
  const resumed = await call(connection(1), 'POST', '/agent/schedule-resume', { key: 'resume', payload: { id: 'persistent', expectedRevision: 1 } });
  assert.equal(resumed.receipt.definition.enabled, true);
  const paused = await call(connection(1), 'POST', '/agent/schedule-pause', { key: 'pause', payload: { id: 'persistent', expectedRevision: 2 } });
  assert.equal(paused.receipt.definition.enabled, false);
  await f.journal.poll(f.api);
  assert.equal(f.journal.cached('agent').length, 1);
  assert.equal(f.journal.cached('agent')[0].entity.id, f.agentId);
  await assert.rejects(call(connection(1), 'POST', '/agent/schedule-install', { ...create, key: 'foreign', payload: { ...create.payload,
    definition: { ...create.payload.definition, targetAgentId: 'foreign' } } }), { code: 'forbidden' });
  f.journal.save({ id: 'execution', execution: { targetAgentId: f.agentId, runId: 'run', state: 'accepted' }, state: 'observing',
    bindingId: second.id, nativeConversationId: 'ses_second' });
  await assert.rejects(call(connection(0), 'POST', '/work/read', { executionId: 'execution', runId: 'run' }), { code: 'forbidden' });
  await assert.rejects(call(connection(0), 'POST', '/work/current', { sessionId: 'ses_first' }), { code: 'work_ambiguous' });
  assert.equal((await call(connection(1), 'POST', '/agent/status', {})).receivingHere, true);
  assert.equal((await call(connection(0), 'POST', '/agent/status', {})).receivingHere, false);
  const work = f.journal.work('execution');
  f.journal.save({ ...work, state: 'conflict', observation: { state: 'conflict', reason: 'concurrent_native_input', inputId: 'foreign' } });
  const current = await call(connection(1), 'POST', '/work/current', { sessionId: 'ses_second' });
  assert.equal(current.execution.state, 'accepted'); assert.equal(current.localState, 'conflict'); assert.equal(current.blocked, true);
  assert.equal(current.observation.inputId, 'foreign');
  await assert.rejects(call(connection(1), 'POST', '/work/submit', { executionId: 'execution', runId: 'run', key: 'blocked',
    payload: { candidate: 'not-authorised', summary: 'Not accepted' } }), { code: 'execution_inactive' });
});

test('loading excludes a refused conversation alias while preserving accepted and historical receiver bindings', t => {
  const f = fixture(t, true), first = f.attach('ses_first', 0), second = f.attach('ses_second', 1);
  const peer = f.receivers.enrol({ id: 'peer', name: 'Peer', directory: f.root, transport: 'tools' });
  f.command(f.owner, 'peer', 'agent.enrol', { id: peer.id, nodeId: 'node', name: peer.name, directory: f.root });
  const prepare = (sessionId, key) => f.receivers.prepare({ agentId: peer.id, expectedGeneration: 0, key,
    identity: { sessionId, projectId: 'project', directory: f.root, createdAt: 1 }, url: first.url, authFile: first.authFile });
  const refused = prepare('ses_second', 'alias');
  assert.throws(() => f.command(f.owner, refused.command.key, refused.command.action, refused.command.payload), { code: 'conversation_alias' });
  f.receivers.reject(refused, { code: 'conversation_alias' }, f.store.get('agent', peer.id));
  const accepted = prepare('ses_peer', 'peer-attachment');
  f.receivers.confirm(accepted, f.command(f.owner, accepted.command.key, accepted.command.action, accepted.command.payload));
  const before = f.receivers.get('attachment:alias');
  assert.deepEqual(new Set(f.receivers.loadableBindings().map(binding => binding.id)), new Set([first.id, second.id, accepted.binding.id]));
  assert.deepEqual(f.receivers.get('attachment:alias'), before);
  assert.deepEqual(f.receivers.get(`native-binding:${refused.binding.id}`), refused.binding);
  f.journal.close(); f.journal = new NodeJournal(f.filename, { nodeId: 'node', instanceId: f.store.instance });
  f.receivers = new NativeReceivers(f.journal);
  assert.deepEqual(new Set(f.receivers.loadableBindings().map(binding => binding.id)), new Set([first.id, second.id, accepted.binding.id]));
});

test('an unconfirmed binding stays loadable for original-key reconciliation and cannot become a current receiver', t => {
  const f = fixture(t), first = f.attach('ses_old', 0);
  const pending = f.receivers.prepare({ agentId: f.agentId, expectedGeneration: 1, key: 'lost-reply',
    identity: { ...first.identity, sessionId: 'ses_new' }, url: first.url, authFile: first.authFile });
  assert.deepEqual(new Set(f.receivers.loadableBindings().map(binding => binding.id)), new Set([first.id, pending.binding.id]));
  assert.equal(f.receivers.resolve(f.agentId), null);
  assert.equal(f.receivers.get('attachment:lost-reply').state, 'pending');
});

test('a binding later confirmed under another key remains loadable despite its older refused attempt', t => {
  const f = fixture(t), first = f.attach('ses_occupied', 0);
  const peer = f.receivers.enrol({ id: 'peer', name: 'Peer', directory: f.root, transport: 'tools' });
  f.command(f.owner, 'peer', 'agent.enrol', { id: peer.id, nodeId: 'node', name: peer.name, directory: f.root });
  const prepare = key => f.receivers.prepare({ agentId: peer.id, expectedGeneration: 0, key,
    identity: first.identity, url: first.url, authFile: first.authFile });
  const refused = prepare('alias');
  assert.throws(() => f.command(f.owner, refused.command.key, refused.command.action, refused.command.payload), { code: 'conversation_alias' });
  f.receivers.reject(refused, { code: 'conversation_alias' }, f.store.get('agent', peer.id));
  f.attach('ses_replacement', 1);
  const accepted = prepare('confirmed-later');
  assert.equal(accepted.binding.id, refused.binding.id);
  f.receivers.confirm(accepted, f.command(f.owner, accepted.command.key, accepted.command.action, accepted.command.payload));
  assert.ok(f.receivers.loadableBindings().some(binding => binding.id === accepted.binding.id));
  assert.equal(f.receivers.get('attachment:alias').state, 'refused');
});

test('multiple refused attempts with changed native endpoints retain their history without blocking loading', t => {
  const f = fixture(t), first = f.attach('ses_occupied', 0);
  const peer = f.receivers.enrol({ id: 'peer', name: 'Peer', directory: f.root, transport: 'tools' });
  f.command(f.owner, 'peer', 'agent.enrol', { id: peer.id, nodeId: 'node', name: peer.name, directory: f.root });
  for (const key of ['first-refusal', 'second-refusal']) {
    const operation = f.receivers.prepare({ agentId: peer.id, expectedGeneration: 0, key, identity: first.identity,
      url: key === 'first-refusal' ? first.url : 'http://127.0.0.1:4097', authFile: join(f.root, `${key}.json`) });
    assert.throws(() => f.command(f.owner, operation.command.key, operation.command.action, operation.command.payload), { code: 'conversation_alias' });
    f.receivers.reject(operation, { code: 'conversation_alias' }, f.store.get('agent', peer.id));
  }
  assert.deepEqual(f.receivers.loadableBindings().map(binding => binding.id), [first.id]);
  assert.equal(f.receivers.get('attachment:first-refusal').state, 'refused');
  assert.equal(f.receivers.get('attachment:second-refusal').state, 'refused');
});

test('a new confirmed attachment after retirement cannot reuse the refused binding identity', t => {
  const f = fixture(t), first = f.attach('ses_occupied', 0);
  const peer = f.receivers.enrol({ id: 'peer', name: 'Peer', directory: f.root, transport: 'tools' });
  f.command(f.owner, 'peer', 'agent.enrol', { id: peer.id, nodeId: 'node', name: peer.name, directory: f.root });
  const prepare = key => f.receivers.prepare({ agentId: peer.id, expectedGeneration: 0, key,
    identity: first.identity, url: first.url, authFile: first.authFile });
  const refused = prepare('refused');
  assert.throws(() => f.command(f.owner, refused.command.key, refused.command.action, refused.command.payload), { code: 'conversation_alias' });
  f.receivers.reject(refused, { code: 'conversation_alias' }, f.store.get('agent', peer.id));
  const { operation, proof } = f.receivers.refusedAttachment(refused.key);
  f.receivers.retireRefusedAttachment(refused.key, { key: 'retire', reason: 'Human requested recovery', expectedDigest: digest(operation),
    proof: { ...proof, nodeId: 'node', backendBindingId: null, backendBindingRevision: 0 }, backup: 'fixture-backup' });
  f.attach('ses_replacement', 1);
  const accepted = prepare('new-confirmed-key');
  assert.notEqual(accepted.binding.id, refused.binding.id);
  assert.deepEqual(prepare('new-confirmed-key'), accepted);
  f.receivers.confirm(accepted, f.command(f.owner, accepted.command.key, accepted.command.action, accepted.command.payload));
  assert.ok(f.receivers.loadableBindings().some(binding => binding.id === accepted.binding.id));
  assert.equal(f.receivers.get(`retired-binding:${refused.binding.id}`).state, 'retired');
  assert.equal(f.receivers.get('attachment:refused').state, 'refused');
});
