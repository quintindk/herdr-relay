import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('explicit delegation scope creates independent children and resumes only after exact successful results', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  try {
    const nodes = ['desktop', 'server'].map(id => {
      cmd(owner, 'node.enrol', { id, name: id });
      return store.authenticate(store.enrolCredential(owner, id, id).token);
    });
    for (const [index, id] of ['initiator', 'worker'].entries()) cmd(nodes[index], 'agent.register', { id, nodeId: nodes[index].id, name: id, mode: 'headless' });
    cmd(owner, 'task.create', { id: 'root', title: 'Root' });
    let parent = cmd(owner, 'execution.request', { id: 'parent', taskId: 'root', taskRevision: 1,
      targetAgentId: 'initiator', instructions: 'Delegate', allowDelegation: true });
    parent = cmd(nodes[0], 'execution.admit', { id: parent.id, expectedRevision: parent.revision, bindingId: 'a', runId: 'a-1' });
    let child = cmd(nodes[0], 'execution.delegate', { id: 'child-run', parentExecutionId: parent.id, expectedRevision: parent.revision,
      taskId: 'child', title: 'Child', instructions: 'Build', targetAgentId: 'worker' });
    assert.equal(store.get('task', 'child').parentId, 'root');
    assert.equal(store.get('task', 'root').reference, 'REL-1');
    assert.equal(store.get('task', 'child').reference, 'REL-2');
    assert.equal(child.allowDelegation, false);
    parent = cmd(nodes[0], 'execution.wait_children', { id: parent.id, expectedRevision: parent.revision, childExecutionIds: [child.id] });
    assert.throws(() => cmd(nodes[0], 'execution.check_children', { id: parent.id, expectedRevision: parent.revision }), { code: 'children_pending' });
    child = cmd(nodes[1], 'execution.admit', { id: child.id, expectedRevision: child.revision, bindingId: 'b', runId: 'b-1' });
    assert.throws(() => cmd(nodes[1], 'execution.delegate', { id: 'grandchild', parentExecutionId: child.id, expectedRevision: child.revision,
      taskId: 'grandchild-task', title: 'Bad', instructions: 'Expand scope', targetAgentId: 'initiator' }), { code: 'delegation_not_authorised' });
    cmd(nodes[1], 'execution.submit', { id: child.id, expectedRevision: child.revision, candidate: 'sha256:child', summary: 'Built', evidence: 'terminal' });
    parent = cmd(nodes[0], 'execution.check_children', { id: parent.id, expectedRevision: parent.revision });
    assert.equal(parent.state, 'continuation_ready');
    assert.ok(parent.childContinuationId);
  } finally { store.close(); }
});
