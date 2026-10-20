import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { startBackend } from '../src/backend-service.mjs';

function fixture() {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, action, payload, key = crypto.randomUUID()) => store.command(actor, { action, payload, key });
  for (const id of ['desktop', 'server']) command(owner, 'node.enrol', { id, name: id });
  const desktop = store.authenticate(store.enrolCredential(owner, 'desktop', 'desktop-key').token);
  const server = store.authenticate(store.enrolCredential(owner, 'server', 'server-key').token);
  command(desktop, 'agent.register', { id: 'initiator', nodeId: 'desktop', name: 'Initiator', mode: 'interactive' });
  command(server, 'agent.register', { id: 'worker', nodeId: 'server', name: 'Worker', mode: 'headless' });
  const task = command(owner, 'task.create', { id: 'task', title: 'Deploy' });
  const requested = command(owner, 'execution.request', { id: 'execution', taskId: task.id, taskRevision: task.revision,
    originAgentId: 'initiator', targetAgentId: 'worker', instructions: 'Prepare deployment', reviewPolicy: 'human' });
  const execution = command(server, 'execution.admit', { id: requested.id, expectedRevision: requested.revision, bindingId: 'binding', runId: 'run-1' });
  return { store, owner, desktop, server, task, execution, command };
}

test('native question flows worker to initiator to human, answers once and continues exact execution', () => {
  const f = fixture();
  try {
    let q = f.command(f.server, 'question.ask', { id: 'region', executionId: f.execution.id, expectedRevision: f.execution.revision, prompt: 'Which region?' });
    assert.deepEqual(q.addressedTo, { type: 'agent', id: 'initiator' });
    q = f.command(f.desktop, 'question.forward', { id: q.id, expectedRevision: q.revision, agentId: 'initiator', reason: 'Human choice needed' });
    assert.equal(q.routing.length, 1);
    const payload = { id: q.id, expectedRevision: q.revision, body: 'South Africa North' };
    const answered = f.command(f.owner, 'question.answer', payload, 'answer');
    assert.deepEqual(f.command(f.owner, 'question.answer', payload, 'answer'), answered);
    assert.throws(() => f.command(f.owner, 'question.answer', { ...payload, body: 'Other' }, 'answer'), { code: 'operation_conflict' });
    assert.throws(() => f.command(f.owner, 'question.answer', payload), { code: 'stale_revision' });
    const ready = f.store.get('execution', 'execution');
    assert.equal(ready.state, 'continuation_ready');
    const continued = f.command(f.server, 'execution.continue', { id: ready.id, expectedRevision: ready.revision, runId: 'run-2' });
    assert.equal(continued.bindingId, 'binding');
    const result = f.command(f.server, 'execution.submit', { id: continued.id, expectedRevision: continued.revision,
      candidate: 'sha256:result', summary: 'Prepared', evidence: 'Native terminal receipt' });
    assert.equal(result.state, 'in_review');
    assert.throws(() => f.command(f.server, 'execution.review', { id: result.id, expectedRevision: result.revision,
      candidate: result.result.candidate, decision: 'accept', reason: 'Self' }), { code: 'forbidden' });
    const accepted = f.command(f.owner, 'execution.review', { id: result.id, expectedRevision: result.revision,
      candidate: result.result.candidate, decision: 'accept', reason: 'Checked' });
    assert.equal(accepted.state, 'completed');
  } finally { f.store.close(); }
});

test('credential scope, cancellation and task graph guards cannot be bypassed', () => {
  const f = fixture();
  try {
    assert.throws(() => f.command(f.desktop, 'execution.progress', { id: 'execution', expectedRevision: f.execution.revision, summary: 'Spoof' }), { code: 'forbidden' });
    const q = f.command(f.server, 'question.ask', { id: 'human', executionId: 'execution', expectedRevision: f.execution.revision, prompt: 'Approve?', humanRequired: true });
    assert.throws(() => f.command(f.desktop, 'question.answer', { id: q.id, expectedRevision: q.revision, agentId: 'initiator', body: 'Yes' }), { code: 'forbidden' });
    const waiting = f.store.get('execution', 'execution');
    f.command(f.owner, 'execution.cancel', { id: waiting.id, expectedRevision: waiting.revision, reason: 'Stop' });
    f.command(f.owner, 'question.answer', { id: q.id, expectedRevision: q.revision, body: 'Yes' });
    assert.equal(f.store.get('execution', 'execution').state, 'waiting');
    f.command(f.owner, 'task.create', { id: 'child', title: 'Child', parentId: 'task' });
    assert.throws(() => f.command(f.owner, 'task.update', { id: 'task', expectedRevision: f.store.get('task', 'task').revision,
      changes: { parentId: 'child' } }), { code: 'invalid_graph' });
  } finally { f.store.close(); }
});

test('failed mutations roll back their entities, events and idempotency receipts together', () => {
  const f = fixture();
  try {
    const before = f.store.events().items.length;
    assert.throws(() => f.command(f.owner, 'task.create', { id: 'broken', title: 'Broken', dependencies: ['missing'] }, 'broken'), { code: 'not_found' });
    assert.equal(f.store.get('task', 'broken', false), null);
    assert.equal(f.store.events().items.length, before);
    assert.equal(f.command(f.owner, 'task.create', { id: 'broken', title: 'Fixed' }, 'broken').revision, 1);
  } finally { f.store.close(); }
});

test('native HTTP requires ingress and actor credentials and serves durable event cursors', async () => {
  const backend = await startBackend({ database: ':memory:', ingressKeys: ['ingress-fixture'] });
  try {
    const token = backend.store.bootstrap().token;
    assert.equal((await fetch(`${backend.origin}/v1/info`)).status, 401);
    const headers = { 'X-API-Key': 'ingress-fixture', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const response = await fetch(`${backend.origin}/v1/commands`, { method: 'POST', headers,
      body: JSON.stringify({ key: 'create', action: 'task.create', payload: { id: 't', title: 'Task' } }) });
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(`${backend.origin}/v1/tasks/t`, { headers })).json()).title, 'Task');
    const page = await (await fetch(`${backend.origin}/v1/events?limit=1`, { headers })).json();
    assert.equal(page.items[0].type, 'task.create');
    const next = await (await fetch(`${backend.origin}/v1/events?cursor=${page.cursor}`, { headers })).json();
    assert.equal(next.items.length, 0);
    backend.store.command(backend.store.authenticate(token), { key: 'revoke', action: 'credential.revoke', payload: { id: backend.store.authenticate(token).credentialId } });
    assert.equal((await fetch(`${backend.origin}/v1/info`, { headers })).status, 401);
  } finally { await backend.close(); }
});
