import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

test('cancelled schedule fences future ticks and unadmitted occurrences without interrupting admitted work', async () => {
  const backend = new BackendStore(':memory:');
  const owner = backend.authenticate(backend.bootstrap().token);
  const cmd = (action, payload) => backend.command(owner, { key: crypto.randomUUID(), action, payload });
  cmd('node.enrol', { id: 'node', name: 'Node' });
  const clock = Date.now();
  let schedule = cmd('schedule.install', { id: 'reminder', definition: { nodeId: 'node', intent: 'reminder', instructions: 'Remember',
    at: new Date(clock + 60000).toISOString(), enabled: true } });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: backend.instance });
  try {
    journal.consume(backend.events());
    await tickAutomation(journal, async () => null, clock);
    schedule = cmd('schedule.cancel', { id: schedule.id, expectedRevision: schedule.revision, reason: 'Stop future work' });
    journal.consume(backend.events());
    await tickAutomation(journal, async () => null, clock + 60000);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM local_notifications').get().n, 0);
    assert.equal(JSON.parse(journal.db.prepare('SELECT data FROM schedules').get().data).state, 'cancelled');
    assert.throws(() => cmd('schedule.install', { id: schedule.id, expectedRevision: schedule.revision,
      definition: { ...schedule.definition, enabled: true } }), { code: 'schedule_cancelled' });
  } finally { journal.close(); backend.close(); }
});
