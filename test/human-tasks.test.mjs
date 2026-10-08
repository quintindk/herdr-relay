import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { humanTask } from '../src/human-tasks.mjs';
import { createOperatorTask } from '../src/operations.mjs';
import { digest } from '../src/protocol.mjs';

function fixture(t, file = ':memory:') {
  const store = new Store(file);
  t.after(() => store.close());
  const task = { id: 'task', companyId: 'company', identifier: 'TEST-1', title: 'Human work', description: 'Full description\n'.repeat(200),
    parentId: null, projectId: null, assigneeUserId: 'human', assigneeAgentId: null, status: 'todo', priority: 'medium', updatedAt: '2026-10-08T00:00:00Z' };
  const state = { task, company: { id: 'company', defaultResponsibleUserId: 'default-human' }, interactions: [], children: [],
    resources: new Map(), creations: new Map(), calls: [], hook: null, patch: null, post: null };
  const api = async (method, path, body) => {
    state.calls.push({ method, path, ...(body ? { body: structuredClone(body) } : {}) });
    await state.hook?.(method, path, body);
    let value;
    if (method === 'PATCH') {
      assert.equal(path, '/api/issues/task');
      if (state.patch) return state.patch(body);
      Object.assign(state.task, body, { updatedAt: '2026-10-08T00:01:00Z' });
      value = state.task;
    } else if (method === 'POST') {
      assert.equal(path, '/api/companies/company/issues');
      if (!state.creations.has(body.idempotencyKey)) state.creations.set(body.idempotencyKey,
        { ...structuredClone(task), ...body, id: `created-${state.creations.size}` });
      value = state.creations.get(body.idempotencyKey);
      await state.post?.(value, body);
    } else {
      assert.equal(method, 'GET');
      if (path === '/api/companies/company') value = state.company;
      else if (path.endsWith('/interactions')) value = state.interactions;
      else if (path.startsWith('/api/companies/company/issues?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        assert.equal(query.get('parentId'), 'task');
        assert.equal(query.get('limit'), '1');
        assert.equal(query.get('status'), 'backlog,todo,in_progress,blocked,in_review');
        value = state.children;
      } else if (path === '/api/issues/task') value = state.task;
      else value = state.resources.get(path) ?? [...state.creations.values()].find(item => path === `/api/issues/${item.id}`);
      assert.ok(value !== undefined, `Unexpected API path: ${path}`);
    }
    return structuredClone(value);
  };
  const inspect = () => humanTask(store, api, { action: 'inspect', companyId: 'company', taskId: 'task' });
  const input = async (action, payload, key = 'change') => ({ action, companyId: 'company', taskId: 'task', key,
    expectedRevision: (await inspect()).revision, ...(payload === undefined ? {} : { payload }) });
  const writes = () => state.calls.filter(call => call.method !== 'GET');
  return { store, state, api, inspect, input, writes };
}

function runFor(f, overrides = {}) {
  const binding = f.store.binding('worker', false) ?? f.store.register({ id: 'worker', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'instance', conversationId: 'conversation' }).binding;
  const run = f.store.dispatch({ bindingId: binding.id, bindingRevision: binding.revision, companyId: 'company',
    agentId: 'agent', runId: `backend-${f.store.runs().length}`, taskId: 'task' });
  return f.store.save({ ...run, ...overrides }, 'test');
}

function readyBridge(f) {
  const binding = f.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode',
    instanceId: digest(['machine', 'session']), conversationId: 'conversation' }).binding;
  f.state.resources.set('/api/agents/agent', { id: 'agent', companyId: 'company' });
  f.store.saveOperation({ id: 'observed', runId: '', availability: 'present', agentId: 'agent',
    identity: { companyId: 'company', conversationId: 'conversation', machineId: 'machine', session: 'session', harness: 'opencode', sessionKind: 'id' },
    placement: { terminalId: 'terminal', directory: '/repo' } });
  f.store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed', ready: true, epoch: 'epoch', sessionCreatedAt: 1, lastSeen: new Date().toISOString(),
    identity: { bindingId: binding.id, observedId: 'observed', conversationId: 'conversation', terminalId: 'terminal', directory: '/repo' } });
}

