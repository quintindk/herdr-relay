import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-coordinator-service-'));
  const requests = [], issues = {
    parent: { id: 'parent', companyId: 'company', assigneeAgentId: 'agent-reviewer', status: 'in_progress' },
    child: { id: 'child', companyId: 'company', parentId: 'parent', assigneeAgentId: 'agent-worker', status: 'in_review' },
  };
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined,
      token: req.headers.authorization, runId: req.headers['x-paperclip-run-id'] });
    res.setHeader('Content-Type', 'application/json');
    const match = req.url.match(/^\/api\/issues\/(parent|child)(\/comments)?$/);
    if (req.method === 'GET' && match) res.end(JSON.stringify(match[2] ? [] : issues[match[1]]));
    else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
  });
  let service;
  t.after(async () => {
    await service?.close(); await new Promise(resolve => backend.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(directory, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  const store = service.store, workers = {}, bridges = {};
  for (const id of ['origin', 'reviewer', 'worker', 'other']) {
    workers[id] = store.register({ id, companyId: 'company', agentId: `agent-${id}`, harness: 'opencode',
      instanceId: 'instance', conversationId: `chat-${id}` });
    const observed = store.saveOperation({ id: `herdr-agent:${id}`, runId: '', agentId: `agent-${id}`, availability: 'present',
      identity: { conversationId: `chat-${id}` }, placement: { directory: `/work/${id}`, terminalId: `terminal-${id}` } });
    bridges[id] = store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true,
      identity: { bindingId: id, observedId: observed.id, conversationId: `chat-${id}`, ...observed.placement },
      tokenHash: digest(`bridge-${id}`), epoch: `epoch-${id}`, sessionCreatedAt: 100, lastSeen: new Date().toISOString() });
  }
  const origin = { bindingId: 'origin', conversationId: 'chat-origin', sessionCreatedAt: 100 };
  const parent = store.saveOperation({ id: 'operator-task:parent', runId: '', state: 'recorded',
    request: { companyId: 'company', relayReviewPolicy: 'human', body: { assigneeAgentId: 'agent-reviewer' },
      origin: { ...origin, sourceMessageId: 'parent-human', sourceDigest: digest('Create root task') } },
    receipt: { ...issues.parent } });
  const fields = id => ({ epoch: `epoch-${id}`, conversationId: `chat-${id}`, terminalId: `terminal-${id}`, sessionCreatedAt: 100, idle: true });
  const source = { id: 'grant-human', text: 'Let the parent coordinator review opted-in direct children.', createdAt: 200 };
  const input = { ...fields('origin'), key: 'grant', parentTaskId: 'parent', reviewerBindingId: 'reviewer', source };
  const connection = token => ({ socketPath: service.socketPath, token });
  const native = (action, changes = {}, id = 'origin') => call(connection(`bridge-${id}`), 'POST', `/bridge/${action}`,
    { ...input, ...fields(id), ...changes });
  const dispatch = async (bindingId, taskId) => {
    const run = store.dispatch({ bindingId, bindingRevision: 1, companyId: 'company', agentId: `agent-${bindingId}`,
      taskId, runId: `backend-${bindingId}-${taskId}` });
    await call(service, 'POST', `/runs/${run.id}/attach`, { token: `adapter-${bindingId}`, runId: run.request.runId });
    await call(connection(workers[bindingId].token), 'POST', `/runs/${run.id}/acknowledge`, {});
    return store.run(run.id);
  };
  return { service, store, workers, bridges, origin, parent, source, input, requests, issues, fields, connection, native, dispatch };
}

test('coordinator native routes reject worker credentials and validate native identity before granting or revoking', async t => {
  const f = await fixture(t);
  for (const action of ['grant-review', 'revoke-review']) {
    for (const [token, code, status] of [['unknown', 'unauthorised', 401],
      ...Object.values(f.workers).map(worker => [worker.token, 'forbidden', 403])]) {
      await assert.rejects(call(f.connection(token), 'POST', `/bridge/${action}`, f.input), { code, status });
    }
    await assert.rejects(call(f.connection('bridge-origin'), 'GET', `/bridge/${action}`), { code: 'forbidden', status: 403 });
    for (const change of [{ conversationId: 'chat-other' }, { terminalId: 'other-terminal' }, { sessionCreatedAt: 101 }]) {
      await assert.rejects(f.native(action, change), { code: 'bridge_identity_mismatch', status: 409 });
    }
    for (const change of [{ origin: f.origin }, { companyId: 'company' }]) {
      await assert.rejects(f.native(action, change), { code: 'invalid_request' });
    }
  }
  assert.deepEqual(f.requests, [], 'Credential and native identity checks must precede backend access');
  assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'coordinator-review-grant:%'").get().count, 0);
});

test('only the exact human-origin root chat can grant its assigned coordinator and revoke with later human input', async t => {
  const f = await fixture(t);
  for (const id of ['reviewer', 'worker', 'other']) {
    await assert.rejects(f.native('grant-review', {}, id), { code: 'invalid_coordinator_parent', status: 403 });
  }
  for (const change of [
    { request: { origin: { ...f.parent.request.origin, conversationId: 'different-chat' } } },
    { request: { origin: { ...f.parent.request.origin, sessionCreatedAt: 99 } } },
    { request: { origin: { ...f.parent.request.origin, sourceMessageId: '' } } },
    { request: { body: { ...f.parent.request.body, parentId: 'grandparent' } } },
    { receipt: { ...f.parent.receipt, parentId: 'grandparent' } },
    { request: { relayReviewPolicy: 'none' } },
  ]) {
    f.store.saveOperation({ ...f.parent, ...change, request: { ...f.parent.request, ...change.request } });
    await assert.rejects(f.native('grant-review'), { code: 'invalid_coordinator_parent' });
    f.store.saveOperation(f.parent);
  }
  for (const reviewerBindingId of ['origin', 'worker', 'other']) {
    await assert.rejects(f.native('grant-review', { reviewerBindingId }), { code: 'invalid_coordinator_reviewer' });
  }
  assert.deepEqual(f.requests, [], 'Local root-origin and reviewer checks must precede backend access');
  for (const change of [{ companyId: 'other' }, { parentId: 'grandparent' }, { assigneeAgentId: 'agent-other' },
    { assigneeUserId: 'human' }, { status: 'done' }]) {
    f.issues.parent = { ...f.parent.receipt, ...change };
    await assert.rejects(f.native('grant-review'), { code: 'coordinator_parent_scope_changed', status: 409 });
  }
  f.issues.parent = { ...f.parent.receipt };
  const receipt = await f.native('grant-review');
  assert.deepEqual(receipt, { grantId: `coordinator-review-grant:${digest([f.origin, 'parent', 'grant'])}`,
    state: 'active', companyId: 'company', parentTaskId: 'parent', reviewerBindingId: 'reviewer' });
  assert.deepEqual(await f.native('grant-review'), receipt);
  const grant = f.store.operation(receipt.grantId);
  assert.equal(grant.request.sourceDigest, digest(f.source.text));
  const revoke = { grantId: receipt.grantId, source: { id: 'revoke-human', text: 'Revoke coordinator review.', createdAt: 300 } };
  for (const id of ['reviewer', 'worker', 'other']) {
    await assert.rejects(f.native('revoke-review', revoke, id), { code: 'coordinator_grant_not_found', status: 404 });
  }
  for (const source of [f.source, { ...revoke.source, createdAt: 200 }, { ...revoke.source, id: f.source.id }]) {
    await assert.rejects(f.native('revoke-review', { ...revoke, source }), { code: 'invalid_coordinator_source', status: 409 });
  }
  assert.deepEqual(f.store.operation(receipt.grantId), grant, 'Rejected revocation must retain the exact grant');
  const before = f.requests.length;
  assert.deepEqual(await f.native('revoke-review', revoke), { ...receipt, state: 'revoked' });
  assert.deepEqual(await f.native('revoke-review', revoke), { ...receipt, state: 'revoked' });
  assert.equal(f.requests.length, before, 'Revocation and its retry are local');
  await assert.rejects(f.native('grant-review'), { code: 'coordinator_grant_inactive', status: 409 });
  assert.equal(f.requests.some(request => request.method !== 'GET'), false, 'Grant authority never mutates the backend');
});

test('grant and revoke reject non-human sources, notifications, Relay prompts and active worker turns', async t => {
  const f = await fixture(t);
  const receipt = await f.native('grant-review');
  f.store.saveOperation({ id: 'completion-notification:fixture', runId: '', origin: f.origin, messageId: 'notification', state: 'announced' });
  const run = f.store.dispatch({ bindingId: 'origin', bindingRevision: 1, companyId: 'company', agentId: 'agent-origin',
    taskId: 'unrelated', runId: 'backend-origin' });
  f.store.save({ ...run, nativeState: 'settled', settlement: { outcome: 'cancelled' },
    invocation: { messageId: 'relay-prompt', priorUserIds: ['prior-human'] } }, 'fixture.settled');
  const before = f.requests.length, grant = f.store.operation(receipt.grantId);
  for (const action of ['grant-review', 'revoke-review']) {
    for (const source of [undefined, { ...f.source, id: '' }, { ...f.source, text: ' ' },
      { ...f.source, synthetic: true }, { ...f.source, ignored: true }, { ...f.source, role: 'assistant' },
      { ...f.source, createdAt: 99 }, { ...f.source, createdAt: Date.now() + 60000 },
      { ...f.source, createdAt: 200.5 }, ...['notification', 'relay-prompt', 'prior-human'].map(id => ({ ...f.source, id }))]) {
      await assert.rejects(f.native(action, { grantId: receipt.grantId, source }), { code: 'invalid_coordinator_source', status: 409 });
    }
    const settled = f.store.run(run.id);
    f.store.save({ ...settled, nativeState: 'claimed' }, 'fixture.active');
    await assert.rejects(f.native(action, { grantId: receipt.grantId }), { code: 'conversation_busy', status: 409 });
    f.store.save(settled, 'fixture.settled');
  }
  assert.equal(f.requests.length, before, 'Invalid authority never reaches backend validation');
  assert.deepEqual(f.store.operation(receipt.grantId), grant);
});

test('task and child inspection expose active coordinator authority only in its exact parent reviewer scope', async t => {
  const f = await fixture(t);
  const receipt = await f.native('grant-review');
  const grant = f.store.operation(receipt.grantId);
  f.store.saveOperation({ id: 'operator-task:child', runId: '', state: 'recorded', request: {
    companyId: 'company', origin: f.parent.request.origin, relayReviewPolicy: 'coordinator', relayReviewGrantId: grant.id,
    body: { parentId: 'parent', assigneeAgentId: 'agent-worker' },
  }, receipt: { ...f.issues.child } });
  const reviewer = await f.dispatch('reviewer', 'parent');
  const other = await f.dispatch('other', 'parent');
  const child = await f.dispatch('worker', 'child');
  f.store.submit(child.id, { key: 'result', candidate: 'revision', summary: 'Independent checks passed' });
  f.store.recordReview(child.id, { interactionId: 'review', status: 'pending', candidate: 'revision' });
  const request = (run, method, action, body) => call(f.connection(f.workers[run.request.bindingId].token), method, `/runs/${run.id}/${action}`, body);
  const expected = [{ grantId: grant.id, scope: 'direct_children', parentTaskId: 'parent' }];
  const parentTask = await request(reviewer, 'GET', 'task');
  assert.equal(parentTask.relayReviewPolicy, 'human', 'Parent final review remains human');
  assert.deepEqual(parentTask.coordinatorReviewGrants, expected);
  assert.equal((await request(other, 'GET', 'task')).coordinatorReviewGrants, undefined);
  const childTask = await request(child, 'GET', 'task');
  assert.equal(childTask.relayReviewPolicy, 'coordinator');
  assert.equal(childTask.coordinatorReviewGrants, undefined, 'A child worker does not inherit parent authority');
  for (const token of [f.workers.other.token, f.workers.worker.token, 'bridge-reviewer']) {
    await assert.rejects(call(f.connection(token), 'GET', `/runs/${reviewer.id}/task`), { code: 'forbidden', status: 403 });
  }
  const review = { runId: child.id, candidate: 'revision', summary: 'Independent checks passed',
    state: 'pending', interactionId: 'review', grantId: grant.id };
  assert.deepEqual(await request(reviewer, 'POST', 'child', { taskId: 'child' }), { task: f.issues.child, comments: [], relayReview: review });
  assert.deepEqual((await request(other, 'POST', 'child', { taskId: 'child' })).relayReview, { ...review, grantId: null });
  f.issues.child.parentId = 'foreign-parent';
  assert.deepEqual(await request(reviewer, 'POST', 'child', { taskId: 'child' }),
    { task: f.issues.child, comments: [], relayReview: { ...review, grantId: null } },
    'Unrelated same-company tasks remain readable without advertising coordinator authority');
  f.issues.child.parentId = 'parent';
  f.store.save({ ...reviewer, request: { ...reviewer.request, taskId: 'unrelated-parent' } }, 'test.parent.changed');
  assert.equal((await request(reviewer, 'POST', 'child', { taskId: 'child' })).relayReview.grantId, null,
    'Another run in the reviewer binding does not inherit this parent grant');
  f.store.save(reviewer, 'test.parent.restored');
  for (const change of [{ state: 'revoked' }, { request: { ...grant.request, parentTaskId: 'other-parent' } },
    { request: { ...grant.request, companyId: 'other-company' } }, { request: { ...grant.request, reviewerBindingId: 'other' } }]) {
    f.store.saveOperation({ ...grant, ...change });
    assert.equal((await request(reviewer, 'GET', 'task')).coordinatorReviewGrants, undefined);
    assert.equal((await request(reviewer, 'POST', 'child', { taskId: 'child' })).relayReview.grantId, null);
    f.store.saveOperation(grant);
  }
  f.store.saveOperation({ ...f.bridges.reviewer, sessionCreatedAt: 101 });
  assert.equal((await request(reviewer, 'GET', 'task')).coordinatorReviewGrants, undefined, 'A replacement native session loses the grant');
  assert.equal((await request(reviewer, 'POST', 'child', { taskId: 'child' })).relayReview.grantId, null);
  f.store.saveOperation(f.bridges.reviewer);
  assert.deepEqual((await request(reviewer, 'GET', 'task')).coordinatorReviewGrants, expected);
  const reads = f.requests.filter(request => request.runId);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(request => request.token === `Bearer adapter-${request.runId.split('-')[1]}`),
    'Inspection uses the attached backend credential, not the worker or native bridge credential');
  assert.equal(f.requests.some(request => request.method !== 'GET'), false, 'All inspection is read-only');
});
