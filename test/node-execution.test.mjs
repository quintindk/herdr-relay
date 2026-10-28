import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickNode, submitNodeResult } from '../src/node-execution.mjs';

test('node retries backend admission but never resends an uncertain native prompt', async () => {
  const backend = new BackendStore(':memory:');
  const owner = backend.authenticate(backend.bootstrap().token);
  const command = (actor, key, action, payload) => backend.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = backend.authenticate(backend.enrolCredential(owner, 'node', 'credential').token);
  command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  command(owner, 'task', 'task.create', { id: 'task', title: 'Work' });
  command(owner, 'request', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Do work' });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: backend.instance });
  let messages = [], sends = 0, lost = true;
  const api = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/v1/executions/')) return backend.get('execution', path.split('/').at(-1));
    if (method === 'GET' && path.startsWith('/v1/tasks/')) return backend.get('task', path.split('/').at(-1));
    if (method === 'GET') return backend.events({ cursor: new URL(path, 'http://local').searchParams.get('cursor') ?? undefined });
    const result = backend.command(node, body);
    if (body.action === 'execution.admit' && lost) { lost = false; throw new Error('lost admission reply'); }
    return result;
  };
  const binding = { id: 'binding', native: { snapshot: async () => ({ idle: true, messages, inbox: [] }),
    send: async invocation => { sends++; messages = [{ id: invocation.messageId }]; throw new Error('lost native reply'); } },
  observe: () => ({ state: 'finished', outcome: 'succeeded', messageId: 'terminal' }) };
  try {
    await assert.rejects(tickNode(journal, api, async () => binding), /lost admission reply/);
    await tickNode(journal, api, async () => binding);
    assert.equal(sends, 1);
    assert.equal(journal.work('execution').state, 'uncertain');
    await tickNode(journal, async () => { throw new Error('backend offline'); }, async () => binding);
    assert.equal(sends, 1);
    assert.equal(journal.work('execution').state, 'native_finished');
    submitNodeResult(journal, 'execution', { candidate: 'sha256:result', summary: 'Done' });
    await journal.flush(api);
    assert.equal(backend.get('execution', 'execution').state, 'completed');
  } finally { journal.close(); backend.close(); }
});

test('offline monitor expiry interrupts only an explicit owned binding and retains publication intent', async () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  const invocation = { runId: 'run', messageId: 'message', prompt: 'Monitor', priorMessageIds: [] };
  journal.save({ id: 'execution', state: 'observing', bindingId: 'binding', invocation,
    execution: { id: 'execution', targetNodeId: 'node', targetAgentId: 'agent', revision: 2, state: 'accepted', runId: 'run',
      cancellationRequested: false, monitor: { startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-01T01:00:00Z', intervalSec: 1 } } });
  let interrupts = 0;
  const binding = { id: 'binding', native: { snapshot: async () => ({ messages: [], idle: false, inbox: [] }) },
    interrupt: async () => { interrupts++; }, observe: () => ({ state: 'observed' }) };
  try {
    await tickNode(journal, async () => { throw new Error('offline'); }, async () => binding);
    assert.equal(interrupts, 1);
    assert.equal(journal.work('execution').monitorExpiredLocally, true);
    assert.equal(journal.receipt('monitor-end:execution').state, 'pending');
    await tickNode(journal, async () => { throw new Error('offline'); }, async () => binding);
    assert.equal(interrupts, 1);
  } finally { journal.close(); }
});