test('inspect returns full public text, a revision and default human, without journalling or backend writes', async t => {
  const f = fixture(t);
  f.state.task.assigneeAdapterOverrides = { secret: 'do-not-return' };
  f.state.task.executionPolicy = { secret: 'do-not-return' };
  const first = await f.inspect();
  assert.equal(first.task.description, f.state.task.description);
  assert.equal(first.defaultHumanUserId, 'default-human');
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes('do-not-return'), false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
  assert.equal(f.writes().length, 0);
  f.state.task.executionRunId = 'execution';
  assert.notEqual((await f.inspect()).revision, first.revision);
  f.state.task.executionRunId = null;
  f.state.interactions.push({ id: 'question', status: 'pending' });
  assert.notEqual((await f.inspect()).revision, first.revision);
});

test('rejects foreign tasks, invalid public fields and truncated descriptions', async t => {
  for (const change of [{ companyId: 'other' }, { id: 'other' }, { title: { secret: 'value' } }, { descriptionTruncated: true }]) {
    const f = fixture(t); Object.assign(f.state.task, change);
    await assert.rejects(f.inspect());
    assert.equal(f.writes().length, 0);
  }
});

test('rejects unknown actions, malicious fields, missing revisions and invalid payloads before writes', async t => {
  const f = fixture(t);
  const base = await f.input('edit', { title: 'new' });
  for (const input of [
    { ...base, action: 'delete' }, { ...base, authority: { kind: 'operator' } }, { ...base, origin: {} },
    { ...base, expectedRevision: undefined }, { ...base, key: '' }, { ...base, payload: {} },
    ...['reviewPolicy', 'executionPolicy', 'executionRunId', 'companyId', 'parentId', 'projectId', 'assigneeAgentId', 'idempotencyKey']
      .map(field => ({ ...base, payload: { [field]: 'override' } })),
    ...['done', 'in_review', 'bogus'].map(status => ({ ...base, payload: { status } })),
    { ...base, payload: { description: 7 } }, { ...base, payload: { title: '' } }, { ...base, payload: { priority: 'urgent' } },
    { ...base, action: 'complete', payload: { status: 'done' } }, { ...base, action: 'inspect' },
  ]) await assert.rejects(humanTask(f.store, f.api, input));
  assert.equal(f.writes().length, 0);
});

test('edits send only changed fields, preserve policies, and report actual fresh backend status', async t => {
  const f = fixture(t);
  f.state.task.reviewPolicy = 'human';
  const input = await f.input('edit', { title: 'Renamed', description: f.state.task.description });
  f.state.patch = body => { Object.assign(f.state.task, body, { status: 'blocked' }); return { ...f.state.task, status: 'todo' }; };
  const result = await humanTask(f.store, f.api, input);
  assert.deepEqual(f.writes().map(call => call.body), [{ title: 'Renamed' }]);
  assert.equal(result.task.status, 'blocked');
  assert.equal(result.state, 'recorded');
  assert.equal(result.task.reviewPolicy, undefined);
  f.state.task.status = 'cancelled';
  assert.equal((await humanTask(f.store, f.api, input)).task.status, 'cancelled');
  assert.equal(f.writes().length, 1);
});

test('no-op edits are journalled without PATCH', async t => {
  const f = fixture(t);
  const result = await humanTask(f.store, f.api, await f.input('edit', { title: f.state.task.title }));
  assert.equal(result.state, 'recorded');
  assert.equal(f.writes().length, 0);
});

test('stale revisions and changes during validation cannot PATCH', async t => {
  for (const during of [false, true]) {
    const f = fixture(t);
    const input = await f.input('edit', { title: 'new' });
    if (!during) f.state.task.description = 'changed';
    else {
      let reads = 0;
      f.state.hook = (method, path) => { if (path === '/api/issues/task' && ++reads === 2) f.state.task.assigneeUserId = 'different'; };
    }
    await assert.rejects(humanTask(f.store, f.api, input), { code: 'stale_revision' });
    assert.equal(f.writes().length, 0);
  }
});

