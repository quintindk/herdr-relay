import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('rejected human candidate cannot be bypassed by direct task completion', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  try {
    cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
    cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
    cmd(owner, 'task.create', { id: 'task', title: 'Task' });
    let e = cmd(owner, 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Work', reviewPolicy: 'human' });
    e = cmd(node, 'execution.admit', { id: e.id, expectedRevision: e.revision, bindingId: 'binding', runId: 'run' });
    e = cmd(node, 'execution.submit', { id: e.id, expectedRevision: e.revision, candidate: 'sha256:bad', summary: 'Candidate', evidence: 'terminal' });
    assert.equal(store.get('task', 'task').status, 'in_review');
    cmd(owner, 'execution.review', { id: e.id, expectedRevision: e.revision, candidate: e.result.candidate, decision: 'reject', reason: 'Missing checks' });
    const task = store.get('task', 'task');
    assert.equal(task.status, 'todo');
    assert.throws(() => cmd(owner, 'task.update', { id: task.id, expectedRevision: task.revision, changes: { status: 'done' } }),
      { code: 'acceptance_required' });
  } finally { store.close(); }
});
