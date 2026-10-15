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
  const provisions = [];
  const provision = async (value, stateDirectory, backend, request) => {
    provisions.push({ stateDirectory, request: structuredClone(request) });
    const agentId = 'managed-agent';
    const binding = value.register({ id: request.bindingId, companyId: request.companyId, agentId,
      harness: 'opencode', instanceId: 'runtime', conversationId: 'conversation', delivery: 'opencode',
      lifetime: request.lifetime, label: request.label, instructions: request.instructions,
      opencode: { url: 'http://127.0.0.1:4321', directory: request.directory, projectID: 'project',
        sessionCreatedAt: 1, exclusive: true, runtimeKey: 'runtime', model: request.model } }).binding;
    return value.saveOperation({ id: `provision:${request.key}`, runId: '', state: 'recorded', marker: 'marker',
      request, bindingId: binding.id, agentId, conversationId: binding.config.conversationId, runtimeKey: 'runtime' });
  };
  return { store, config, agents, calls, api, input, provisions, provision, options: { stateDirectory: '/state', provision } };
}

test('creates one managed Relay schedule target with scoped worker instructions', async t => {
  const f = fixture(t);
  const result = await createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' }, undefined, f.options);
  assert.deepEqual(result, { operationId: result.operationId, state: 'recorded', targetBindingId: result.targetBindingId,
    agentId: 'managed-agent', name: 'TWD inbox worker', targetType: 'relay_managed', ready: true });
  assert.match(result.targetBindingId, /^schedule-/);
  assert.equal(f.provisions.length, 1);
  assert.deepEqual(f.provisions[0].request.model, { providerID: 'github-copilot', modelID: 'gpt-5.6-sol-fast' });
  assert.equal(f.provisions[0].request.lifetime, 'service');
  assert.equal(f.provisions[0].request.instructions, f.input.instructions);
  assert.equal(f.store.binding(result.targetBindingId).config.instructions, f.input.instructions);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes(f.input.model));
  assert.ok(!JSON.stringify(result).includes(f.input.instructions));
});

test('stable retries reuse the recorded target and changed requests conflict', async t => {
  const f = fixture(t);
  const first = await createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' }, undefined, f.options);
  assert.deepEqual(await createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' }, undefined, f.options), first);
  assert.equal(f.provisions.length, 1);
  await assert.rejects(createScheduleTarget(f.store, f.api, f.config, { ...f.input, model: 'openai/gpt-5.2' }, { kind: 'operator' }, undefined, f.options),
    { code: 'operation_conflict' });
});

test('failed managed provisioning retains one stable target identity for retry', async t => {
  const f = fixture(t); const requests = [];
  const provision = async (...args) => { requests.push(args[3]); throw Object.assign(new Error('lost'), { code: 'backend_unavailable' }); };
  const options = { stateDirectory: '/state', provision };
  await assert.rejects(createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' }, undefined, options), { code: 'backend_unavailable' });
  await assert.rejects(createScheduleTarget(f.store, f.api, f.config, f.input, { kind: 'operator' }, undefined, options), { code: 'backend_unavailable' });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].bindingId, requests[1].bindingId);
  assert.equal(requests[0].key, requests[1].key);
});

test('rejects credentials, raw configuration, unapproved directories and malformed models before creation', async t => {
  for (const change of [
    { env: { TOKEN: 'secret' } }, { adapterConfig: {} }, { token: 'secret' }, { directory: '/tmp' }, { model: 'invalid' },
  ]) {
    const f = fixture(t);
    await assert.rejects(createScheduleTarget(f.store, f.api, f.config, { ...f.input, ...change }, { kind: 'operator' }, undefined, f.options));
    assert.equal(f.provisions.length, 0);
  }
});