test('all mutation types refuse execution holds, pending interactions and unsettled Relay work', async t => {
  for (const action of ['edit', 'assign', 'complete']) {
    for (const hold of ['executionRunId', 'checkoutRunId', 'executionLockedAt', 'activeRun', 'activeRecoveryAction', 'executionBlocker', 'executionState', 'interaction', 'run']) {
      const f = fixture(t);
      if (hold === 'interaction') f.state.interactions.push({ id: 'question', status: 'pending' });
      else if (hold === 'run') runFor(f);
      else f.state.task[hold] = hold === 'executionState' ? { status: 'pending', currentStageId: 'stage' } : 'active';
      const input = await f.input(action, action === 'complete' ? undefined : action === 'assign' ? { assigneeUserId: 'another' } : { title: 'new' });
      await assert.rejects(humanTask(f.store, f.api, input), { code: hold === 'interaction' ? 'interaction_pending' : 'task_busy' });
      assert.equal(f.writes().length, 0);
    }
  }
});

test('human completion needs no candidate or run and reports backend review disposition honestly', async t => {
  for (const status of ['done', 'in_review']) {
    const f = fixture(t);
    f.state.patch = () => { f.state.task.status = status; return { ...f.state.task, status: 'done' }; };
    const result = await humanTask(f.store, f.api, await f.input('complete'));
    assert.equal(result.task.status, status);
    assert.deepEqual(f.writes().map(call => call.body), [{ status: 'done' }]);
    assert.equal(f.store.runs().length, 0);
  }
});

test('completion refuses non-human ownership, review policy, unresolved dependencies and active children', async t => {
  for (const change of [
    { assigneeUserId: null }, { assigneeUserId: null, assigneeAgentId: 'agent' }, { assigneeAgentId: 'agent' },
    { reviewPolicy: 'human' }, { executionPolicy: { stages: [] } }, { status: 'in_review' }, { status: 'cancelled' },
    { status: 'blocked', unblockDescriptor: { owner: 'board', action: 'Resolve access' } }, { liveDescendantCount: 1 },
  ]) {
    const f = fixture(t); Object.assign(f.state.task, change);
    await assert.rejects(humanTask(f.store, f.api, await f.input('complete')));
    assert.equal(f.writes().length, 0);
  }
  for (const status of ['todo', 'cancelled']) {
    const f = fixture(t);
    f.state.task.blockedBy = [{ id: 'dependency', status: 'done' }];
    f.state.resources.set('/api/issues/dependency', { id: 'dependency', companyId: 'company', status });
    await assert.rejects(humanTask(f.store, f.api, await f.input('complete')), { code: 'dependency_unresolved' });
    assert.equal(f.writes().length, 0);
  }
  const f = fixture(t);
  f.state.children.push({ id: 'child', companyId: 'company', parentId: 'task', status: 'todo' });
  await assert.rejects(humanTask(f.store, f.api, await f.input('complete')), { code: 'dependency_unresolved' });
  assert.equal(f.writes().length, 0);
});

test('completion re-reads blockers rather than trusting relationship summaries', async t => {
  const f = fixture(t);
  f.state.task.blockedBy = [{ id: 'dependency', status: 'todo' }];
  f.state.task.blockedByIssueIds = ['dependency'];
  f.state.resources.set('/api/issues/dependency', { id: 'dependency', companyId: 'company', status: 'done' });
  assert.equal((await humanTask(f.store, f.api, await f.input('complete'))).task.status, 'done');
});

