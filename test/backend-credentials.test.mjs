import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('node credential rotation revokes predecessors and an old rotation cannot undo a newer one', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  try {
    store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
    const original = store.enrolCredential(owner, 'node', 'first');
    const second = store.rotateCredential(owner, 'node', 'second');
    assert.throws(() => store.authenticate(original.token), { code: 'unauthorised' });
    assert.equal(store.authenticate(second.token).id, 'node');
    assert.equal(store.rotateCredential(owner, 'node', 'second').token, second.token);
    const third = store.rotateCredential(owner, 'node', 'third');
    assert.throws(() => store.rotateCredential(owner, 'node', 'second'), { code: 'credential_superseded' });
    assert.equal(store.authenticate(third.token).id, 'node');
  } finally { store.close(); }
});
