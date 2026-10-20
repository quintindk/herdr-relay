import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { installMonitor, tickMonitors, stopMonitor, acknowledgeMonitor } from '../src/node-monitoring.mjs';

test('standing monitor preserves pending slot and refuses late admission after window end', () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  const start = Date.parse('2026-10-20T06:00:00Z');
  try {
    journal.save({ id: 'execution', state: 'settled_waiting', execution: { state: 'waiting_time', cancellationRequested: false } });
    installMonitor(journal, { id: 'monitor', executionId: 'execution', startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 60000).toISOString(), intervalSec: 10 });
    const first = tickMonitors(journal, start)[0];
    assert.equal(tickMonitors(journal, start + 1000)[0].id, first.id);
    acknowledgeMonitor(journal, 'monitor', first.id, start + 1000);
    assert.equal(tickMonitors(journal, start + 2000).length, 0);
    const second = tickMonitors(journal, start + 12000)[0];
    assert.notEqual(second.id, first.id);
    assert.throws(() => acknowledgeMonitor(journal, 'monitor', second.id, start + 60000), { code: 'monitor_expired' });
    assert.equal(tickMonitors(journal, start + 60000).length, 0);
    stopMonitor(journal, 'monitor');
    assert.equal(tickMonitors(journal, start).length, 0);
  } finally { journal.close(); }
});