test('reassignment cannot bypass prior results, publication, settlement or exact backend acceptance', async t => {
  for (const problem of ['unaccepted', 'unpublished', 'unsettled', 'wrong-candidate', 'missing-backend', 'no-review', 'uncertain']) {
    const f = fixture(t);
    const result = { candidate: 'candidate', key: 'result', summary: 'Agent result' };
    const run = runFor(f, { nativeState: problem === 'unsettled' ? 'claimed' : 'settled', result,
      settlement: { outcome: 'completed' }, publication: { state: problem === 'unpublished' ? 'pending' : 'recorded' },
      review: { status: ['unaccepted', 'no-review'].includes(problem) ? 'pending' : 'accepted', candidate: problem === 'wrong-candidate' ? 'other' : 'candidate', interactionId: 'review' } });
    if (problem !== 'missing-backend') f.state.interactions.push({ id: 'review', status: 'accepted', kind: 'request_confirmation',
      idempotencyKey: `relay-review:${run.id}:${digest(result)}`, payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } });
    if (problem === 'uncertain') f.store.saveOperation({ id: `completion:${run.id}`, runId: run.id, state: 'uncertain' });
    await assert.rejects(humanTask(f.store, f.api, await f.input('complete')));
    assert.equal(f.writes().length, 0);
  }
});

test('accepted settled published history permits human completion only with exact backend evidence', async t => {
  const f = fixture(t);
  const result = { candidate: 'candidate', key: 'result', summary: 'Agent result' };
  const run = runFor(f, { nativeState: 'settled', result, settlement: { outcome: 'completed' }, publication: { state: 'recorded' },
    review: { status: 'accepted', candidate: 'candidate', interactionId: 'review' } });
  f.state.interactions.push({ id: 'review', status: 'accepted', kind: 'request_confirmation',
    idempotencyKey: `relay-review:${run.id}:${digest(result)}`, payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } });
  assert.equal((await humanTask(f.store, f.api, await f.input('complete'))).task.status, 'done');
});

test('assignment explicitly clears opposite ownership and never includes status, wake or policy overrides', async t => {
  for (const payload of [{ assigneeAgentId: 'agent' }, { assigneeUserId: 'another' }, { assigneeUserId: null }, { assigneeAgentId: null },
    { assigneeAgentId: null, assigneeUserId: null }]) {
    const f = fixture(t);
    if (payload.assigneeAgentId) f.state.resources.set('/api/agents/agent', { id: 'agent', companyId: 'company' });
    const input = { ...await f.input('assign', payload), reason: 'Explicitly assign this task' };
    await humanTask(f.store, f.api, input);
    assert.deepEqual(f.writes().map(call => call.body), [{ assigneeAgentId: null, assigneeUserId: null, ...payload }]);
  }
});

test('assignment rejects missing wake reason, two assignees, invalid values and foreign agents', async t => {
  const f = fixture(t);
  for (const payload of [{}, { assigneeAgentId: 'agent', assigneeUserId: 'human' }, { assigneeAgentId: 'agent', assigneeUserId: null },
    { assigneeUserId: '' }, { assigneeAgentId: 1 }, { wake: true }, { assigneeAgentId: 'agent' }]) {
    await assert.rejects(humanTask(f.store, f.api, await f.input('assign', payload)));
  }
  f.state.resources.set('/api/agents/agent', { id: 'agent', companyId: 'other' });
  await assert.rejects(humanTask(f.store, f.api, { ...await f.input('assign', { assigneeAgentId: 'agent' }), reason: 'Delegate' }), { code: 'forbidden' });
  assert.equal(f.writes().length, 0);
});

