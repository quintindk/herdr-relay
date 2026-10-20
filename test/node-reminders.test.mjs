import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { installLocalSchedule } from '../src/node-schedules.mjs';
import { tickAutomation } from '../src/node-automation.mjs';

test('offline one-shot human reminder is durable and never resolves an agent or starts a model', async () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  const clock = Date.parse('2026-10-20T12:00:00Z');
  try {
    installLocalSchedule(journal, { id: 'reminder', revision: 1, nodeId: 'node', intent: 'reminder',
      instructions: 'Review the deployment', at: new Date(clock + 60000).toISOString(), enabled: true }, clock);
    const resolve = async () => { throw new Error('Reminders must not select an agent'); };
    await tickAutomation(journal, resolve, clock + 60000);
    await tickAutomation(journal, resolve, clock + 60000);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM local_notifications').get().n, 1);
    assert.equal(journal.works().length, 0);
  } finally { journal.close(); }
});
