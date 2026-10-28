import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { nodeHeartbeatPayload } from '../src/node-discovery.mjs';

test('node machine advertisement is optional and capability-gated for older backends', () => {
  const machine = { hostname: 'desktop', platform: 'linux' };
  assert.deepEqual(nodeHeartbeatPayload('node', {}, machine), { id: 'node' });
  assert.deepEqual(nodeHeartbeatPayload('node', { features: { nodeMachineAdvertisement: true } }, machine), { id: 'node', machine });
});

test('only the owning node can advertise machine labels and legacy heartbeats retain them', t => {
  const store = new BackendStore(':memory:'); t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  let key = 0;
  const command = (actor, action, payload) => store.command(actor, { key: `op-${++key}`, action, payload });
  for (const id of ['local', 'remote']) command(owner, 'node.enrol', { id, name: id });
  const local = store.authenticate(store.enrolCredential(owner, 'local', 'local-key').token);
  const remote = store.authenticate(store.enrolCredential(owner, 'remote', 'remote-key').token);
  command(local, 'node.heartbeat', { id: 'local', machine: { hostname: 'desktop', platform: 'linux' } });
  command(local, 'node.heartbeat', { id: 'local' });
  assert.equal(store.get('node', 'local').machine.hostname, 'desktop');
  assert.throws(() => command(remote, 'node.heartbeat', { id: 'local', machine: { hostname: 'wrong-host' } }), { code: 'forbidden' });
  assert.throws(() => command(local, 'node.heartbeat', { id: 'local', machine: { hostname: '', platform: 'linux' } }));
  assert.throws(() => command(local, 'node.heartbeat', { id: 'local', machine: { hostname: 'desktop', extra: 'not supported' } }));
  assert.equal(store.get('node', 'local').machine.hostname, 'desktop');
  assert.equal(store.get('node', 'remote').machine, undefined);
});
