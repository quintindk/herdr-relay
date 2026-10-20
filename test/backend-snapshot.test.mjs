import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('consistent snapshot supplies exact subsequent event checkpoint and excludes secrets', () => {
  const store = new BackendStore(':memory:');
  const bootstrap = store.bootstrap();
  const owner = store.authenticate(bootstrap.token);
  try {
    store.command(owner, { key: 'first', action: 'task.create', payload: { id: 'first', title: 'First' } });
    const snapshot = store.snapshot();
    store.command(owner, { key: 'second', action: 'task.create', payload: { id: 'second', title: 'Second' } });
    assert.equal(snapshot.collections.task.length, 1);
    assert.equal(store.events({ cursor: snapshot.cursor }).items[0].entityId, 'second');
    assert.ok(!JSON.stringify(snapshot).includes(bootstrap.token));
    assert.ok(!Object.hasOwn(snapshot.collections, 'credentials'));
  } finally { store.close(); }
});
