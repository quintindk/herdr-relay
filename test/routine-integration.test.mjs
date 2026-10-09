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
    request: { companyId: 'company', targetBindingId: 'worker', relayReviewPolicy: 'none', cron: '0 8 * * *', timezone: 'Africa/Johannesburg' } });
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
