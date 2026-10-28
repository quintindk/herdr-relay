import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { publishHerdrInventory } from '../src/node-discovery.mjs';

test('Herdr inventory advertises observation-only agents without granting native delivery', async () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  const api = async (method, path, body) => method === 'POST' ? store.command(node, body) : store.get('agent', path.split('/').at(-1));
  const item = { agent: 'opencode', agent_session: { agent: 'opencode', kind: 'id', value: 'session' }, name: '\x1b[31mAgent', cwd: '/work/project' };
  try {
    const config = { nodeId: 'node', socketPath: '/tmp/herdr.sock' };
    const first = await publishHerdrInventory(api, config, { agents: [item, { agent: 'shell' }] });
    const second = await publishHerdrInventory(api, config, { agents: [item] });
    assert.equal(first[0].id, second[0].id);
    assert.deepEqual(first[0].capabilities, ['observation_only']);
    assert.equal(first[0].name, 'Agent');
    assert.equal(first[0].availability, 'unknown');
  } finally { store.close(); }
});
