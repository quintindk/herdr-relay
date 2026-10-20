import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';

test('concurrent HTTP human answers commit one decision and one continuation event', async () => {
  const backend = await startBackend({ database: ':memory:' });
  const token = backend.store.bootstrap().token;
  const owner = backend.store.authenticate(token);
  const command = (actor, key, action, payload) => backend.store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = backend.store.authenticate(backend.store.enrolCredential(owner, 'node', 'credential').token);
  command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  command(owner, 'task', 'task.create', { id: 'task', title: 'Task' });
  let e = command(owner, 'request', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Work' });
  e = command(node, 'admit', 'execution.admit', { id: e.id, expectedRevision: e.revision, bindingId: 'binding', runId: 'run' });
  const q = command(node, 'ask', 'question.ask', { id: 'q', executionId: e.id, expectedRevision: e.revision, prompt: 'Region?', humanRequired: true });
  const api = nativeBackendClient({ url: backend.origin, token });
  try {
    const replies = await Promise.allSettled(['A', 'B'].map(body => api('POST', '/v1/commands', { key: `answer-${body}`, action: 'question.answer',
      payload: { id: q.id, expectedRevision: q.revision, body } })));
    assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1);
    assert.equal(replies.find(reply => reply.status === 'rejected').reason.code, 'stale_revision');
    assert.equal(backend.store.events().items.filter(event => event.type === 'execution.continuation_ready').length, 1);
  } finally { await backend.close(); }
});
