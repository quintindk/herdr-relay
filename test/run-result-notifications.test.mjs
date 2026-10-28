import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { nativeBoard } from '../src/native-board.mjs';
import { NativeDecisionJournal } from '../src/native-decision-journal.mjs';
import { runResultNotifications, OnlineRunResultMessages } from '../src/run-result-notifications.mjs';
import { NodeRunResultMessages } from '../src/node-run-result-messages.mjs';
import { digest } from '../src/protocol.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';

function fixture(t, policy, { disk = false, reviewPolicy = 'none' } = {}) {
  const root = disk ? mkdtempSync('/tmp/opencode/run-result-notifications-') : null;
  const path = root ? join(root, 'backend.sqlite') : ':memory:';
  const f = { path, store: new BackendStore(path) };
  t.after(() => { f.store.close(); if (root) rmSync(root, { recursive: true, force: true }); });
  f.owner = f.store.authenticate(f.store.bootstrap().token);
  let sequence = 0;
  f.command = (actor, action, payload, key = `operation-${++sequence}`) => f.store.command(actor, { key, action, payload });
  for (const id of ['node', 'other']) f.command(f.owner, 'node.enrol', { id, name: id });
  f.node = f.store.authenticate(f.store.enrolCredential(f.owner, 'node', 'node').token);
  f.other = f.store.authenticate(f.store.enrolCredential(f.owner, 'other', 'other').token);
  f.command(f.owner, 'agent.enrol', { id: 'mason', nodeId: 'node', name: 'Mason', directory: '/workspace' });
  f.command(f.owner, 'agent.attach', { id: 'mason', expectedBindingRevision: 0, conversationId: 'chat', directory: '/workspace', bindingId: 'receiver' });
  f.advertise = (availability = 'available') => {
    const agent = f.store.get('agent', 'mason');
    f.command(f.node, 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability, bindingRevision: agent.bindingRevision, conversationId: agent.conversationId });
    f.command(f.node, 'node.heartbeat', { id: 'node' });
  };
  f.advertise();
  const worker = f.command(f.node, 'agent.register', { id: 'sweep', nodeId: 'node', name: 'Inbox sweep', mode: 'headless' });
  f.store.save('agent', { ...worker, headlessSetupId: 'setup' });
  f.store.save('headless_setup', { id: 'setup', revision: 1, requesterAgentId: 'mason' });
  f.definition = { nodeId: 'node', targetAgentId: 'sweep', instructions: 'Read original sources, report exact limitations',
    cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', enabled: true, reviewPolicy,
    ...(policy !== undefined ? { runResultNotifications: policy } : {}) };
  f.command(f.owner, 'schedule.install', { id: 'inbox-sweep', definition: f.definition });
  f.publish = ({ failed = false, slot = '2026-10-28T06:00:00Z', revision = 1, summary = 'Inbox sweep: partial coverage.\nTwo comments verified. Teams enumeration failed.' } = {}) => {
    const id = `occurrence_${digest(['inbox-sweep', slot])}`;
    return f.command(f.node, failed ? 'schedule.fail' : 'schedule.publish', { id, scheduleId: 'inbox-sweep', definitionRevision: revision,
      intendedAt: slot, evidence: 'Correlated native terminal', ...(failed ? { reason: 'Source connection failed', failure: { stage: 'native', code: 'source_unavailable', message: 'No source coverage established' } } : { candidate: `candidate-${slot}`, summary }) }, `publish-${id}`);
  };
  f.take = (actor = f.node, consumerId = 'consumer') => f.store.runResultMessages.take(f.store, actor, { consumerId });
  f.take();
  f.api = async (method, path, body) => {
    if (path === '/v1/run-result-messages/take') return f.store.runResultMessages.take(f.store, f.node, body);
    if (path === '/v1/info') return { userId: 'owner', instanceId: f.store.instance, features: { runResultNotifications: true } };
    if (path === '/v1/commands') return f.store.command(f.owner, body);
    const [, , collection, id] = path.split('?')[0].split('/');
    if (id) return f.store.get(collection.slice(0, -1), decodeURIComponent(id));
    return { items: f.store.all(collection.slice(0, -1)), nextCursor: null };
  };
  return f;
}

test('settings default off and reject ambiguous or unsupported fields', () => {
  assert.deepEqual(runResultNotifications(), { inbox: false, requester: false });
  for (const input of [null, true, {}, { inbox: true }, { inbox: true, requester: 'online' }, { inbox: false, requester: false, onStart: true }])
    assert.throws(() => runResultNotifications(input), { code: 'invalid_run_result_notifications' });
});

