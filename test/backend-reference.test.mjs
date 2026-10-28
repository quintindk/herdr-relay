import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('native references reuse terminal tasks without reopening and preserve immutable external identity', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (key, action, payload) => store.command(owner, { key, action, payload });
  try {
    const reference = { namespace: 'mail', externalId: 'one', url: 'https://example.com/mail/one' };
    let task = cmd('create', 'task.create', { id: 'one', title: 'Original', externalReference: reference });
    task = cmd('done', 'task.update', { id: task.id, expectedRevision: task.revision, changes: { status: 'done' } });
    const reused = cmd('retry-other-key', 'task.create', { id: 'different', title: 'Different', externalReference: reference });
    assert.equal(reused.id, task.id);
    assert.equal(reused.status, 'done');
    assert.equal(store.all('task').length, 1);
    assert.deepEqual(reused.references, [reference]);
    assert.throws(() => cmd('conflict', 'task.create', { id: 'other', title: 'Other', externalReference: { ...reference, url: 'https://example.com/changed' } }),
      { code: 'reference_conflict' });
  } finally { store.close(); }
});

test('native activity uses bounded half-open interval and scope-bound continuation', () => {
  const store = new BackendStore(':memory:');
  const actor = store.authenticate(store.bootstrap().token);
  try {
    for (let i = 0; i < 3; i++) store.command(actor, { key: `task-${i}`, action: 'task.create', payload: { id: `task-${i}`, title: 'Task' } });
    const query = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z', limit: 1 };
    const page = store.activity(query);
    assert.equal(page.items.length, 1);
    assert.equal(page.complete, false);
    const next = store.activity({ ...query, cursor: page.nextCursor });
    assert.notEqual(next.items[0].id, page.items[0].id);
    assert.throws(() => store.activity({ ...query, taskId: 'task-0', cursor: page.nextCursor }), { code: 'invalid_cursor' });
    const end = store.events().items[0].at;
    assert.equal(store.activity({ from: query.from, to: end }).items.length, 0);
  } finally { store.close(); }
});
