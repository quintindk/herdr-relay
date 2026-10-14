import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { createScheduleTarget } from '../src/schedule-targets.mjs';

function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { companyId: 'company', machineId: 'machine', session: 'default', socketPath: '/relay.sock', bridgeDirectories: ['/work/twd'] };
  const agents = [], calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    if (method === 'GET' && path === '/api/companies/company/agents') return structuredClone(agents);
    if (method === 'POST' && path === '/api/companies/company/agents') {
      const agent = { ...structuredClone(body), id: 'native-agent', companyId: 'company', status: 'idle' };
      agents.push(agent); return structuredClone(agent);
    }
    assert.fail(`${method} ${path}`);
  };
  const input = { key: 'inbox-worker', name: 'TWD inbox worker', directory: '/work/twd',
    model: 'github-copilot/gpt-5.6-sol-fast', instructions: 'Read the assigned inbox sweep task and report the result.' };
  return { store, config, agents, calls, api, input };
}

test('creates one sanitised opencode schedule target with fixed unattended policy', async t => {
  const f = fixture(t);
  const result = await createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' });
  assert.deepEqual(result, { operationId: result.operationId, state: 'recorded', agentId: 'native-agent',
    name: 'TWD inbox worker', adapterType: 'opencode_local', status: 'idle', ready: true });
  const create = f.calls.find(call => call.method === 'POST');
  assert.equal(create.body.adapterType, 'opencode_local');
  assert.deepEqual(create.body.adapterConfig, { cwd: '/work/twd', model: 'github-copilot/gpt-5.6-sol-fast',
    dangerouslySkipPermissions: true, timeoutSec: 0 });
  assert.deepEqual(create.body.runtimeConfig.heartbeat, { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 });
  assert.deepEqual(create.body.permissions, { canCreateAgents: false, canCreateSkills: false });
  assert.equal(create.body.instructionsBundle.files['AGENTS.md'], f.input.instructions);
  assert.equal(typeof create.body.metadata.herdrRelayScheduleTargetMarker, 'string');
  assert.ok(!JSON.stringify(result).includes(create.body.metadata.herdrRelayScheduleTargetMarker));
  assert.ok(!JSON.stringify(result).includes(f.input.model));
});

test('stable retries reuse the recorded target and changed requests conflict', async t => {
  const f = fixture(t);
  const first = await createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' });
  assert.deepEqual(await createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' }), first);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  await assert.rejects(createScheduleTarget(f.store, f.api, f.config, { ...f.input, model: 'openai/gpt-5.2' }, { kind: 'operator' }),
    { code: 'operation_conflict' });
});

test('uncertain absent creation never posts another agent', async t => {
  const f = fixture(t); let sent = false;
  const api = async (method, path, body) => {
    if (method === 'GET') return [];
    if (!sent) { sent = true; throw Object.assign(new Error('lost'), { code: 'backend_unavailable' }); }
    assert.fail('Agent POST must not repeat');
  };
  await assert.rejects(createScheduleTarget(f.store, api, f.config, f.input, { kind: 'operator' }), { code: 'backend_unavailable' });
  await assert.rejects(createScheduleTarget(f.store, api, f.config, f.input, { kind: 'operator' }), { code: 'operation_uncertain' });
});

test('rejects credentials, raw configuration, unapproved directories and malformed models before creation', async t => {
  for (const change of [
    { env: { TOKEN: 'secret' } }, { adapterConfig: {} }, { token: 'secret' }, { directory: '/tmp' }, { model: 'invalid' },
  ]) {
    const f = fixture(t);
    await assert.rejects(createScheduleTarget(f.store, f.api, f.config, { ...f.input, ...change }, { kind: 'operator' }));
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  }
});