test('agent assignment requires fresh ready bridge and worker admission, including final revalidation', async t => {
  for (const problem of ['none', 'not-ready', 'stale', 'offline', 'active', 'grant', 'changed-during-read']) {
    const f = fixture(t); readyBridge(f);
    if (['not-ready', 'stale'].includes(problem)) f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'),
      ...(problem === 'not-ready' ? { ready: false } : { lastSeen: '2000-01-01T00:00:00Z' }) });
    if (problem === 'offline') f.store.saveOperation({ ...f.store.operation('observed'), availability: 'offline' });
    if (problem === 'active') {
      const run = runFor(f);
      f.store.save({ ...run, request: { ...run.request, taskId: 'other-task' } }, 'test');
    }
    if (problem === 'grant') f.store.saveOperation({ id: 'herdr-worker:grant', runId: '', bindingId: 'worker', state: 'blocked' });
    const input = { ...await f.input('assign', { assigneeAgentId: 'agent' }), reason: 'Explicit delegation' };
    if (problem === 'changed-during-read') f.state.hook = () => {
      f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'), ready: false });
    };
    if (problem === 'none') assert.equal((await humanTask(f.store, f.api, input)).task.assigneeAgentId, 'agent');
    else {
      await assert.rejects(humanTask(f.store, f.api, input), { code: problem === 'grant' ? 'worker_grant_inactive' : 'agent_not_ready' });
      assert.equal(f.writes().length, 0);
    }
  }
});

test('uncertain PATCH committed or uncommitted is read-only on every retry, including after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'human-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const committed of [true, false]) {
    const file = join(directory, `${committed}.sqlite`);
    const f = fixture(t, file);
    const input = await f.input('edit', { title: 'Requested change' });
    f.state.patch = body => {
      if (committed) Object.assign(f.state.task, body);
      throw new Error('Lost response');
    };
    await assert.rejects(humanTask(f.store, f.api, input), /Lost response/);
    const reopened = new Store(file); t.after(() => reopened.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      if (committed) {
        const result = await humanTask(reopened, f.api, input);
        assert.equal(result.state, 'recorded'); assert.equal(result.reconciled, true);
      } else await assert.rejects(humanTask(reopened, f.api, input), { code: 'operation_uncertain' });
    }
    assert.equal(f.writes().length, 1);
    await assert.rejects(humanTask(reopened, f.api, { ...input, payload: { title: 'Different' } }), { code: 'operation_conflict' });
  }
});

test('uncertain mutation cannot reconcile changed ownership or wrong-company readback', async t => {
  for (const change of [{ assigneeUserId: 'other' }, { assigneeAgentId: 'agent' }, { companyId: 'other' }]) {
    const f = fixture(t); const input = await f.input('edit', { title: 'Changed' });
    f.state.patch = body => { Object.assign(f.state.task, body, change); throw new Error('Lost response'); };
    await assert.rejects(humanTask(f.store, f.api, input));
    await assert.rejects(humanTask(f.store, f.api, input), { code: change.companyId ? 'forbidden' : 'operation_uncertain' });
    assert.equal(f.writes().length, 1);
  }
});

test('uncertain assignment and completion reconcile exact outcomes without another PATCH', async t => {
  for (const action of ['assign', 'complete']) {
    const f = fixture(t);
    const input = await f.input(action, action === 'assign' ? { assigneeUserId: 'another' } : undefined);
    f.state.patch = body => { Object.assign(f.state.task, body); throw new Error('Lost response'); };
    await assert.rejects(humanTask(f.store, f.api, input));
    assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
    assert.equal(f.writes().length, 1);
  }
});

test('lost fresh receipt leaves uncertain intent and does not trust the PATCH response', async t => {
  const f = fixture(t);
  const input = await f.input('complete');
  let written = false;
  f.state.patch = body => { Object.assign(f.state.task, body); written = true; return f.state.task; };
  f.state.hook = (method, path) => { if (written && method === 'GET' && path === '/api/issues/task') throw new Error('Read failed'); };
  await assert.rejects(humanTask(f.store, f.api, input), /Read failed/);
  f.state.hook = null;
  assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
  assert.equal(f.writes().length, 1);
});

test('authority is checked after every awaited API call and before mutation dispatch', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'Changed' });
  let valid = true;
  const check = () => assert.ok(valid, 'authority revoked');
  f.state.hook = (method, path) => { if (path.endsWith('/interactions')) valid = false; };
  await assert.rejects(humanTask(f.store, f.api, input, { check }), /authority revoked/);
  assert.equal(f.writes().length, 0);
});

