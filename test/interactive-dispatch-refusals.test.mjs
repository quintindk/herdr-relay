import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { inspectDatabase } from '../src/upgrade-safety.mjs';

test('maintenance distinguishes hash-verified dispatch refusals from pending, uncertain and unrelated publication conflicts without rewriting records', t => {
  const root = mkdtempSync('/tmp/opencode/dispatch-refusals-'), path = join(root, 'node.sqlite');
  const journal = new NodeJournal(path, { nodeId: 'node', instanceId: 'backend' });
  t.after(() => { journal.close(); rmSync(root, { recursive: true, force: true }); });
  const command = { key: 'original', action: 'interactive.dispatch', payload: { id: 'preparation', taskId: 'task', executionId: 'execution', instructions: 'Original handover' } };
  journal.queue(command);
  const item = journal.receipt(command.key);
  const save = (state, error, overrides = {}) => {
    journal.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run(state, JSON.stringify({ ...item, state, error, ...overrides }), command.key);
  };
  save('conflict', 'identity_conflict');
  const before = journal.db.prepare('SELECT * FROM outbox').get();
  const status = inspectDatabase(path, 'node');
  assert.deepEqual(status.blockers, []);
  assert.deepEqual(status.refusedPublications, [{ id: command.key, action: command.action, error: 'identity_conflict', applied: false }]);
  assert.deepEqual(journal.db.prepare('SELECT * FROM outbox').get(), before, 'Inspection must retain the original refusal unchanged');
  for (const [state, error, overrides] of [
    ['pending', 'identity_conflict', {}],
    ['conflict', 'operation_conflict', {}],
    ['conflict', 'publication_uncertain', {}],
    ['conflict', 'identity_conflict', { state: 'pending' }],
    ['conflict', 'identity_conflict', { receipt: { id: 'existing-execution' } }],
    ['conflict', 'identity_conflict', { applied: true }],
    ['conflict', 'execution_blocked', { command: { ...command, action: 'execution.submit' } }],
    ['conflict', 'identity_conflict', { command: { ...command, payload: { ...command.payload, instructions: 'Changed' } } }],
  ]) {
    save(state, error, overrides);
    assert.equal(inspectDatabase(path, 'node').blockers.length, 1, `${state}/${error} must remain a maintenance blocker`);
  }
});
