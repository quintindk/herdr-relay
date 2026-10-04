import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { recoverBackend } from '../src/backend-recovery.mjs';

test('operator recovery resumes its original transaction after replacement identity changes', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const request = { bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'old' };
  const run = store.dispatch(request);
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'one', summary: 'Done', candidate: 'fixture' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Native completion verified' });
  let agent = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { bindingId: 'worker' },
    runtimeConfig: { heartbeat: { enabled: false } } };
  let invokes = 0;
  const api = async (method, path, body) => {
    if (path === '/api/heartbeat-runs/old') return { id: 'old', companyId: 'company', agentId: 'agent', status: 'failed' };
    if (path === '/api/heartbeat-runs/new') return { id: 'new', companyId: 'company', agentId: 'agent', status: 'running' };
    if (path.endsWith('/recovery-actions')) return { active: null };
    if (path.endsWith('/heartbeat/invoke')) { invokes++; return { id: 'new' }; }
    if (method === 'PATCH') agent = { ...agent, ...body };
    return agent;
  };
  assert.equal((await recoverBackend(store, api, { runId: run.id })).state, 'replacement_started');
  store.recover(run.id, { ...request, runId: 'new' });
  assert.equal((await recoverBackend(store, api, { runId: run.id })).state, 'recorded');
  assert.equal((await recoverBackend(store, api, { runId: run.id })).state, 'recorded');
  assert.equal(invokes, 1);
  assert.deepEqual(agent.adapterConfig, { bindingId: 'worker' });
  assert.equal(agent.runtimeConfig.heartbeat.enabled, false);
});
