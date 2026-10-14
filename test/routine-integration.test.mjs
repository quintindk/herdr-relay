import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { routineTargetAdmission } from '../src/routines.mjs';
import { admitRoutineExecution, assertRoutineTask } from '../src/routine-execution.mjs';
import { harnessRoutine } from '../src/harness-routines.mjs';
import { taskOrigins } from '../src/task-origin.mjs';
import { taskPolicy } from '../src/task-policy.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const bindings = {};
  for (const id of ['origin', 'worker']) {
    bindings[id] = store.register({ id, companyId: 'company', agentId: id, harness: 'opencode',
      delivery: 'pull', instanceId: digest(['machine', 'default']), conversationId: id }).binding;
    store.saveOperation({ id: `herdr-agent:${id}`, runId: '', agentId: id, marker: id, availability: 'present',
      identity: { companyId: 'company', machineId: 'machine', session: 'default', harness: 'opencode', sessionKind: 'id', conversationId: id },
      placement: { directory: `/${id}`, terminalId: id } });
    store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true,
      epoch: id, sessionCreatedAt: 123, tokenHash: id, lastSeen: new Date().toISOString(),
      identity: { bindingId: id, observedId: `herdr-agent:${id}`, conversationId: id, directory: `/${id}`, terminalId: id } });
  }
  const target = routineTargetAdmission(store, bindings.worker).target;
  const body = { title: 'Routine test', description: 'Read only', projectId: null, parentIssueId: null, assigneeAgentId: 'worker' };
  const schedule = store.saveOperation({ id: 'routine:test', runId: '', created: true, state: 'active',
    routineId: 'native', triggerId: 'trigger', body, target,
    authority: { kind: 'native', bindingId: 'origin', conversationId: 'origin', sessionCreatedAt: 123 },
    request: { companyId: 'company', executionMode: 'interactive_exact', targetBindingId: 'worker', relayReviewPolicy: 'none', cron: '0 8 * * *', timezone: 'Africa/Johannesburg' } });
  const task = { id: 'task', companyId: 'company', identifier: 'TEST-1', ...body, parentId: null,
    originKind: 'routine_execution', originId: 'native', originRunId: 'occurrence' };
  const routine = { id: 'native', companyId: 'company', ...body,
    triggers: [{ id: 'trigger', routineId: 'native', kind: 'schedule', cronExpression: '0 8 * * *', timezone: 'Africa/Johannesburg' }] };
  const occurrence = { id: 'occurrence', companyId: 'company', routineId: 'native', source: 'schedule', triggerId: 'trigger', linkedIssueId: 'task' };
  const api = async (method, path) => {
    assert.equal(method, 'GET');
    if (path === '/api/issues/task') return structuredClone(task);
    if (path === '/api/routines/native') return structuredClone(routine);
    if (path === '/api/routines/native/runs?limit=200') return [structuredClone(occurrence)];
    assert.fail(path);
  };
  const input = { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'worker', taskId: 'task', runId: 'backend' };
  return { store, schedule, task, routine, occurrence, api, input };
}

function managedFixture(t) {
  const f = fixture(t), runtimeKey = 'managed-runtime';
  const runtime = { request: { directory: '/managed' }, directory: '/runtime/managed', port: 4321, nonce: 'managed-nonce' };
  f.store.saveOperation({ id: `runtime:${runtimeKey}`, runId: '', ...runtime, state: 'ready' });
  const binding = f.store.register({ id: 'headless', companyId: 'company', agentId: 'headless', harness: 'opencode',
    delivery: 'opencode', instanceId: runtime.nonce, conversationId: 'headless-chat', lifetime: 'persistent', opencode: {
      url: `http://127.0.0.1:${runtime.port}`, directory: runtime.request.directory, projectID: 'project', sessionCreatedAt: 456,
      exclusive: true, runtimeKey, authFile: `${runtime.directory}/auth.json`,
    } }).binding;
  f.store.saveOperation({ id: 'provision:headless', runId: '', state: 'recorded', marker: 'provision-marker',
    request: { companyId: 'company', bindingId: 'headless', harness: 'opencode', directory: '/managed', lifetime: 'persistent' },
    bindingId: 'headless', agentId: 'headless', conversationId: 'headless-chat', runtimeKey });
  f.task.assigneeAgentId = 'headless';
  f.routine.assigneeAgentId = 'headless';
  f.schedule.body.assigneeAgentId = 'headless';
  f.schedule.request.targetBindingId = 'headless';
  f.schedule.request.executionMode = 'headless';
  f.schedule.target = routineTargetAdmission(f.store, binding, undefined, { verifyRuntime: () => runtime }).target;
  f.store.saveOperation(f.schedule);
  Object.assign(f.input, { bindingId: 'headless', agentId: 'headless' });
  return { ...f, binding, runtime, options: { verifyRuntime: () => runtime, nativeSnapshot: async () => ({ idle: true }) } };
}

