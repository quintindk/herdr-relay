import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';
import { headlessRunAuthority } from '../src/headless-setup-contract.mjs';
import { digest } from '../src/protocol.mjs';

function fixture(t) {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  command(owner, 'coordinator', 'agent.enrol', { id: 'coordinator', nodeId: 'node', name: 'Coordinator', directory: '/work' });
  command(owner, 'attach', 'agent.attach', { id: 'coordinator', expectedBindingRevision: 0, conversationId: 'ses_coordinator', directory: '/work', bindingId: 'coordinator' });
  command(owner, 'grant', 'headless.grant', { id: 'grant', requesterAgentId: 'coordinator', nodeId: 'node', directory: '/work', name: 'Job',
    model: { providerID: 'fixture', id: 'model', integrationID: 'fixture', connectionId: 'fixture' }, permissions: { mcp: true, shell: false },
    contract: '.opencode/skills/job/SKILL.md', schedule: { id: 'job', cron: '* * * * *', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } });
  const setup = command(node, 'request', 'headless.request', { grantId: 'grant', requesterAgentId: 'coordinator', sourceConversationId: 'ses_coordinator', sourceBindingRevision: 1 });
  const agent = command(node, 'register', 'headless.register', { id: setup.id });
  command(node, 'advertise', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: setup.sessionId, bindingRevision: 1 });
  const probe = command(node, 'probe', 'headless.probe', { id: setup.id });
  store.save('execution', { ...probe, state: 'completed', result: { candidate: 'headless-readiness' } });
  command(node, 'activate', 'headless.activate', { id: setup.id, receipt: { nativeTerminalId: 'idle', permissionsToolCallId: 'permission', permissions: { mcp: true, shell: false }, accessDigest: 'fixture' } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  const start = Date.parse('2026-10-20T06:00:00Z');
  let sends = 0, offline = false, lose = false;
  const api = async (method, path, body) => {
    if (offline) throw Error('Backend offline');
    if (method === 'POST') {
      if (path === '/v1/headless/read') {
        const { setup } = headlessRunAuthority(store, node, body); return { id: setup.id, sessionId: setup.sessionId };
      }
      const result = store.command(node, body);
      if (body.action === 'schedule.admit' && lose) { lose = false; throw Error('Lost committed acknowledgement'); }
      return result;
    }
    if (path === '/v1/info') return { features: { scheduledHeadlessAdmission: true } };
    const [, , plural, id] = path.split('/'); return store.get(plural.slice(0, -1), decodeURIComponent(id));
  };
  const binding = { id: setup.bindingId, headlessSetupId: setup.id, identity: { sessionId: setup.sessionId },
    native: { snapshot: async () => ({ idle: true, inbox: [], messages: [] }), send: async () => {
      sends++;
      const work = journal.works()[0];
      const authority = headlessRunAuthority(store, node, { executionId: work.id, runId: work.execution.runId });
      assert.equal(authority.execution.taskId, null, 'Ordinary cron runs do not create human tasks');
    } }, observe: () => ({ state: 'observed' }) };
  journal.consume(store.events());
  const tick = clock => tickAutomation(journal, async () => binding, clock, api);
  t.after(() => { journal.close(); store.close(); });
  return { store, node, owner, command, journal, setup, binding, api, tick, start, sends: () => sends,
    offline: value => { offline = value; }, lose: () => { lose = true; } };
}

test('real scheduler admission establishes backend headless authority before the first native prompt and publishes taskless completion', async t => {
  const f = fixture(t); await f.tick(f.start); await f.journal.flush(f.api); await f.tick(f.start + 60000);
  assert.equal(f.sends(), 1);
  const work = f.journal.works()[0]; assert.equal(work.execution.headlessScheduled, true);
  assert.equal(f.store.all('task').length, 1, 'Only the existing readiness task exists');
  f.journal.save({ ...work, staged: { kind: 'result', payload: { candidate: 'cron-result', summary: 'Completed fixture' } } });
  f.binding.observe = () => ({ state: 'finished', outcome: 'succeeded', messageId: 'terminal' });
  await f.tick(f.start + 60001); await f.journal.flush(f.api);
  assert.equal(f.store.get('execution', work.id).state, 'completed'); assert.equal(f.store.get('occurrence', work.id).state, 'completed');
  assert.equal(f.store.all('task').length, 1);
});

test('headless cron waits offline and replays only admission after a lost receipt, never the native prompt', async t => {
  const f = fixture(t); await f.tick(f.start); await f.journal.flush(f.api);
  f.offline(true); await f.tick(f.start + 60000); assert.equal(f.sends(), 0);
  assert.equal(f.journal.works().filter(work => work.execution.localOccurrence).length, 0);
  f.offline(false); f.lose(); await f.tick(f.start + 60001); assert.equal(f.sends(), 0);
  const work = f.journal.works()[0]; assert.equal(work.invocation, undefined);
  assert.equal(f.store.get('execution', work.id).state, 'accepted');
  await f.tick(f.start + 60002); assert.equal(f.sends(), 1);
  await f.tick(f.start + 60003); assert.equal(f.sends(), 1);
});

test('admission rejects a wrong binding and a revoked grant before native effects', async t => {
  const f = fixture(t); await f.tick(f.start); await f.journal.flush(f.api);
  const intendedAt = new Date(f.start + 60000).toISOString(), id = `occurrence_${digest(['job', intendedAt])}`;
  const payload = { id, scheduleId: 'job', definitionRevision: 1, intendedAt, targetAgentId: f.setup.agentId,
    bindingId: 'wrong', conversationId: f.setup.sessionId, runId: `run_${digest(id)}` };
  assert.throws(() => f.command(f.node, 'wrong-binding', 'schedule.admit', payload), { code: 'headless_scope_mismatch' });
  f.command(f.owner, 'revoke', 'headless.revoke', { id: 'grant', expectedRevision: 1 });
  await f.tick(f.start + 60000); await f.journal.flush(f.api);
  assert.equal(f.sends(), 0); assert.equal(f.store.get('execution', id, false), null);
  assert.equal(f.journal.work(id).state, 'settled'); assert.equal(f.journal.receipt(`schedule-admit:${id}`).outcome, 'refused');
  assert.equal(f.store.get('occurrence', id).failure.stage, 'admission');
});

test('grant revocation after a committed but lost admission reply prevents prompt intent and settles the retained run', async t => {
  const f = fixture(t); await f.tick(f.start); await f.journal.flush(f.api); f.lose();
  await f.tick(f.start + 60000); assert.equal(f.sends(), 0);
  const work = f.journal.works().find(work => work.execution.localOccurrence);
  f.command(f.owner, 'revoke-after-admit', 'headless.revoke', { id: 'grant', expectedRevision: 1 });
  await f.tick(f.start + 60001); await f.journal.flush(f.api);
  assert.equal(f.sends(), 0); assert.equal(f.journal.work(work.id).invocation, undefined);
  assert.equal(f.store.get('execution', work.id).state, 'failed');
  assert.equal(f.store.get('occurrence', work.id).failure.code, 'headless_authority_refused');
});

test('a taskless admitted cron materialises a human task only when an asynchronous question needs one', async t => {
  const f = fixture(t); await f.tick(f.start); await f.journal.flush(f.api); await f.tick(f.start + 60000);
  const work = f.journal.works().find(work => work.execution.localOccurrence);
  const occurrence = JSON.parse(f.journal.db.prepare('SELECT data FROM occurrences WHERE id=?').get(work.id).data);
  const question = f.command(f.node, 'question', 'schedule.ask', { id: 'question', occurrenceId: work.id, scheduleId: 'job',
    definitionRevision: 1, intendedAt: occurrence.intendedAt, bindingId: f.binding.id, runId: work.execution.runId, prompt: 'Which scope?', humanRequired: true });
  assert.ok(question.taskId); assert.equal(f.store.all('task').length, 2);
  assert.equal(f.store.get('execution', work.id).state, 'waiting');
  f.command(f.owner, 'answer', 'question.answer', { id: question.id, expectedRevision: question.revision, body: 'Existing scope only' });
  assert.equal(f.store.get('execution', work.id).state, 'continuation_ready');
});
