import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';

test('credential rotation invalidates old tokens and has generation-bound retry semantics', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const binding = { id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' };
  const original = store.register(binding);
  const rotated = store.rotateCredential('worker', 'first');
  assert.equal(store.authenticate(original.token), null);
  assert.equal(store.authenticate(rotated.token), 'worker');
  assert.equal(store.rotateCredential('worker', 'first').token, rotated.token);
  const second = store.rotateCredential('worker', 'second');
  assert.equal(store.authenticate(rotated.token), null);
  assert.equal(store.authenticate(second.token), 'worker');
  assert.throws(() => store.rotateCredential('worker', 'first'), { code: 'credential_rotation_superseded' });
  store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  assert.throws(() => store.rotateCredential('worker', 'third'), { code: 'binding_busy' });
});
