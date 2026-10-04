import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { createSchedule, tickSchedules } from '../src/schedules.mjs';

test('bounded schedules preserve retry slot, avoid overlapping work and stop at the window boundary', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'monitor', companyId: 'company', agentId: 'monitor', harness: 'opencode', instanceId: 'instance', conversationId: 'monitor', lifetime: 'service' });
  const clock = Date.parse('2026-10-04T08:00:00Z');
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
