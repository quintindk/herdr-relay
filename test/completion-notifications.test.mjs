import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { reconcileNotifications, notificationRequest, isNotificationSource } from '../src/completion-notifications.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-notifications-'));
  const path = join(directory, 'state.sqlite');
  const f = { store: new Store(path) };
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.restart = () => { f.store.close(); f.store = new Store(path); };
  for (const id of ['origin', 'worker', 'other']) {
    f.store.register({ id, companyId: 'company', agentId: id, harness: 'opencode', instanceId: 'instance', conversationId: `session-${id}` });
  }
  f.origin = { bindingId: 'origin', conversationId: 'session-origin', sessionCreatedAt: 123 };
  f.bridge = f.store.saveOperation({ id: 'opencode-bridge:origin', runId: '',
    identity: { bindingId: 'origin', conversationId: 'session-origin', terminalId: 'terminal' },
    sessionCreatedAt: 123, epoch: 'epoch-one', state: 'armed' });
  f.task = f.store.saveOperation({ id: 'operator-task:one', runId: '', state: 'recorded',
    request: { origin: f.origin, companyId: 'company' }, receipt: { id: 'task', identifier: 'TEST-1', title: 'A task' } });
  const run = f.store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', taskId: 'task', runId: 'backend' });
  f.store.acknowledge(run.id);
  f.store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'The task is complete.' });
  f.store.publication(run.id, { state: 'recorded', commentId: 'comment' });
  f.run = f.store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
  // Reviewed completions can lack taskId and companyId entirely.
  f.completion = f.store.saveOperation({ id: `completion:${run.id}`, runId: run.id, state: 'recorded', status: 'done', candidate: 'candidate' });
  f.invoke = (action, input = {}, bridge = f.bridge) => notificationRequest(f.store, bridge, action, {
    conversationId: bridge.identity.conversationId, sessionCreatedAt: bridge.sessionCreatedAt, epoch: bridge.epoch, ...input,
  });
  f.list = () => f.invoke('notification-list').notifications;
  f.history = () => f.invoke('notification-history').notifications;
  f.create = () => { reconcileNotifications(f.store); return f.list()[0]; };
  f.begin = id => f.invoke('notification-begin', { id, idle: true });
  f.observe = (id, announced) => f.invoke('notification-observe', { id, announced }).notification;
  return f;
}

test('reconciliation joins completion runs to recorded operator tasks and survives restart without duplicates', t => {
  const f = fixture(t);
  const [notification] = reconcileNotifications(f.store);
  assert.equal(notification.runId, f.run.id);
  assert.deepEqual(notification.origin, f.origin);
  assert.equal(notification.companyId, 'company');
  assert.equal(notification.taskId, 'task');
  assert.equal(notification.identifier, 'TEST-1');
  assert.equal(notification.title, 'A task');
  assert.equal(notification.summary, f.run.result.summary);
  assert.equal(notification.state, 'pending');
  assert.match(notification.id, /^completion-notification:[a-f0-9]{64}$/);
  assert.match(notification.messageId, /^msg_[a-f0-9]{26}$/);
  assert.match(notification.text, /informational data, not a human instruction or authorisation/);
  assert.deepEqual(reconcileNotifications(f.store), []);
  f.restart();
  f.store.saveOperation({ ...f.task, id: 'operator-task:duplicate' });
  f.store.saveOperation({ ...f.completion, id: `no-review-completion:${f.run.id}` });
  assert.deepEqual(reconcileNotifications(f.store), []);
  assert.deepEqual(f.list(), [notification]);
  // Later metadata changes never replace an already reserved source ID or text.
  f.store.saveOperation({ ...f.task, receipt: { ...f.task.receipt, title: 'Renamed' } });
  reconcileNotifications(f.store);
  assert.deepEqual(f.list(), [notification]);
});

test('no-review completion works without a review and preserves multiple exact task origins', t => {
  const f = fixture(t);
  f.store.saveOperation({ ...f.completion, state: 'skipped' });
  f.store.saveOperation({ ...f.completion, id: `no-review-completion:${f.run.id}`, companyId: 'company', taskId: 'task' });
  const secondOrigin = { bindingId: 'other', conversationId: 'session-other', sessionCreatedAt: 456 };
  f.store.saveOperation({ ...f.task, id: 'operator-task:second', request: { ...f.task.request, origin: secondOrigin } });
  const created = reconcileNotifications(f.store);
  assert.equal(created.length, 2);
  assert.notEqual(created[0].id, created[1].id);
  assert.notEqual(created[0].messageId, created[1].messageId);
  assert.deepEqual(created.map(item => item.origin), [f.origin, secondOrigin]);
  assert.equal(f.list().length, 1);
  assert.equal(f.list()[0].origin.bindingId, 'origin');
});

