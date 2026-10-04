import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { provisionAgent } from '../src/provisioning.mjs';

test('uncertain backend agent creation never blindly creates a duplicate', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let creates = 0;
  const api = async method => {
    if (method === 'GET') return [];
    creates++;
    throw new Error('Lost agent creation response');
  };
  const input = { key: 'worker', companyId: 'company', bindingId: 'worker', harness: 'opencode', directory: '/work' };
  await assert.rejects(provisionAgent(store, '/state', api, input));
  await assert.rejects(provisionAgent(store, '/state', api, input), { code: 'agent_creation_uncertain' });
  assert.equal(creates, 1);
  await assert.rejects(provisionAgent(store, '/state', api, { ...input, directory: '/changed' }), { code: 'operation_conflict' });
});
