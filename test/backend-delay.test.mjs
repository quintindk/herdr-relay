import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('delayed continuation has one due transition and fresh identity after each wait', t => {
  t.mock.method(Date, 'now', () => 1000000);
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  try {
    cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'token').token);
    cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
    cmd(owner, 'task.create', { id: 'task', title: 'Task' });
    let e = cmd(owner, 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Check later' });
    e = cmd(node, 'execution.admit', { id: e.id, expectedRevision: e.revision, bindingId: 'binding', runId: 'run' });
    e = cmd(node, 'execution.delay', { id: e.id, expectedRevision: e.revision, until: new Date(1100000).toISOString(), reason: 'Wait for build' });
    assert.throws(() => cmd(node, 'execution.check_time', { id: e.id, expectedRevision: e.revision }), { code: 'continuation_not_due' });
    t.mock.method(Date, 'now', () => 1100000);
    e = cmd(node, 'execution.check_time', { id: e.id, expectedRevision: e.revision });
    const first = e.continuationId;
    e = cmd(node, 'execution.continue', { id: e.id, expectedRevision: e.revision, runId: 'run-2' });
    e = cmd(node, 'execution.delay', { id: e.id, expectedRevision: e.revision, until: new Date(1200000).toISOString(), reason: 'Wait again' });
    t.mock.method(Date, 'now', () => 1200000);
    e = cmd(node, 'execution.check_time', { id: e.id, expectedRevision: e.revision });
    assert.notEqual(e.continuationId, first);
  } finally { store.close(); }
});