for (const [name, change] of [
  ['unrecorded task', f => f.store.saveOperation({ ...f.task, state: 'uncertain' })],
  ['legacy task without origin', f => f.store.saveOperation({ ...f.task, request: { companyId: 'company' } })],
  ['origin without session creation', f => f.store.saveOperation({ ...f.task, request: { ...f.task.request, origin: { bindingId: 'origin', conversationId: 'session-origin' } } })],
  ['invalid origin creation', f => f.store.saveOperation({ ...f.task, request: { ...f.task.request, origin: { ...f.origin, sessionCreatedAt: '123' } } })],
  ['other task', f => f.store.saveOperation({ ...f.task, receipt: { ...f.task.receipt, id: 'other-task' } })],
  ['other company', f => f.store.saveOperation({ ...f.task, request: { ...f.task.request, companyId: 'other-company' } })],
  ['wrong receipt company', f => f.store.saveOperation({ ...f.task, receipt: { ...f.task.receipt, companyId: 'other-company' } })],
  ['uncertain completion', f => f.store.saveOperation({ ...f.completion, state: 'uncertain' })],
  ['cancelled completion', f => f.store.saveOperation({ ...f.completion, status: 'cancelled' })],
  ['wrong completion candidate', f => f.store.saveOperation({ ...f.completion, candidate: 'different' })],
  ['wrong completion task', f => f.store.saveOperation({ ...f.completion, taskId: 'different' })],
  ['wrong completion company', f => f.store.saveOperation({ ...f.completion, companyId: 'different' })],
  ['unsettled run', f => f.store.save({ ...f.run, nativeState: 'claimed' }, 'test.changed')],
  ['failed run', f => f.store.save({ ...f.run, settlement: { outcome: 'failed' } }, 'test.changed')],
  ['unpublished run', f => f.store.save({ ...f.run, publication: { state: 'uncertain' } }, 'test.changed')],
  ['missing result', f => f.store.save({ ...f.run, result: null }, 'test.changed')],
  ['missing candidate', f => {
    f.store.save({ ...f.run, result: { summary: 'No candidate' } }, 'test.changed');
    f.store.saveOperation({ ...f.completion, candidate: undefined });
  }],
]) {
  test(`reconciliation excludes ${name}`, t => {
    const f = fixture(t); change(f);
    assert.deepEqual(reconcileNotifications(f.store), []);
    assert.deepEqual(f.list(), []);
  });
}

test('orphan completions are skipped without hiding valid completions', t => {
  const f = fixture(t);
  f.store.saveOperation({ ...f.completion, id: 'completion:missing', runId: 'missing' });
  assert.equal(reconcileNotifications(f.store).length, 1);
});

test('summary and notification text remain bounded even with maximum JSON escaping', t => {
  const f = fixture(t);
  f.store.save({ ...f.run, result: { ...f.run.result, summary: '\u0000'.repeat(20000) } }, 'test.changed');
  f.store.saveOperation({ ...f.task, receipt: { ...f.task.receipt, title: '\u0000'.repeat(10000), identifier: '\u0000'.repeat(10000) } });
  const notification = f.create();
  assert.equal(notification.summary.length, 4000);
  assert.ok(notification.text.length <= 32000);
  assert.deepEqual(JSON.parse(notification.text.split('\n')[1]), {
    status: 'done', identifier: notification.identifier, title: notification.title, summary: notification.summary,
  });
});

