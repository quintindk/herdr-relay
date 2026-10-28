import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { installLocalSchedule } from '../src/node-schedules.mjs';
import { reconcileScheduleDefinitions, tickAutomation } from '../src/node-automation.mjs';
import { BackendStore } from '../src/backend-store.mjs';

const clock = Date.parse('2026-10-20T06:00:00Z');

function fixture(t, extra = {}) {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  t.after(() => journal.close());
  installLocalSchedule(journal, { id: 'job', revision: 1, nodeId: 'node', targetAgentId: 'agent', instructions: 'Check',
    at: new Date(clock + 1000).toISOString(), enabled: true, ...extra }, clock);
  let sends = 0;
  const binding = { id: 'binding', identity: { sessionId: 'original' }, native: {
    snapshot: async () => ({ idle: true, inbox: [], messages: [] }), send: async () => { sends++; },
  }, observe: () => ({ state: 'observed' }) };
  return { journal, binding, sends: () => sends,
    tick: (time = clock + 1000) => tickAutomation(journal, async () => binding, time),
    occurrence: () => JSON.parse(journal.db.prepare('SELECT data FROM occurrences').get().data) };
}

test('exact schedule refuses a replacement conversation before first admission', async t => {
  const f = fixture(t, { targetConversationId: 'original' });
  f.binding.identity.sessionId = 'replacement';
  await f.tick();
  assert.equal(f.sends(), 0);
  assert.equal(f.occurrence().admission.reason, 'target_conversation_replaced');
  f.binding.identity.sessionId = 'original';
  await f.tick();
  assert.equal(f.sends(), 1);
});

test('expired pending occurrence cannot start when a busy binding becomes available', async t => {
  const f = fixture(t, { expiresAt: new Date(clock + 2000).toISOString() });
  f.binding.native.snapshot = async () => ({ idle: false, inbox: [], messages: [] });
  await f.tick();
  f.binding.native.snapshot = async () => ({ idle: true, inbox: [], messages: [] });
  await f.tick(clock + 3000);
  assert.equal(f.sends(), 0);
  assert.equal(f.occurrence().state, 'expired');
});

test('pause prevents pending admission but preserves an admitted turn', async t => {
  const f = fixture(t);
  f.binding.native.snapshot = async () => ({ idle: false, inbox: [], messages: [] });
  await f.tick();
  installLocalSchedule(f.journal, { ...f.occurrence().definition, revision: 2, enabled: false }, clock + 1000);
  f.binding.native.snapshot = async () => ({ idle: true, inbox: [], messages: [] });
  await f.tick();
  assert.equal(f.sends(), 0);
  installLocalSchedule(f.journal, { ...f.occurrence().definition, revision: 3, enabled: true }, clock + 1000);
  await f.tick();
  assert.equal(f.sends(), 1);
  installLocalSchedule(f.journal, { ...f.occurrence().definition, revision: 4, enabled: false }, clock + 1000);
  await f.tick();
  assert.equal(f.sends(), 1);
  assert.equal(f.occurrence().state, 'admitted');
});

test('admitted schedule cannot observe or interrupt through a replacement binding', async t => {
  const f = fixture(t);
  await f.tick();
  f.binding.id = 'replacement-binding';
  f.binding.observe = () => { throw new Error('Must not inspect through replacement'); };
  await f.tick();
  assert.equal(f.journal.works()[0].state, 'conflict');
  assert.equal(f.journal.works()[0].error, 'binding_replaced');
  f.binding.id = 'binding';
  await f.tick();
  assert.equal(f.sends(), 1);
});

test('backend exact schedule target is current, immutable and cannot transfer to another conversation', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  for (const id of ['node', 'other']) cmd(owner, 'node.enrol', { id, name: id });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'node').token);
  const other = store.authenticate(store.enrolCredential(owner, 'other', 'other').token);
  cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  cmd(other, 'agent.register', { id: 'other-agent', nodeId: 'other', name: 'Other', mode: 'headless' });
  cmd(node, 'agent.advertise', { id: 'agent', expectedRevision: 1, availability: 'available', conversationId: 'original' });
  const definition = { nodeId: 'node', targetAgentId: 'agent', targetConversationId: 'original', instructions: 'Check',
    at: new Date(clock + 1000).toISOString(), enabled: true };
  assert.throws(() => cmd(owner, 'schedule.install', { id: 'bad', definition: { ...definition, targetConversationId: 'wrong' } }),
    { code: 'target_conversation_mismatch' });
  const schedule = cmd(owner, 'schedule.install', { id: 'job', definition });
  assert.throws(() => cmd(owner, 'schedule.install', { id: 'job', expectedRevision: schedule.revision,
    definition: { ...definition, targetConversationId: undefined } }), { code: 'schedule_transfer_required' });
  assert.throws(() => cmd(owner, 'schedule.transfer_request', { id: 'job', expectedRevision: schedule.revision,
    targetNodeId: 'other', targetAgentId: 'other-agent' }), { code: 'exact_schedule_transfer_forbidden' });
});

test('schedule application rolls back if its acknowledgement cannot be durably queued', t => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend', maxPending: 1 });
  t.after(() => journal.close());
  const definition = { nodeId: 'node', targetAgentId: 'agent', instructions: 'Check',
    at: new Date(clock + 1000).toISOString(), enabled: true };
  installLocalSchedule(journal, { ...definition, id: 'job', revision: 1 }, clock);
  journal.queue({ key: 'occupied', action: 'node.heartbeat', payload: { id: 'node' } });
  const pending = { id: 'job', revision: 2, cancelled: true, definition: { ...definition, enabled: false } };
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('schedule-pending:job', JSON.stringify(pending));
  assert.throws(() => reconcileScheduleDefinitions(journal, clock), { code: 'outbox_full' });
  const local = JSON.parse(journal.db.prepare('SELECT data FROM schedules').get().data);
  assert.equal(local.state, 'active');
  assert.equal(local.definition.revision, 1);
  assert.ok(journal.db.prepare('SELECT 1 FROM settings WHERE key=?').get('schedule-pending:job'));
  journal.db.prepare("UPDATE outbox SET state='recorded'").run();
  reconcileScheduleDefinitions(journal, clock);
  assert.equal(JSON.parse(journal.db.prepare('SELECT data FROM schedules').get().data).state, 'cancelled');
  assert.equal(journal.receipt('schedule-ack:job:2').state, 'pending');
  assert.equal(journal.db.prepare('SELECT 1 FROM settings WHERE key=?').get('schedule-pending:job'), undefined);
});
