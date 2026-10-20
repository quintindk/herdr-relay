import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

test('offline reminder becomes one human inbox record and acknowledgement does not start execution', async () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  const clock = Date.now();
  store.command(owner, { key: 'reminder', action: 'schedule.install', payload: { id: 'reminder', definition: {
    nodeId: 'node', intent: 'reminder', instructions: 'Check deployment', at: new Date(clock + 1000).toISOString(), enabled: true,
  } } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  try {
    journal.consume(store.events());
    await tickAutomation(journal, async () => { throw new Error('No agent'); }, clock);
    await tickAutomation(journal, async () => { throw new Error('No agent'); }, clock + 1000);
    await journal.flush(async (_method, _path, body) => store.command(node, body));
    const notification = store.all('notification')[0];
    assert.equal(notification.message, 'Check deployment');
    const result = store.command(owner, { key: 'ack', action: 'notification.acknowledge', payload: { id: notification.id, expectedRevision: notification.revision } });
    assert.equal(result.state, 'acknowledged');
    assert.equal(store.all('execution').length, 0);
  } finally { journal.close(); store.close(); }
});
