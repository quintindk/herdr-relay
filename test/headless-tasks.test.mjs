import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { headlessExecutionScope, headlessReferenceLookup } from '../src/headless-tasks.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';

function fixture(t, { capabilities = true, readiness = false, directory = '/workspace', taskActions = ['task.create', 'task.update', 'comment.create', 'reference.attach'] } = {}) {
  const store = new BackendStore(':memory:'); t.after(() => store.close()); const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Fixture' }); const node = store.authenticate(store.enrolCredential(owner, 'node', 'token').token);
  command(owner, 'agent', 'agent.enrol', { id: 'coordinator', nodeId: 'node', name: 'Coordinator', directory });
  command(owner, 'attach', 'agent.attach', { id: 'coordinator', expectedBindingRevision: 0, conversationId: 'ses_coordinator', directory, bindingId: 'binding_coordinator' });
  command(owner, 'grant', 'headless.grant', { id: 'grant', requesterAgentId: 'coordinator', nodeId: 'node', name: 'approved-worker', directory,
    model: { providerID: 'fixture', id: 'fixture', integrationID: 'fixture', connectionId: 'fixture' }, workiq: { server: 'workiq', readTool: 'workiq_read', probeInput: { query: 'bounded' } },
    contract: '.opencode/skills/approved-job/SKILL.md', schedule: { id: 'schedule', cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' },
    ...(capabilities ? { capabilities: { sourceNamespaces: ['external:record'], taskActions, artifacts: { receipts: 'approved/receipts', state: 'approved/state.json', history: 'approved/history', runs: 'approved/runs', summaries: 'approved/summaries' } } } : {}) });
  const setup = command(node, 'setup', 'headless.request', { grantId: 'grant', requesterAgentId: 'coordinator', sourceConversationId: 'ses_coordinator', sourceBindingRevision: 1 });
  const agent = command(node, 'register', 'headless.register', { id: setup.id });
  command(node, 'advertise', 'agent.advertise', { id: agent.id, expectedRevision: agent.revision, availability: 'available', conversationId: setup.sessionId, bindingRevision: 1 });
  let execution;
  if (readiness) execution = command(node, 'probe', 'headless.probe', { id: setup.id });
  else { store.save('headless_setup', { ...setup, state: 'ready' }); const task = command(owner, 'control', 'task.create', { id: 'control', title: 'Job control' }); execution = command(owner, 'job', 'execution.request', { id: 'job', taskId: task.id, taskRevision: task.revision, targetAgentId: agent.id, instructions: 'Bounded fixture' }); }
  execution = command(node, 'admit', 'execution.admit', { id: execution.id, expectedRevision: execution.revision, bindingId: setup.bindingId, runId: 'run' });
  const source = { namespace: 'external:record', externalId: 'record-one' };
  const mutate = (operation, key, payload, changes = {}) => command(node, `transport:${execution.id}:${key}`, 'headless.task', { executionId: execution.id, runId: execution.runId, operation, source, key, payload, ...changes });
  return { store, owner, node, command, setup, execution, source, mutate };
}

test('approved headless task capabilities retain human ownership, revisions, source identity and idempotency', t => {
  const f = fixture(t), created = f.mutate('task.create', 'capture', { title: 'An evidenced record' });
  assert.equal(f.store.get('task', created.taskId).responsibleUserId, 'owner'); assert.deepEqual(f.mutate('task.create', 'capture', { title: 'An evidenced record' }), created);
  const updated = f.mutate('task.update', 'update', { id: created.taskId, expectedRevision: created.taskRevision, changes: { priority: 'high' } });
  f.mutate('comment.create', 'comment', { taskId: created.taskId, expectedRevision: updated.taskRevision, body: 'Evidence verified' });
  const alias = { ...f.source, externalId: 'alias' }; f.mutate('reference.attach', 'reference', { id: created.taskId, expectedRevision: updated.taskRevision }, { source: alias });
  assert.equal(headlessReferenceLookup(f.store, f.node, { executionId: f.execution.id, runId: f.execution.runId, reference: alias }).matches[0].task.id, created.taskId);
  assert.equal(f.store.all('comment').length, 1);
  assert.throws(() => f.mutate('task.update', 'stale', { id: created.taskId, expectedRevision: 0, changes: { title: 'Stale' } }), { code: 'stale_revision' });
});

test('logical operation retries across runs never duplicate or overwrite later human edits', t => {
  const f = fixture(t), original = f.mutate('task.create', 'capture', { title: 'Capture once' });
  f.command(f.owner, 'edit', 'task.update', { id: original.taskId, expectedRevision: original.taskRevision, changes: { description: 'Later edit' } });
  f.store.save('execution', { ...f.execution, runId: 'next-run' });
  const retry = f.command(f.node, 'next-transport', 'headless.task', { executionId: f.execution.id, runId: 'next-run', operation: 'task.create', source: f.source, key: 'capture', payload: { title: 'Capture once' } });
  assert.deepEqual(retry, original); assert.equal(f.store.all('task').length, 2); assert.equal(f.store.get('task', original.taskId).description, 'Later edit');
});

test('read-only and action-limited profiles, wrong sources/runs, cancellation and escalation fields fail closed', t => {
  const readOnly = fixture(t, { capabilities: false }); assert.throws(() => readOnly.mutate('task.create', 'denied', { title: 'Denied' }), { code: 'headless_capability_not_authorised' });
  const comments = fixture(t, { taskActions: ['comment.create'] }); assert.throws(() => comments.mutate('task.create', 'denied', { title: 'Denied' }), { code: 'headless_operation_forbidden' });
  const f = fixture(t);
  assert.throws(() => f.mutate('task.delete', 'delete', { id: 'control' }), { code: 'headless_operation_forbidden' });
  assert.throws(() => f.mutate('task.create', 'source', { title: 'Denied' }, { source: { namespace: 'other', externalId: 'one' } }), { code: 'headless_source_forbidden' });
  assert.throws(() => f.mutate('task.create', 'spoof-owner', { title: 'Denied', responsibleUserId: 'other' }), { code: 'invalid_headless_request' });
  assert.throws(() => f.mutate('task.create', 'stale-run', { title: 'Denied' }, { runId: 'old' }), { code: 'headless_execution_inactive' });
  f.store.save('execution', { ...f.execution, cancellationRequested: true }); assert.throws(() => f.mutate('task.create', 'cancelled', { title: 'Denied' }), { code: 'headless_execution_inactive' });
});

test('headless mutations cannot edit unsettled tasks or tasks owned by someone else', t => {
  const f = fixture(t); assert.throws(() => f.mutate('task.update', 'busy', { id: 'control', expectedRevision: f.store.get('task', 'control').revision, changes: { title: 'Denied' } }), { code: 'headless_task_busy' });
  const task = f.mutate('task.create', 'capture', { title: 'Originally owned' }); f.store.save('task', { ...f.store.get('task', task.taskId), responsibleUserId: 'other' });
  assert.throws(() => f.mutate('comment.create', 'foreign', { taskId: task.taskId, expectedRevision: task.taskRevision, body: 'Denied' }), { code: 'headless_task_forbidden' });
});

test('readiness canaries verify only granted actions and roll back every task/comment/reference', t => {
  for (const taskActions of [['task.create', 'task.update', 'comment.create', 'reference.attach'], ['comment.create']]) {
    const f = fixture(t, { readiness: true, taskActions }), before = f.store.snapshot();
    assert.throws(() => f.mutate('task.create', 'real', { title: 'Denied' }), { code: 'headless_probe_forbidden' });
    const proof = f.command(f.node, 'capability', 'headless.capability_probe', { executionId: f.execution.id, runId: f.execution.runId });
    assert.equal(proof.capabilityProbe.rolledBack, true); assert.deepEqual(proof.capabilityProbe.taskActions, taskActions);
    for (const kind of ['task', 'comment']) assert.deepEqual(f.store.all(kind), before.collections[kind]); assert.equal(f.store.all('reference').length, 0);
  }
});

test('worker routes reconcile lost replies and cached uncertain audit writes, then commit a job-defined checkpoint', async t => {
  const root = mkdtempSync('/tmp/opencode/headless-http-test-'), f = fixture(t, { directory: root });
  const journal = new NodeJournal(join(root, 'node.sqlite'), { nodeId: 'node', instanceId: f.store.instance });
  journal.save({ id: f.execution.id, state: 'observing', execution: f.execution, bindingId: f.setup.bindingId, nativeConversationId: f.setup.sessionId });
  let offline = false, loseReply = true;
  const api = async (method, path, body) => {
    if (offline) throw Error('Fixture offline');
    if (path === '/v1/headless/read') { const scope = headlessExecutionScope(f.store, f.node, body); return body.operation === 'references' ? headlessReferenceLookup(f.store, f.node, body) : { id: scope.setup.id, directory: scope.setup.directory, profile: scope.profile, readiness: false }; }
    const value = f.store.command(f.node, body); if (loseReply && body.action === 'headless.task') { loseReply = false; throw Error('Lost committed reply'); } return value;
  };
  const socketPath = join(root, 'node.sock'), service = await startNodeService({ journal, socketPath, api, workers: [{ token: 'fixture', agentId: f.setup.agentId, sessionId: f.setup.sessionId, headlessSetupId: f.setup.id }] });
  t.after(async () => { await service.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const connection = { socketPath, token: 'fixture' }, scope = { executionId: f.execution.id, runId: f.execution.runId };
  const request = { ...scope, key: 'capture', payload: { key: 'capture', operation: 'task.create', source: f.source, payload: { title: 'HTTP capture' } } };
  await assert.rejects(call(connection, 'POST', '/work/headless-task', request)); offline = true;
  const record = { operation: 'receipt', key: 'uncertain', source: f.source, action: 'task.create', expectedRevision: 0, status: 'uncertain', data: { originalKey: 'capture' } };
  const pending = await call(connection, 'POST', '/work/headless-artifacts', { ...scope, payload: record }); assert.equal(pending.authorisation, 'cached_uncertain_audit_only');
  await assert.rejects(call(connection, 'POST', '/work/headless-artifacts', { ...scope, payload: { operation: 'checkpoint', key: 'offline' } })); offline = false;
  const applied = await call(connection, 'POST', '/work/headless-task', request); assert.equal(applied.state, 'recorded'); assert.equal(f.store.all('task').length, 2);
  const durable = await call(connection, 'POST', '/work/headless-artifacts', { ...scope, payload: { ...record, key: 'confirmed', expectedRevision: pending.revision, status: 'applied', data: { operationId: applied.receipt.id } } });
  const checkpoint = await call(connection, 'POST', '/work/headless-artifacts', { ...scope, payload: { operation: 'checkpoint', key: 'checkpoint', expectedRevision: 0, data: { opaqueCursor: 'belongs-to-job' }, receiptIds: [durable.id] } }); assert.equal(checkpoint.revision, 1);
  f.store.save('execution', { ...f.store.get('execution', f.execution.id), cancellationRequested: true }); await assert.rejects(call(connection, 'POST', '/work/headless-task', request), { code: 'headless_execution_inactive' });
});
