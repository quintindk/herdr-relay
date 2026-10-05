import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { prepareObservedPull, releaseObservedPull } from '../src/observed-delivery.mjs';

test('observed pull requires reservation, scopes one task/run, preserves replay and safely releases', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-observed-pull-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'admin-token'), 'private-test-token');
  store.saveOperation({ id: 'herdr-agent:test', runId: '', state: 'recorded', marker: 'marker', agentId: 'agent',
    identity: { companyId: 'company', harness: 'opencode', machineId: 'machine', session: 'default', conversationId: 'native' },
    availability: 'present', observation: { state: 'idle', display: { name: 'worker' } } });
  const backend = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', status: 'paused',
    adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' }, runtimeConfig: {} };
  let previousDone = false;
  const api = async (method, path, body) => {
    if (path.startsWith('/api/issues/')) return { companyId: 'company', status: previousDone && path.endsWith('/task') ? 'done' : 'todo' };
    if (method === 'PATCH') Object.assign(backend, body);
    return structuredClone(backend);
  };
  const input = { observedId: 'herdr-agent:test', taskId: 'task', reserved: true };
  await assert.rejects(prepareObservedPull(store, root, api, { ...input, reserved: false }), { code: 'reservation_required' });
  const prepared = await prepareObservedPull(store, root, api, input);
  assert.equal(backend.adapterConfig.observationOnly, false);
  assert.equal(store.binding(prepared.bindingId).config.delivery, 'pull');
  assert.deepEqual(await prepareObservedPull(store, root, api, input), prepared);
  const dispatch = { bindingId: prepared.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', runId: 'backend-run', taskId: 'task' };
  assert.throws(() => store.dispatch({ ...dispatch, taskId: 'other' }), { code: 'observed_reservation_closed' });
  const run = store.dispatch(dispatch);
  assert.equal(store.dispatch(dispatch).id, run.id);
  await assert.rejects(releaseObservedPull(store, api, prepared), { code: 'work_unsettled' });
  store.cancel(run.id);
  assert.throws(() => store.dispatch({ ...dispatch, runId: 'another-run' }), { code: 'observed_reservation_closed' });
  await releaseObservedPull(store, api, prepared);
  assert.equal(backend.status, 'paused');
  assert.equal(backend.adapterConfig.observationOnly, true);
  assert.equal(backend.runtimeConfig.heartbeat.wakeOnDemand, false);
  await releaseObservedPull(store, api, prepared);
  assert.throws(() => store.dispatch({ ...dispatch, runId: 'new-run' }), { code: 'observed_reservation_closed' });
  const next = { ...input, taskId: 'task-2', previousTaskId: 'task' };
  await assert.rejects(prepareObservedPull(store, root, api, { ...next, previousTaskId: 'wrong' }), { code: 'reservation_conflict' });
  await assert.rejects(prepareObservedPull(store, root, api, next), { code: 'reservation_conflict' });
  previousDone = true;
  const preparedNext = await prepareObservedPull(store, root, api, next);
  assert.equal(preparedNext.bindingId, prepared.bindingId);
  assert.equal(store.operation(`observed-pull:${prepared.bindingId}`).history[0].request.taskId, 'task');
  await assert.rejects(releaseObservedPull(store, api, prepared), { code: 'reservation_conflict' });
  assert.throws(() => store.dispatch({ ...dispatch, runId: 'old-task-retry' }), { code: 'observed_reservation_closed' });
  assert.equal(store.dispatch({ ...dispatch, taskId: 'task-2', runId: 'next' }).request.taskId, 'task-2');
});
