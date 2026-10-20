import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { reconcileScheduleDefinitions } from '../src/node-automation.mjs';

test('remote pause stays requested until owner node installs and acknowledges the exact revision', async () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  cmd(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  let schedule = cmd(owner, 'install', 'schedule.install', { id: 'reminder', definition: { nodeId: 'node', intent: 'reminder',
    instructions: 'Remember', cron: '0 * * * *', enabled: true } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  try {
    journal.consume(store.events()); reconcileScheduleDefinitions(journal);
    await journal.flush(async (_m, _p, body) => store.command(node, body));
    schedule = cmd(owner, 'pause', 'schedule.pause', { id: schedule.id, expectedRevision: schedule.revision });
    assert.equal(schedule.definition.enabled, false);
    assert.equal(schedule.appliedRevision, 1);
    assert.equal(schedule.revision, 2);
    journal.consume(store.events()); reconcileScheduleDefinitions(journal);
    assert.equal(JSON.parse(journal.db.prepare('SELECT data FROM schedules').get().data).state, 'paused');
    await journal.flush(async (_m, _p, body) => store.command(node, body));
    assert.equal(store.get('schedule', schedule.id).appliedRevision, 2);
  } finally { journal.close(); store.close(); }
});