test('Relay state changes during the final backend read are rejected', async t => {
  const f = fixture(t);
  const input = await f.input('complete');
  let reads = 0;
  f.state.hook = (method, path) => { if (path.endsWith('/interactions') && ++reads === 2) runFor(f); };
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'stale_revision' });
  assert.equal(f.writes().length, 0);
});

test('authority revocation after PATCH prevents recording success but preserves recovery intent', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'Changed' });
  let valid = true;
  f.state.patch = body => { Object.assign(f.state.task, body); valid = false; return f.state.task; };
  await assert.rejects(humanTask(f.store, f.api, input, { check: () => assert.ok(valid, 'revoked') }), /revoked/);
  assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
  assert.equal(f.writes().length, 1);
});

test('creation uses the default human, no native origin restriction, and separate operator namespace', async t => {
  const f = fixture(t);
  f.state.resources.set('/api/issues/imported-parent', { id: 'imported-parent', companyId: 'company' });
  f.state.resources.set('/api/projects/project', { id: 'project', companyId: 'company' });
  const payload = { title: 'Follow-up', description: 'Details', parentId: 'imported-parent', projectId: 'project' };
  const input = { action: 'create', companyId: 'company', key: 'same-key', payload };
  const native = { kind: 'native', bindingId: 'caller', conversationId: 'chat', sessionCreatedAt: 1, sourceDigest: digest('Human request') };
  const first = await humanTask(f.store, f.api, input, { authority: native });
  assert.equal(first.task.assigneeUserId, 'default-human');
  assert.equal(first.task.status, 'todo');
  const operation = f.store.operation(first.operationId);
  assert.deepEqual(operation.request.authority, native);
  assert.equal(operation.request.origin, undefined);
  assert.equal(JSON.stringify(first).includes('sourceDigest'), false);
  f.state.company.defaultResponsibleUserId = 'changed-default';
  const second = await humanTask(f.store, f.api, input, { authority: native });
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.assigneeUserId, 'default-human');
  await createOperatorTask(f.store, f.api, { companyId: 'company', key: 'same-key', payload: { ...payload, assigneeUserId: 'human' } });
  assert.equal(f.state.creations.size, 2);
  assert.equal(f.writes().length, 2);
  await assert.rejects(humanTask(f.store, f.api, input, { authority: { ...native, sourceDigest: digest('Different source') } }), { code: 'operation_conflict' });
});

test('creation persists intent and reuses identical backend idempotency after a lost reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'human-create-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite');
  const f = fixture(t, file);
  const input = { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Create' } };
  f.state.post = () => { throw new Error('Lost create reply'); };
  await assert.rejects(humanTask(f.store, f.api, input), /Lost create reply/);
  const reopened = new Store(file); t.after(() => reopened.close());
  f.state.post = null;
  f.state.company.defaultResponsibleUserId = 'different';
  const result = await humanTask(reopened, f.api, input);
  assert.equal(result.state, 'recorded');
  assert.equal(result.task.assigneeUserId, 'default-human');
  assert.equal(f.state.creations.size, 1);
  assert.deepEqual(f.writes()[0].body, f.writes()[1].body);
  await humanTask(reopened, f.api, input);
  assert.equal(f.writes().length, 2);
});

test('creation checks authority after resource awaits and persists validated unblock data across retries', async t => {
  const f = fixture(t);
  f.state.resources.set('/api/issues/parent', { id: 'parent', companyId: 'company' });
  const input = { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Task', parentId: 'parent', status: 'blocked',
    unblockDescriptor: { owner: 'board', action: 'Review permission' } } };
  let valid = true;
  f.state.hook = (method, path) => { if (path === '/api/issues/parent') valid = false; };
  await assert.rejects(humanTask(f.store, f.api, input, { check: () => assert.ok(valid, 'revoked') }), /revoked/);
  assert.equal(f.writes().length, 0);
  f.state.hook = null;
  f.state.post = () => { throw new Error('Lost response'); };
  await assert.rejects(humanTask(f.store, f.api, input));
  f.state.post = null;
  await humanTask(f.store, f.api, input);
  assert.deepEqual(f.writes()[0].body, f.writes()[1].body);
  assert.equal(f.state.creations.size, 1);
  await assert.rejects(humanTask(f.store, f.api, { ...input, payload: { ...input.payload,
    unblockDescriptor: { owner: 'board', action: 'Different' } } }), { code: 'operation_conflict' });
});