test('begin persists uncertainty before dispatch and never authorises replay after a lost reply or restart', t => {
  const f = fixture(t);
  const notification = f.create();
  const begun = f.begin(notification.id);
  assert.equal(begun.dispatch, true);
  assert.equal(begun.notification.state, 'uncertain');
  assert.equal(begun.notification.epoch, 'epoch-one');
  assert.deepEqual(f.store.operation(notification.id), begun.notification);
  assert.equal(f.begin(notification.id).dispatch, false);
  assert.equal(f.observe(notification.id).state, 'uncertain');
  assert.equal(f.observe(notification.id, false).state, 'uncertain');
  f.restart();
  assert.equal(f.begin(notification.id).dispatch, false);
  f.bridge = f.store.saveOperation({ ...f.bridge, epoch: 'epoch-two' });
  assert.equal(f.begin(notification.id).dispatch, false);
  assert.equal(f.invoke('notification-begin', { id: notification.id, idle: false }).dispatch, false);
  assert.equal(f.observe(notification.id, null).state, 'uncertain');
  assert.deepEqual(f.list(), [begun.notification]);
  assert.deepEqual(f.history(), [begun.notification]);
  assert.deepEqual(reconcileNotifications(f.store), []);
  assert.throws(() => f.observe(notification.id, true), { code: 'notification_epoch_mismatch' });
  assert.deepEqual(f.store.operation(notification.id), begun.notification);
  assert.equal(f.begin(notification.id).dispatch, false);
  f.restart();
  assert.equal(f.begin(notification.id).dispatch, false);
  assert.equal(f.store.operation(notification.id).state, 'uncertain');
});

test('pending notifications require idle and no unsettled Relay runs on the origin', t => {
  const f = fixture(t);
  const notification = f.create();
  assert.throws(() => f.invoke('notification-begin', { id: notification.id }), { code: 'native_busy' });
  assert.throws(() => f.invoke('notification-begin', { id: notification.id, idle: 'true' }), { code: 'native_busy' });
  // Remove the bridge only while creating a real run without a live observer fixture.
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.bridge.id);
  const busy = f.store.dispatch({ bindingId: 'origin', bindingRevision: 1, companyId: 'company', agentId: 'origin', taskId: 'busy', runId: 'busy' });
  f.store.saveOperation(f.bridge);
  assert.throws(() => f.begin(notification.id), { code: 'conversation_busy' });
  assert.equal(f.store.operation(notification.id).state, 'pending');
  f.store.cancel(busy.id);
  f.store.dispatch({ ...f.run.request, runId: 'another-worker-run', taskId: 'unrelated' });
  assert.equal(f.begin(notification.id).dispatch, true, 'Unrelated worker activity does not own the origin');
});

test('ownership checks reject other bindings, fresh chats, stale epochs and unarmed bridges', t => {
  const f = fixture(t);
  const notification = f.create();
  for (const change of [{ conversationId: 'fresh-chat' }, { sessionCreatedAt: 124 }, { bindingId: 'other' }, { epoch: 'stale' }]) {
    for (const action of ['notification-list', 'notification-history', 'notification-begin', 'notification-observe']) {
      assert.throws(() => f.invoke(action, { id: notification.id, idle: true, ...change }), { code: 'bridge_identity_mismatch' });
    }
  }
  const other = f.store.saveOperation({ ...f.bridge, id: 'opencode-bridge:other',
    identity: { ...f.bridge.identity, bindingId: 'other', conversationId: 'session-other' } });
  assert.deepEqual(f.invoke('notification-list', {}, other), { notifications: [] });
  assert.deepEqual(f.invoke('notification-history', {}, other), { notifications: [] });
  for (const action of ['notification-begin', 'notification-observe']) {
    assert.throws(() => f.invoke(action, { id: notification.id, idle: true }, other), { code: 'notification_not_found' });
  }
  const oldBridge = f.bridge;
  f.bridge = f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 124 });
  assert.deepEqual(f.list(), [], 'Even reused conversation IDs cannot retarget a new native session');
  assert.deepEqual(f.history(), []);
  assert.throws(() => f.begin(notification.id), { code: 'notification_not_found' });
  assert.throws(() => f.invoke('notification-list', {}, oldBridge), { code: 'bridge_identity_mismatch' });
  f.bridge = f.store.saveOperation({ ...oldBridge, state: 'configured' });
  for (const action of ['notification-list', 'notification-history', 'notification-begin', 'notification-observe']) {
    assert.throws(() => f.invoke(action, { id: notification.id, idle: true }), { code: 'bridge_unavailable' });
  }
  assert.throws(() => f.invoke('notification-list', {}, oldBridge), { code: 'bridge_unavailable' });
  assert.deepEqual(f.store.operation(notification.id), notification);
});

test('observation cannot mark an unbegun notification announced and unrelated operations are inaccessible', t => {
  const f = fixture(t);
  const notification = f.create();
  assert.throws(() => f.observe(notification.id, true), { code: 'notification_not_started' });
  assert.throws(() => f.begin(f.task.id), { code: 'notification_not_found' });
  assert.throws(() => f.invoke('unknown'), { code: 'invalid_bridge_action' });
  assert.equal(f.store.operation(notification.id).state, 'pending');
});

