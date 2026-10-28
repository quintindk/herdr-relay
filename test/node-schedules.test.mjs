import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeJournal } from '../src/node-journal.mjs';
import { installLocalSchedule, tickLocalSchedules } from '../src/node-schedules.mjs';

const start = Date.parse('2026-10-20T06:00:00Z');
const definition = { id: 'sweep', revision: 1, nodeId: 'node', targetAgentId: 'agent',
  instructions: 'Sweep inbox', cron: '* * * * *', timezone: 'Africa/Johannesburg', enabled: true };

test('local clock runs without backend, atomically advances, skips downtime and prevents overlap across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-schedule-'));
  const file = join(directory, 'node.sqlite');
  const identity = { nodeId: 'node', instanceId: 'backend' };
  let journal = new NodeJournal(file, identity);
  try {
    installLocalSchedule(journal, definition, start);
    assert.equal(tickLocalSchedules(journal, start + 60000).length, 1);
    journal.close(); journal = new NodeJournal(file, identity);
    assert.equal(tickLocalSchedules(journal, start + 60000).length, 0);
    assert.equal(tickLocalSchedules(journal, start + 120000).length, 0);
    journal.db.prepare("UPDATE occurrences SET state='completed'").run();
    assert.equal(tickLocalSchedules(journal, start + 600000).length, 0);
    assert.equal(tickLocalSchedules(journal, start + 660000).length, 1);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM occurrences').get().n, 2);
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schedule revision checks, pause and expiry fence new occurrence creation', () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  try {
    installLocalSchedule(journal, definition, start);
    assert.throws(() => installLocalSchedule(journal, { ...definition, instructions: 'Changed' }, start), { code: 'schedule_conflict' });
    installLocalSchedule(journal, { ...definition, revision: 2, enabled: false }, start);
    assert.equal(tickLocalSchedules(journal, start + 60000).length, 0);
    installLocalSchedule(journal, { ...definition, revision: 3, expiresAt: new Date(start + 30000).toISOString() }, start);
    assert.equal(tickLocalSchedules(journal, start + 60000).length, 0);
  } finally { journal.close(); }
});