test('stable keys conflict across actions but are isolated by durable authority owner', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'Changed' });
  const authority = { kind: 'native', bindingId: 'one', conversationId: 'chat', sessionCreatedAt: 1, sourceDigest: 'source' };
  const result = await humanTask(f.store, f.api, input, { authority });
  await assert.rejects(humanTask(f.store, f.api, { ...input, action: 'assign', payload: { assigneeUserId: 'other' } }, { authority }), { code: 'operation_conflict' });
  await assert.rejects(humanTask(f.store, f.api, { ...input, expectedRevision: result.revision }, { authority }), { code: 'operation_conflict' });
  const another = await humanTask(f.store, f.api, { ...input, expectedRevision: result.revision }, { authority: { ...authority, bindingId: 'two' } });
  assert.notEqual(result.operationId, another.operationId);
});

test('creation rejects agent ownership, terminal statuses, missing default human and foreign resources', async t => {
  for (const payload of [{ title: 'Task', assigneeAgentId: 'agent' }, { title: 'Task', assigneeUserId: null },
    { title: 'Task', status: 'done' }, { title: 'Task', status: 'in_review' }, { title: 'Task', status: 'cancelled' },
    { title: 'Task', idempotencyKey: 'override' }, { title: 'Task', reviewPolicy: 'none' }]) {
    const f = fixture(t);
    await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create', payload }));
    assert.equal(f.writes().length, 0);
  }
  for (const value of [undefined, null, '', '  ']) {
    const f = fixture(t); f.state.company.defaultResponsibleUserId = value;
    await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Task' } }));
    assert.equal(f.writes().length, 0);
  }
  for (const field of ['parentId', 'projectId']) {
    const f = fixture(t);
    f.state.resources.set(`/api/${field === 'parentId' ? 'issues' : 'projects'}/foreign`, { id: 'foreign', companyId: 'other' });
    await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Task', [field]: 'foreign' } }), { code: 'forbidden' });
    assert.equal(f.writes().length, 0);
  }
});

test('blocked create/edit accepts only bounded board or user unblock descriptors', async t => {
  for (const action of ['create', 'edit']) {
    for (const descriptor of [undefined, null, { owner: 'agent', action: 'act' }, { owner: { agentId: 'agent' }, action: 'act' },
      { owner: { userId: 'human', companyId: 'other' }, action: 'act' }, { owner: 'board', action: '' },
      { owner: 'board', action: 'a'.repeat(2001) }, { owner: 'board', action: 'act', extra: true }]) {
      const f = fixture(t);
      const payload = { title: 'Task', status: 'blocked', ...(descriptor === undefined ? {} : { unblockDescriptor: descriptor }) };
      const input = action === 'create' ? { action, companyId: 'company', key: 'create', payload } : await f.input(action, payload);
      await assert.rejects(humanTask(f.store, f.api, input));
      assert.equal(f.writes().length, 0);
    }
    for (const owner of ['board', { userId: 'human' }]) {
      const f = fixture(t);
      const unblockDescriptor = { owner, action: 'Approve access' };
      const payload = { title: 'Task', status: 'blocked', unblockDescriptor };
      const input = action === 'create' ? { action, companyId: 'company', key: 'create', payload } : await f.input(action, payload);
      assert.equal((await humanTask(f.store, f.api, input)).task.status, 'blocked');
      assert.deepEqual(f.writes()[0].body.unblockDescriptor, unblockDescriptor);
    }
  }
});