test('malformed coordinator settings and unsupported backends are refused before durable enqueue', async t => {
  const root = mkdtempSync('/tmp/opencode/run-result-settings-');
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:mason', JSON.stringify({ state: 'active', bindingId: 'binding', generation: 1 }));
  const worker = { agentId: 'mason', sessionId: 'chat', bindingId: 'binding', bindingRevision: 1, token: 'fixture-only', socketPath: join(root, 'node.sock') };
  let supported = true;
  const service = await startNodeService({ journal, socketPath: worker.socketPath, workers: [worker], api: async () => assert.fail('Malformed settings cannot publish'),
    getBackendFeatures: async () => ({ runResultNotifications: supported }) });
  t.after(async () => { await service.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const payload = { id: 'job', expectedRevision: 1, runResultNotifications: { inbox: true, requester: true } };
  for (const invalid of [{ ...payload, reason: 'Unsupported field' }, { ...payload, expectedRevision: 0 }, { id: 'job', expectedRevision: 1 },
    { ...payload, runResultNotifications: { inbox: true } }])
    await assert.rejects(call(worker, 'POST', '/agent/schedule-result-notifications', { key: 'settings', payload: invalid }));
  supported = false;
  await assert.rejects(call(worker, 'POST', '/agent/schedule-result-notifications', { key: 'settings', payload }), { code: 'backend_upgrade_required' });
  assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

for (const policy of [undefined, { inbox: false, requester: false }, { inbox: true, requester: false }, { inbox: false, requester: true }, { inbox: true, requester: true }])
  test(`independent run result paths ${JSON.stringify(policy)}; no start notice, exact report and idempotent publication`, t => {
    const f = fixture(t, policy);
    assert.equal(f.store.all('notification').length, 0); assert.equal(f.take().items.length, 0);
    const summary = 'Partial coverage, not an all-clear.\n' + 'Long retained evidence. '.repeat(650);
    const occurrence = f.publish({ summary });
    assert.equal(f.store.all('notification').length, policy?.inbox ? 1 : 0);
    if (policy?.inbox) {
      const n = f.store.all('notification')[0];
      assert.equal(n.kind, 'run_result'); assert.equal(n.summary, summary); assert.equal(n.outcome, 'completed');
      assert.equal(n.occurrenceId, occurrence.id); assert.equal(n.definitionRevision, 1); assert.equal(n.requesterAgentId, 'mason');
      assert.ok(n.message.endsWith(summary)); assert.equal(n.state, 'pending');
    }
    const messages = f.take().items;
    assert.equal(messages.length, policy?.requester ? 1 : 0);
    if (messages.length) assert.equal(messages[0].summary, summary);
    assert.deepEqual(f.publish({ summary }), occurrence);
    assert.equal(f.take().items.length, 0, 'Reconciliation must not re-notify');
    assert.equal(f.store.all('message').length, 0, 'No headless message.send identity or durable peer queue');
  });

test('failed results carry exact failure details and do not claim successful business completion', t => {
  const f = fixture(t, { inbox: true, requester: true });
  const o = f.publish({ failed: true }), n = f.store.all('notification')[0];
  assert.equal(o.state, 'failed'); assert.equal(n.outcome, 'failed'); assert.equal(n.summary, 'Source connection failed');
  assert.deepEqual(n.failure, o.failure); assert.equal(f.take().items[0].failure.code, 'source_unavailable');
});

test('result and Inbox notification roll back together; post-commit transient effects never escape a refused transaction', t => {
  const f = fixture(t, { inbox: true, requester: true });
  assert.throws(() => f.store.transaction(() => { f.publish(); throw Error('Rollback'); }), /Rollback/);
  assert.equal(f.store.all('notification').length, 0); assert.equal(f.store.all('occurrence').length, 0); assert.equal(f.take().items.length, 0);
  f.publish(); assert.equal(f.store.all('notification').length, 1); assert.equal(f.take().items.length, 1);
});

test('offline/stale requesters are skipped; reconnecting never replays their old results', t => {
  for (const mode of ['offline', 'stale-agent', 'stale-node']) {
    const f = fixture(t, { inbox: true, requester: true });
    if (mode === 'offline') f.advertise('offline');
    else { const kind = mode === 'stale-agent' ? 'agent' : 'node', id = kind === 'agent' ? 'mason' : 'node';
      f.store.save(kind, { ...f.store.get(kind, id), lastSeenAt: '2020-01-01T00:00:00Z' }); }
    f.publish(); assert.equal(f.store.all('notification').length, 1); assert.equal(f.take().items.length, 0);
    f.advertise(); assert.equal(f.take().items.length, 0);
  }
});

test('online messages are discarded on receiver replacement, consumer restart or loss of presence; Inbox is unaffected', t => {
  for (const mode of ['offline', 'replacement', 'consumer']) {
    const f = fixture(t, { inbox: true, requester: true }); f.publish();
    if (mode === 'offline') f.advertise('offline');
    if (mode === 'replacement') f.command(f.owner, 'agent.attach', { id: 'mason', expectedBindingRevision: 1, conversationId: 'new-chat', directory: '/workspace', bindingId: 'new-receiver' });
    assert.equal(f.take(f.node, mode === 'consumer' ? 'replacement-consumer' : 'consumer').items.length, 0);
    assert.equal(f.store.all('notification').length, 1);
  }
});

test('persistent Inbox survives backend restart; no transient result message survives', t => {
  const f = fixture(t, { inbox: true, requester: true }, { disk: true }); f.publish();
  f.store.close(); f.store = new BackendStore(f.path);
  assert.equal(f.store.all('notification').length, 1); assert.equal(f.take().items.length, 0);
  f.publish(); assert.equal(f.store.all('notification').length, 1); assert.equal(f.take().items.length, 0, 'Publication receipt replay after restart is not a new notification');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 2);
});

test('settings updates are revisioned, scoped and affect future schedule revisions only, without backfill', t => {
  const f = fixture(t);
  f.publish();
  const update = { id: 'inbox-sweep', expectedRevision: 1, runResultNotifications: { inbox: true, requester: true } };
  assert.throws(() => f.command(f.node, 'schedule.result_notifications', update), { code: 'forbidden' });
  const schedule = f.command(f.node, 'agent.schedule_result_notifications', { agentId: 'mason', conversationId: 'chat', bindingRevision: 1, payload: update });
  assert.equal(schedule.revision, 2); assert.equal(f.store.all('notification').length, 0);
  assert.equal(f.store.scheduleRevision(schedule.id, 2).definition.runResultNotifications.inbox, true);
  f.publish({ slot: '2026-10-28T07:00:00Z', revision: 1 }); assert.equal(f.store.all('notification').length, 0, 'Old admitted policy is immutable');
  f.publish({ slot: '2026-10-28T08:00:00Z', revision: 2 }); assert.equal(f.store.all('notification').length, 1);
  assert.throws(() => f.command(f.owner, 'schedule.result_notifications', update), { code: 'stale_revision' });
});

test('only the original enrolled coordinator or correctly scoped human operator can edit the reporting policy', t => {
  const f = fixture(t);
  f.command(f.owner, 'agent.enrol', { id: 'unrelated', nodeId: 'node', name: 'Other coordinator', directory: '/workspace/other' });
  f.command(f.owner, 'agent.attach', { id: 'unrelated', expectedBindingRevision: 0, conversationId: 'unrelated-chat', directory: '/workspace/other', bindingId: 'unrelated-binding' });
  const payload = { id: 'inbox-sweep', expectedRevision: 1, runResultNotifications: { inbox: true, requester: true } };
  assert.throws(() => f.command(f.node, 'agent.schedule_result_notifications', { agentId: 'unrelated', conversationId: 'unrelated-chat', bindingRevision: 1, payload }), { code: 'forbidden' });
  for (const scope of [{ nodeId: 'other', mode: 'localUser' }, { nodeId: 'node', mode: 'roots', roots: ['/elsewhere'] }])
    assert.throws(() => f.command({ type: 'user', id: 'owner', scope: { kind: 'node_operator', ...scope } }, 'schedule.result_notifications', payload), { code: 'operator_scope_mismatch' });
  assert.throws(() => f.command(f.owner, 'schedule.result_notifications', { ...payload, requesterAgentId: 'unrelated' }), { code: 'invalid_request' });
  const before = f.store.get('schedule', 'inbox-sweep');
  const after = f.command({ type: 'user', id: 'owner', scope: { kind: 'node_operator', nodeId: 'node', mode: 'localUser' } }, 'schedule.result_notifications', payload);
  assert.equal(after.requesterAgentId, 'mason');
  const { runResultNotifications: _policy, ...definition } = after.definition;
  assert.deepEqual(definition, before.definition); assert.equal(after.appliedRevision, before.appliedRevision);
});

test('busy queues are bounded; excess chat notices are discarded without affecting persistent Inbox results', t => {
  const f = fixture(t, { inbox: true, requester: true });
  f.store.runResultMessages = new OnlineRunResultMessages({ limit: 1 }); f.take();
  f.publish(); f.publish({ slot: '2026-10-28T07:00:00Z' });
  assert.equal(f.store.all('notification').length, 2); assert.equal(f.take().items.length, 1);
});

test('pending review is not completion; accepted reviewed result generates its one notice', t => {
  const f = fixture(t, { inbox: true, requester: true }, { reviewPolicy: 'human' });
  const o = f.publish(); assert.equal(o.state, 'in_review'); assert.equal(f.store.all('notification').length, 0);
  f.command(f.owner, 'occurrence.review', { id: o.id, expectedRevision: o.revision, candidate: o.candidate, decision: 'accept', reason: 'Reviewed actual result' });
  assert.equal(f.store.all('notification').length, 1); assert.equal(f.take().items.length, 1);
});

test('reviewing a materialised taskless cron result notifies only after acceptance', t => {
  const f = fixture(t, { inbox: true, requester: false }, { reviewPolicy: 'human' });
  const id = `occurrence_${digest(['inbox-sweep', '2026-10-28T06:00:00Z'])}`;
  f.store.save('execution', { id, revision: 1, state: 'accepted', taskId: null, targetNodeId: 'node', originAgentId: 'mason', localOccurrence: true });
  const occurrence = f.publish(); assert.equal(occurrence.executionId, id);
  assert.equal(f.store.all('notification').length, 0);
  f.command(f.owner, 'occurrence.review', { id, expectedRevision: 1, candidate: occurrence.candidate, decision: 'accept', reason: 'Reviewed the cron report' });
  assert.equal(f.store.get('execution', id).state, 'completed'); assert.equal(f.store.get('occurrence', id).state, 'completed');
  assert.equal(f.store.all('notification').length, 1);
});

test('Inbox acknowledgement is informational, retains full result and changes neither execution nor schedule', async t => {
  const f = fixture(t, { inbox: true, requester: false }), o = f.publish();
  const journal = new NativeDecisionJournal(); t.after(() => journal.close());
  const board = nativeBoard(f.api, { decisionJournal: journal }), state = await board.read();
  const item = state.inbox.find(item => item.kind === 'run_result'); assert.ok(item);
  assert.equal(item.summary, o.summary); assert.match(item.effect, /does not approve/);
  const before = f.store.get('schedule', 'inbox-sweep');
  const result = await board.decideInbox({ item, key: 'read-result' });
  assert.equal(result.state, 'recorded'); assert.match(result.message, /marked read/);
  assert.equal(f.store.all('notification')[0].state, 'acknowledged');
  assert.deepEqual(f.store.get('schedule', 'inbox-sweep'), before); assert.deepEqual(f.store.get('occurrence', o.id), o);
  assert.equal((await board.read()).inbox.filter(item => item.kind === 'run_result').length, 0);
});

test('board settings use exact receipt validation and reconcile a lost reply under the original key', async t => {
  const f = fixture(t), journal = new NativeDecisionJournal(); t.after(() => journal.close());
  let loseReply = true;
  const api = async (method, path, body) => {
    const result = await f.api(method, path, body);
    if (method === 'POST' && loseReply) { loseReply = false; throw Error('Lost settings reply'); }
    return result;
  };
  const board = nativeBoard(api, { decisionJournal: journal });
  const input = { scheduleId: 'inbox-sweep', expectedRevision: 1, policy: { inbox: true, requester: false }, key: 'settings-once' };
  await assert.rejects(board.updateRunResultNotifications(input), /Lost settings reply/);
  assert.equal(journal.pending().length, 1); assert.equal(f.store.get('schedule', 'inbox-sweep').revision, 2);
  const result = await board.updateRunResultNotifications(input);
  assert.equal(result.state, 'recorded'); assert.equal(result.schedule.revision, 2); assert.equal(journal.pending().length, 0);
  await assert.rejects(board.updateRunResultNotifications({ ...input, policy: { inbox: false, requester: false } }), { code: 'decision_conflict' });
  assert.equal(f.store.get('schedule', 'inbox-sweep').revision, 2);
});

test('a settings receipt with the wrong policy or revision stays uncertain, not falsely confirmed', async t => {
  for (const receipt of [{ id: 'job', revision: 3, definition: { runResultNotifications: { inbox: true, requester: false } } },
    { id: 'job', revision: 2, definition: { runResultNotifications: { inbox: false, requester: false } } }]) {
    const journal = new NativeDecisionJournal(); t.after(() => journal.close());
    await assert.rejects(journal.submit(async method => method === 'GET' ? { instanceId: 'backend' } : receipt,
      { key: 'settings', action: 'schedule.result_notifications', payload: { id: 'job', expectedRevision: 1,
        runResultNotifications: { inbox: true, requester: false } } }, 'backend'), { code: 'invalid_decision_receipt' });
    assert.equal(journal.pending()[0].state, 'pending');
  }
});

function nodeFixture(t) {
  const f = fixture(t, { inbox: true, requester: true });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: f.store.instance }); t.after(() => journal.close());
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:mason', JSON.stringify({ state: 'active', bindingId: 'receiver', generation: 1 }));
  let busy = false, sends = 0, fail = false;
  const sent = [], binding = { id: 'receiver', agentId: 'mason', receiverGeneration: 1, identity: { sessionId: 'chat' },
    native: { snapshot: async () => ({ idle: !busy, inbox: [], messages: [] }), send: async invocation => { sends++; sent.push(invocation); if (fail) throw Error('Lost reply'); } } };
  const messages = new NodeRunResultMessages();
  return { ...f, journal, messages, binding, sent, busy: value => { busy = value; }, fail: () => { fail = true; }, sends: () => sends,
    tick: () => messages.tick(journal, f.api, async () => binding) };
}

test('busy online requester waits in memory, then receives one context-only service report; no native/durable message receipt', async t => {
  const f = nodeFixture(t); await f.tick(); f.busy(true); f.publish(); await f.tick();
  assert.equal(f.sends(), 0); assert.equal(f.messages.pending.size, 1);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM notices').get().n, 0);
  f.busy(false); await f.tick(); await f.tick();
  assert.equal(f.sends(), 1); assert.match(f.sent[0].prompt, /not a human instruction/); assert.match(f.sent[0].prompt, /Do not resume prior work/);
  assert.match(f.sent[0].prompt, /Teams enumeration failed/); assert.equal(f.messages.pending.size, 0);
  assert.equal(f.journal.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

test('uncertain native sends are dropped without retry and cannot affect a completed result or persistent Inbox', async t => {
  const f = nodeFixture(t); await f.tick(); const o = f.publish(); f.fail();
  await f.tick(); await f.tick(); assert.equal(f.sends(), 1);
  assert.equal(f.store.get('occurrence', o.id).state, 'completed'); assert.equal(f.store.all('notification').length, 1);
});

test('a stalled best-effort native send is bounded, aborted and never replayed', async t => {
  const f = nodeFixture(t); await f.tick(); f.publish(); f.messages.sendTimeoutMs = 10;
  let sends = 0, signal;
  f.binding.native.send = async (_invocation, options) => { sends++; signal = options.signal; return new Promise(() => {}); };
  await f.tick(); await f.tick(); assert.equal(sends, 1); assert.equal(signal.aborted, true);
  assert.equal(f.messages.pending.size, 0); assert.equal(f.store.all('notification').length, 1);
});

test('unknown/transient transport responses drop pending chat delivery rather than creating a retry dependency', async t => {
  const f = nodeFixture(t); await f.tick(); f.busy(true); f.publish(); await f.tick(); assert.equal(f.messages.pending.size, 1);
  await f.messages.tick(f.journal, async () => { throw Error('Offline backend'); }, async () => f.binding);
  assert.equal(f.messages.pending.size, 0); f.busy(false); await f.tick(); assert.equal(f.sends(), 0);
});

test('disconnect or backend restart discards a busy requester message without replay', async t => {
  for (const mode of ['disconnect', 'restart']) {
    const f = nodeFixture(t); await f.tick(); f.busy(true); f.publish(); await f.tick(); assert.equal(f.messages.pending.size, 1);
    if (mode === 'disconnect') f.advertise('offline'); else f.store.runResultMessages = new OnlineRunResultMessages();
    f.busy(false); await f.tick(); assert.equal(f.messages.pending.size, 0); assert.equal(f.sends(), 0);
    f.advertise(); await f.tick(); assert.equal(f.sends(), 0);
  }
});

test('best-effort transport cannot be read with human credentials or another node identity', t => {
  const f = fixture(t, { inbox: false, requester: true }); f.publish();
  assert.throws(() => f.take(f.owner), { code: 'forbidden' });
  assert.equal(f.take(f.other).items.length, 0); assert.equal(f.take().items.length, 1);
});
