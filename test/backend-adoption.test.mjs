import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';

test('conversation replacement requires explicit human adoption and cannot inherit outstanding executions', () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  try {
    cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
    const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
    let agent = cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'interactive' });
    agent = cmd(node, 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: 'original', bindingRevision: 1 });
    assert.throws(() => cmd(node, 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: 'replacement' }),
      { code: 'conversation_adoption_required' });
    cmd(owner, 'task.create', { id: 'task', title: 'Task' });
    const request = cmd(owner, 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: agent.id, instructions: 'Work' });
    assert.equal(request.targetConversationId, 'original');
    assert.throws(() => cmd(owner, 'agent.adopt', { id: agent.id, expectedRevision: agent.revision, conversationId: 'replacement', bindingRevision: 2 }), { code: 'agent_busy' });
    cmd(owner, 'execution.cancel', { id: request.id, expectedRevision: request.revision, reason: 'Replace target explicitly' });
    agent = cmd(owner, 'agent.adopt', { id: agent.id, expectedRevision: agent.revision, conversationId: 'replacement', bindingRevision: 2 });
    assert.equal(agent.conversationId, 'replacement');
    assert.equal(store.get('execution', request.id).targetConversationId, 'original');
  } finally { store.close(); }
});