test('verified routine occurrence retains policy and exact origin without another task create', async t => {
  const f = fixture(t);
  await admitRoutineExecution(f.store, f.api, f.input);
  assert.equal(taskPolicy(f.store, 'company', 'task'), 'none');
  assert.equal(taskOrigins(f.store)[0].request.origin.conversationId, 'origin');
  assertRoutineTask(f.store, 'worker', 'task');
  const run = f.store.dispatch(f.input);
  f.store.saveOperation({ ...f.schedule, state: 'cancelled', cancellationRequested: true });
  await admitRoutineExecution(f.store, () => assert.fail('Replay must not read backend'), f.input);
  assert.equal(f.store.dispatch(f.input).id, run.id);
  assert.throws(() => assertRoutineTask(f.store, 'worker', 'task'), { code: 'routine_execution_mismatch' });
});

test('manual receipt bookkeeping cannot invalidate occurrence admission', async t => {
  const f = fixture(t);
  f.occurrence.source = 'manual';
  f.occurrence.triggerId = null;
  f.occurrence.idempotencyKey = 'manual-key';
  f.store.saveOperation({ id: 'routine-mutation:manual', runId: '', state: 'uncertain',
    request: { scheduleId: f.schedule.id, action: 'run' }, body: { idempotencyKey: 'manual-key' } });
  await admitRoutineExecution(f.store, async (...args) => {
    const value = await f.api(...args);
    if (args[1].endsWith('/runs?limit=200')) {
      f.store.saveOperation({ ...f.store.operation(f.schedule.id), updatedAt: 'different' });
      f.store.saveOperation({ ...f.store.operation('routine-mutation:manual'), state: 'recorded', receipt: { id: 'occurrence' } });
    }
    return value;
  }, f.input);
  assert.equal(taskPolicy(f.store, 'company', 'task'), 'none');
  assert.equal(f.store.runs().length, 0);
});

for (const loss of ['binding', 'bridge']) test(`${loss} exact conversation archives its routine and cancels the unadmitted occurrence`, async t => {
  const f = fixture(t);
  if (loss === 'binding') f.store.db.prepare('DELETE FROM bindings WHERE id = ?').run('worker');
  if (loss === 'bridge') f.store.db.prepare('DELETE FROM operations WHERE id = ?').run('opencode-bridge:worker');
  f.routine.status = 'active'; f.routine.latestRevisionId = 'revision'; f.task.status = 'todo';
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/api/issues/task') return structuredClone(f.task);
    if (method === 'GET' && path === '/api/routines/native') return structuredClone(f.routine);
    if (method === 'GET' && path === '/api/routines/native/runs?limit=200') return [structuredClone(f.occurrence)];
    if (method === 'PATCH' && path === '/api/routines/native') {
      Object.assign(f.routine, { status: body.status, latestRevisionId: 'archived-revision' }); return structuredClone(f.routine);
    }
    if (method === 'PATCH' && path === '/api/issues/task') {
      Object.assign(f.task, body); return structuredClone(f.task);
    }
    assert.fail(`${method} ${path}`);
  };
  await assert.rejects(admitRoutineExecution(f.store, api, f.input), { code: 'routine_retired' });
  assert.equal(f.routine.status, 'archived'); assert.equal(f.task.status, 'cancelled');
  assert.equal(f.store.operation(f.schedule.id).state, 'cancelled');
  assert.equal(f.store.runs().length, 0);
  assert.deepEqual(calls.filter(call => call.method === 'PATCH').map(call => call.path), ['/api/routines/native', '/api/issues/task']);
});

test('busy or temporarily unavailable exact conversation waits without retiring', async t => {
  for (const mode of ['busy', 'stale', 'unknown', 'offline']) {
    const f = fixture(t);
    if (mode === 'busy') f.store.dispatch({ ...f.input, taskId: 'other', runId: 'other-run' });
    else if (mode === 'stale') f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'), lastSeen: '2020-01-01T00:00:00.000Z' });
    else f.store.saveOperation({ ...f.store.operation('herdr-agent:worker'), availability: mode });
    await assert.rejects(admitRoutineExecution(f.store, f.api, f.input), { code: 'routine_target_busy' });
    assert.equal(f.store.operation(f.schedule.id).cancellationRequested, undefined, mode);
  }
});