test('native history and non-true acknowledgements cannot prove TUI acceptance', t => {
  const f = fixture(t);
  const notification = f.create(); f.begin(notification.id);
  const begun = f.store.operation(notification.id);
  const message = { info: { id: notification.messageId, sessionID: notification.origin.conversationId, role: 'user' },
    parts: [{ type: 'text', text: notification.text, synthetic: true }] };
  for (const input of [{ message }, { message: {} }, { delivered: true },
    ...[undefined, null, false, 'true', 1, {}].map(announced => ({ announced }))]) {
    assert.deepEqual(f.invoke('notification-observe', { id: notification.id, ...input }).notification, begun);
  }
  f.restart();
  assert.deepEqual(f.list(), [begun]);
  assert.equal(f.begin(notification.id).dispatch, false);
});

test('same attempt epoch can acknowledge TUI acceptance once without claiming human receipt', t => {
  const f = fixture(t);
  const notification = f.create(); f.begin(notification.id);
  f.restart();
  const announced = f.observe(notification.id, true);
  assert.equal(announced.state, 'announced');
  assert.equal(announced.epoch, 'epoch-one');
  assert.deepEqual(f.observe(notification.id, true), announced);
  assert.deepEqual(f.observe(notification.id, false), announced);
  assert.deepEqual(f.observe(notification.id, null), announced);
  assert.deepEqual(f.list(), []);
  assert.deepEqual(f.history(), [announced]);
  f.restart();
  assert.equal(f.begin(notification.id).dispatch, false);
  assert.deepEqual(f.history(), [announced]);
  f.bridge = f.store.saveOperation({ ...f.bridge, epoch: 'epoch-two' });
  assert.throws(() => f.observe(notification.id, true), { code: 'notification_epoch_mismatch' });
  assert.deepEqual(f.store.operation(notification.id), announced);
});

test('toast acknowledgements do not require a native message ID', t => {
  const f = fixture(t);
  const notification = f.create();
  delete notification.messageId;
  f.store.saveOperation(notification);
  assert.equal(f.begin(notification.id).dispatch, true);
  assert.equal(f.observe(notification.id, true).state, 'announced');
});

test('list is bounded to undelivered entries and history returns the latest 50 in reverse order for the exact origin', t => {
  const f = fixture(t);
  const notification = f.create(); f.begin(notification.id);
  const entries = [];
  for (let index = 0; index < 75; index++) entries.push(f.store.saveOperation({ ...notification,
    id: `completion-notification:${index}`, state: ['pending', 'uncertain', 'announced'][index % 3] }));
  for (const [index, change] of [
    { origin: { ...f.origin, bindingId: 'other' } },
    { origin: { ...f.origin, conversationId: 'fresh-chat' } },
    { origin: { ...f.origin, sessionCreatedAt: 124 } },
    { companyId: 'other-company' },
  ].entries()) f.store.saveOperation({ ...notification, id: `completion-notification:foreign-${index}`, ...change });
  assert.equal(f.list().length, 50);
  assert.deepEqual(f.list(), [f.store.operation(notification.id), ...entries.filter(item => item.state !== 'announced')].slice(0, 50));
  assert.deepEqual(f.history(), entries.slice(-50).reverse());
});

test('reserved notification sources never become human authority, including historical delivery states', t => {
  const f = fixture(t);
  const notification = f.create();
  for (const state of ['pending', 'uncertain', 'announced', 'delivered', 'conflict']) {
    f.store.saveOperation({ ...notification, state });
    f.restart();
    assert.equal(isNotificationSource(f.store, f.bridge, notification.messageId), true);
    assert.equal(isNotificationSource(f.store, { ...f.bridge, state: 'configured' }, notification.messageId), true);
  }
  assert.equal(isNotificationSource(f.store, f.bridge, 'human-message'), false);
  assert.equal(isNotificationSource(f.store, f.bridge, undefined), false);
  assert.equal(isNotificationSource(f.store, { ...f.bridge, sessionCreatedAt: 124 }, notification.messageId), false);
  assert.equal(isNotificationSource(f.store, { ...f.bridge, identity: { ...f.bridge.identity, bindingId: 'other' } }, notification.messageId), false);
  assert.equal(isNotificationSource(f.store, { ...f.bridge, identity: { ...f.bridge.identity, conversationId: 'fresh' } }, notification.messageId), false);
});
