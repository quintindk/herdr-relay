import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('human grant permits exact independent child review while parent final review remains human', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  try {
    cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'token').token);
    for (const id of ['parent-agent', 'worker']) cmd(node, 'agent.register', { id, nodeId: 'node', name: id, mode: 'headless' });
    cmd(owner, 'task.create', { id: 'root', title: 'Root' });
    let parent = cmd(owner, 'execution.request', { id: 'parent', taskId: 'root', taskRevision: 1, targetAgentId: 'parent-agent',
      instructions: 'Coordinate', allowDelegation: true, reviewPolicy: 'human' });
    parent = cmd(node, 'execution.admit', { id: parent.id, expectedRevision: parent.revision, bindingId: 'p', runId: 'p-1' });
    cmd(owner, 'review.grant', { id: 'grant', parentExecutionId: parent.id, reviewerAgentId: 'parent-agent' });
    let child = cmd(node, 'execution.delegate', { id: 'child', parentExecutionId: parent.id, expectedRevision: parent.revision,
      taskId: 'child-task', title: 'Build', instructions: 'Build', targetAgentId: 'worker', reviewPolicy: 'agent', reviewGrantId: 'grant' });
    parent = cmd(node, 'execution.wait_children', { id: parent.id, expectedRevision: parent.revision, childExecutionIds: [child.id] });
    child = cmd(node, 'execution.admit', { id: child.id, expectedRevision: child.revision, bindingId: 'c', runId: 'c-1' });
    child = cmd(node, 'execution.submit', { id: child.id, expectedRevision: child.revision, candidate: 'sha256:child', summary: 'Built', evidence: 'terminal' });
    parent = cmd(node, 'execution.review_children', { id: parent.id, expectedRevision: parent.revision });
    parent = cmd(node, 'execution.continue', { id: parent.id, expectedRevision: parent.revision, runId: 'p-2' });
    const decision = { id: child.id, expectedRevision: child.revision, candidate: child.result.candidate, decision: 'accept', reason: 'Checked build',
      reviewerExecutionId: parent.id, reviewerRunId: 'p-2' };
    assert.throws(() => cmd(node, 'execution.agent_review', { ...decision, reviewerRunId: 'p-1' }), { code: 'review_not_authorised' });
    assert.equal(cmd(node, 'execution.agent_review', decision).state, 'completed');
    parent = cmd(node, 'execution.submit', { id: parent.id, expectedRevision: parent.revision, candidate: 'sha256:root', summary: 'Integrated', evidence: 'terminal' });
    assert.equal(parent.state, 'in_review');
    assert.throws(() => cmd(node, 'execution.review', { id: parent.id, expectedRevision: parent.revision, candidate: parent.result.candidate,
      decision: 'accept', reason: 'Self' }), { code: 'forbidden' });
  } finally { store.close(); }
});
