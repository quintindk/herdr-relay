import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { createSchedule, tickSchedules } from '../src/schedules.mjs';

test('bounded schedules preserve retry slot, avoid overlapping work and stop at the window boundary', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'monitor', companyId: 'company', agentId: 'monitor', harness: 'opencode', instanceId: 'instance', conversationId: 'monitor', lifetime: 'service' });
  const clock = Date.now();
  createSchedule(store, { key: 'morning', bindingId: 'monitor', taskId: 'brief', startsAt: new Date(clock).toISOString(),
    endsAt: new Date(clock + 60000).toISOString(), intervalSec: 10 });
  const keys = [];
  const api = async (method, path, body) => {
    if (method === 'GET') return { id: 'brief', companyId: 'company', assigneeAgentId: 'monitor' };
    keys.push(body.idempotencyKey);
    if (keys.length === 1) throw new Error('Lost receipt');
    return { id: 'backend' };
  };
  await tickSchedules(store, api, clock);
  await tickSchedules(store, api, clock + 1000);
  assert.equal(keys[0], keys[1]);
  const run = store.dispatch({ bindingId: 'monitor', bindingRevision: 1, companyId: 'company', agentId: 'monitor', taskId: 'brief', runId: 'backend' });
  await tickSchedules(store, api, clock + 20000);
  assert.equal(keys.length, 2);
  await tickSchedules(store, api, clock + 60000);
  assert.equal(store.operation('schedule:morning').state, 'ended');
  assert.equal(store.run(run.id).cancellationRequested, true);
  assert.equal(keys.length, 2);
});

test('queued schedule dispatch is refused after stop or expiry without creating native work', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'monitor', companyId: 'company', agentId: 'monitor', harness: 'opencode', instanceId: 'instance', conversationId: 'monitor', lifetime: 'service' });
  const clock = Date.now();
  const schedule = createSchedule(store, { key: 'window', bindingId: 'monitor', taskId: 'brief',
    startsAt: new Date(clock - 1000).toISOString(), endsAt: new Date(clock + 60000).toISOString(), intervalSec: 10 });
  const request = { bindingId: 'monitor', bindingRevision: 1, companyId: 'company', agentId: 'monitor', taskId: 'brief',
    runId: 'queued', scheduleId: schedule.id };
  store.saveOperation({ ...schedule, state: 'stopped' });
  assert.throws(() => store.dispatch(request), { code: 'schedule_inactive' });
  const { scheduleId, ...filteredRequest } = request;
  assert.throws(() => store.dispatch(filteredRequest), { code: 'schedule_inactive' });
  store.saveOperation({ ...schedule, request: { ...schedule.request, endsAt: new Date(clock - 1).toISOString() } });
  assert.throws(() => store.dispatch(request), { code: 'schedule_inactive' });
  assert.equal(store.runs().length, 0);
  store.saveOperation(schedule);
  const run = store.dispatch(request);
  store.saveOperation({ ...schedule, state: 'stopped' });
  assert.equal(store.dispatch(request).id, run.id, 'Existing work remains recoverable after the window closes');
});