test('sustained offline exact conversation retires after the grace window', async t => {
  const f = fixture(t);
  f.store.saveOperation({ ...f.store.operation('herdr-agent:worker'), availability: 'offline' });
  await assert.rejects(admitRoutineExecution(f.store, f.api, f.input), { code: 'routine_target_busy' });
  const evidence = f.store.operation(`routine-exact-offline:${f.schedule.id}`);
  f.store.saveOperation({ ...evidence, firstSeenAt: new Date(Date.now() - 31000).toISOString() });
  f.routine.status = 'active'; f.routine.latestRevisionId = 'revision'; f.task.status = 'todo';
  const api = async (method, path, body) => {
    if (method === 'GET' && path === '/api/issues/task') return structuredClone(f.task);
    if (method === 'GET' && path === '/api/routines/native') return structuredClone(f.routine);
    if (method === 'GET' && path === '/api/routines/native/runs?limit=200') return [structuredClone(f.occurrence)];
    if (method === 'PATCH' && path === '/api/routines/native') {
      Object.assign(f.routine, { status: body.status, latestRevisionId: 'archived' }); return structuredClone(f.routine);
    }
    if (method === 'PATCH' && path === '/api/issues/task') { Object.assign(f.task, body); return structuredClone(f.task); }
    assert.fail(`${method} ${path}`);
  };
  await assert.rejects(admitRoutineExecution(f.store, api, f.input), { code: 'routine_retired' });
  assert.equal(f.task.status, 'cancelled');
  assert.equal(f.store.operation(f.schedule.id).state, 'cancelled');
});

test('exact retirement preserves a concurrently completed occurrence', async t => {
  const f = fixture(t); f.store.db.prepare('DELETE FROM bindings WHERE id = ?').run('worker');
  f.routine.status = 'active'; f.routine.latestRevisionId = 'revision'; f.task.status = 'done';
  const api = async (method, path, body) => {
    if (method === 'GET' && path === '/api/issues/task') return structuredClone(f.task);
    if (method === 'GET' && path === '/api/routines/native') return structuredClone(f.routine);
    if (method === 'GET' && path === '/api/routines/native/runs?limit=200') return [structuredClone(f.occurrence)];
    if (method === 'PATCH' && path === '/api/routines/native') {
      Object.assign(f.routine, { status: body.status, latestRevisionId: 'archived' }); return structuredClone(f.routine);
    }
    if (method === 'PATCH' && path === '/api/issues/task') assert.fail('Done occurrence must not be cancelled');
    assert.fail(`${method} ${path}`);
  };
  await assert.rejects(admitRoutineExecution(f.store, api, f.input), { code: 'routine_retired' });
  assert.equal(f.task.status, 'done');
  assert.equal(f.store.operation(f.schedule.id).state, 'cancelled');
});

test('uncommitted lost archive response retries only against the unchanged routine revision', async t => {
  const f = fixture(t); f.store.db.prepare('DELETE FROM bindings WHERE id = ?').run('worker');
  f.routine.status = 'active'; f.routine.latestRevisionId = 'revision'; f.task.status = 'todo';
  let archives = 0;
  const api = async (method, path, body) => {
    if (method === 'GET' && path === '/api/issues/task') return structuredClone(f.task);
    if (method === 'GET' && path === '/api/routines/native') return structuredClone(f.routine);
    if (method === 'GET' && path === '/api/routines/native/runs?limit=200') return [structuredClone(f.occurrence)];
    if (method === 'PATCH' && path === '/api/routines/native') {
      archives++;
      if (archives === 1) throw Object.assign(new Error('lost before commit'), { code: 'backend_unavailable' });
      assert.equal(body.baseRevisionId, 'revision');
      Object.assign(f.routine, { status: 'archived', latestRevisionId: 'archived' }); return structuredClone(f.routine);
    }
    if (method === 'PATCH' && path === '/api/issues/task') { Object.assign(f.task, body); return structuredClone(f.task); }
    assert.fail(`${method} ${path}`);
  };
  await assert.rejects(admitRoutineExecution(f.store, api, f.input), { code: 'backend_unavailable' });
  assert.equal(f.store.operation(f.schedule.id).cancellationRequested, true);
  const operation = f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine-retirement:%'").get();
  assert.ok(operation);
  const { reconcileRoutineRetirements } = await import('../src/routine-retirement.mjs');
  await reconcileRoutineRetirements(f.store, api);
  assert.equal(archives, 2);
  assert.equal(f.routine.status, 'archived');
  assert.equal(f.task.status, 'cancelled');
});

