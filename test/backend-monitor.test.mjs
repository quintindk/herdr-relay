import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('standing-task monitoring refuses late admission and records expiry cancellation without inferring native stop', t => {
  t.mock.method(Date, 'now', () => 100000);
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  try {
    cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
    cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
    cmd(owner, 'task.create', { id: 'task', title: 'Standing monitor' });
    let e = cmd(owner, 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Monitor',
      monitor: { startsAt: new Date(100000).toISOString(), endsAt: new Date(110000).toISOString(), intervalSec: 1 } });
    e = cmd(node, 'execution.admit', { id: e.id, expectedRevision: e.revision, bindingId: 'binding', runId: 'run' });
    e = cmd(node, 'execution.monitor_result', { id: e.id, expectedRevision: e.revision, candidate: 'sha256:check', summary: 'No new actions', evidence: 'native terminal' });
    assert.equal(e.state, 'waiting_time');
    assert.equal(store.all('task').length, 1);
    assert.equal(store.all('monitor_result').length, 1);
    assert.equal(store.get('task', 'task').status, 'in_progress');
    t.mock.method(Date, 'now', () => 101000);
    e = cmd(node, 'execution.check_time', { id: e.id, expectedRevision: e.revision });
    e = cmd(node, 'execution.continue', { id: e.id, expectedRevision: e.revision, runId: 'run-2' });
    t.mock.method(Date, 'now', () => 110000);
    e = cmd(node, 'execution.monitor_end', { id: e.id, expectedRevision: e.revision });
    assert.equal(e.cancellationRequested, true);
    assert.equal(e.state, 'accepted');
    assert.throws(() => cmd(node, 'execution.delay', { id: e.id, expectedRevision: e.revision, until: new Date(120000).toISOString(), reason: 'Again' }), { code: 'invalid_delay' });
  } finally { store.close(); }
});