test('uncommitted lost occurrence cancellation retries only while the task snapshot is unchanged', async t => {
  const f = fixture(t); f.store.db.prepare('DELETE FROM bindings WHERE id = ?').run('worker');
  f.routine.status = 'active'; f.routine.latestRevisionId = 'revision';
  Object.assign(f.task, { status: 'todo', updatedAt: '2026-10-14T08:00:00.000Z' });
  let cancellations = 0;
  const api = async (method, path, body) => {
    if (method === 'GET' && path === '/api/issues/task') return structuredClone(f.task);
    if (method === 'GET' && path === '/api/routines/native') return structuredClone(f.routine);
    if (method === 'GET' && path === '/api/routines/native/runs?limit=200') return [structuredClone(f.occurrence)];
    if (method === 'PATCH' && path === '/api/routines/native') {
      Object.assign(f.routine, { status: body.status, latestRevisionId: 'archived' }); return structuredClone(f.routine);
    }
    if (method === 'PATCH' && path === '/api/issues/task') {
      cancellations++;
      if (cancellations === 1) throw Object.assign(new Error('lost before commit'), { code: 'backend_unavailable' });
      Object.assign(f.task, body, { updatedAt: '2026-10-14T08:01:00.000Z' }); return structuredClone(f.task);
    }
    assert.fail(`${method} ${path}`);
  };
  await assert.rejects(admitRoutineExecution(f.store, api, f.input), { code: 'backend_unavailable' });
  const { reconcileRoutineRetirements } = await import('../src/routine-retirement.mjs');
  await reconcileRoutineRetirements(f.store, api);
  assert.equal(cancellations, 2);
  assert.equal(f.task.status, 'cancelled');
});

test('managed exact routine occurrence is admitted, delivered and settled with the originating chat retained', async t => {
  const f = managedFixture(t);
  await admitRoutineExecution(f.store, f.api, f.input, f.options);
  const task = taskOrigins(f.store)[0];
  assert.equal(task.request.origin.conversationId, 'origin');
  assert.equal(task.target.managed.provisionId, 'provision:headless');
  const run = f.store.dispatch(f.input);
  f.store.acknowledge(run.id);
  f.store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Inbox sweep: one action.' });
  f.store.publication(run.id, { state: 'recorded', commentId: 'comment' });
  const settled = f.store.settle(run.id, { outcome: 'completed', evidence: 'Finished' });
  assert.equal(settled.conversationId, 'headless-chat');
  assertRoutineTask(f.store, 'headless', 'task', { verifyRuntime: f.options.verifyRuntime });
});

for (const change of ['busy', 'cancelled', 'session', 'trigger', 'foreign-run', 'unowned-manual']) {
  test(`routine admission refuses ${change} without native execution`, async t => {
    const f = fixture(t);
    if (change === 'busy') f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'), ready: false });
    if (change === 'cancelled') f.store.saveOperation({ ...f.schedule, cancellationRequested: true });
    if (change === 'session') f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'), sessionCreatedAt: 456 });
    if (change === 'trigger') f.routine.triggers[0].cronExpression = '* * * * *';
    if (change === 'foreign-run') f.occurrence.linkedIssueId = 'foreign';
    if (change === 'unowned-manual') { f.occurrence.source = 'manual'; f.occurrence.triggerId = null; }
    await assert.rejects(admitRoutineExecution(f.store, f.api, f.input), change === 'busy' ? { code: 'routine_target_busy' } : undefined);
    assert.equal(f.store.runs().length, 0);
    assert.equal(taskOrigins(f.store).length, 0);
  });
}

test('busy configured origin can preview and list but cannot omit human source or spoof scope', async t => {
  const f = fixture(t);
  const bridge = f.store.saveOperation({ ...f.store.operation('opencode-bridge:origin'), state: 'configured', ready: false });
  const api = () => assert.fail('Read preview/list must not send backend requests');
  assert.equal((await harnessRoutine(f.store, bridge, 'routine-preview', { cron: '0 8 * * 1-5' }, api)).nextRuns.length, 3);
  assert.equal((await harnessRoutine(f.store, bridge, 'routine-list', {}, api)).routines.length, 1);
  await assert.rejects(harnessRoutine(f.store, bridge, 'routine-create', { targetBindingId: 'worker' }, api), { code: 'invalid_routine_source' });
  await assert.rejects(harnessRoutine(f.store, bridge, 'routine-list', { companyId: 'other' }, api), { code: 'invalid_request' });
});
