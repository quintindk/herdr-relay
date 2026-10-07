import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

for (const configuration of ['absent', 'empty workerRepositories']) {
  test(`service restart fences persisted worker grants with ${configuration} configuration`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-worker-restart-'));
    const requests = [];
    const agent = { id: 'agent', companyId: 'company', status: 'idle', adapterType: 'herdr_relay',
      adapterConfig: { relayObservationMarker: 'marker', observationOnly: false },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } };
    const backend = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/agents/agent' && ['GET', 'PATCH'].includes(req.method)) {
        if (req.method === 'PATCH') Object.assign(agent, body);
        res.end(JSON.stringify(agent));
      } else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
    });
    let service;
    t.after(async () => {
      await service?.close(); await new Promise(resolve => backend.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
    const paperclipUrl = `http://127.0.0.1:${backend.address().port}`;
    service = await startService({ directory, paperclipUrl });
    const binding = service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent',
      harness: 'opencode', instanceId: 'instance', conversationId: 'conversation' }).binding;
    const scope = { companyId: 'company', machineId: 'machine', session: 'session', socketPath: join(directory, 'absent-herdr.sock') };
    service.store.saveOperation({ id: 'herdr-agent:worker', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
      identity: { ...scope, harness: 'opencode', conversationId: 'conversation' },
      placement: { directory: '/work/worker', terminalId: 'terminal' } });
    const identity = { bindingId: binding.id, observedId: 'herdr-agent:worker', conversationId: 'conversation',
      terminalId: 'terminal', directory: '/work/worker' };
    const bridge = service.store.saveOperation({ id: `opencode-bridge:${binding.id}`, runId: '', state: 'armed',
      identity, tokenHash: digest('bridge-token'), epoch: 'epoch', sessionCreatedAt: 123, ready: true,
      lastSeen: new Date().toISOString(), backendPaused: false });
    const grant = service.store.saveOperation({ id: 'herdr-worker:persisted', runId: '', state: 'armed',
      scope, allowed: { allowed: { repository: '/work', worktreeRoot: '/work/workers' } },
      request: { key: 'prepare', mode: 'adopt', repository: '/work', directory: identity.directory },
      bindingId: binding.id, target: identity });
    service.store.assertWorkerAdmission(binding.id);
    await service.close();
    const options = {};
    if (configuration !== 'absent') {
      options.herdrConfigFile = join(directory, 'herdr.json');
      options.backendContextFile = join(directory, 'backend.json');
      writeFileSync(options.herdrConfigFile, JSON.stringify({ ...scope, workerRepositories: [] }));
      writeFileSync(options.backendContextFile, JSON.stringify({ localTrusted: true }));
    }
    service = await startService({ directory, paperclipUrl, ...options });
    assert.deepEqual(service.store.operation(grant.id), { ...grant, state: 'blocked', blocker: 'grant_revoked',
      disarmed: false, updatedAt: service.store.operation(grant.id).updatedAt });
    assert.deepEqual(service.store.operation(bridge.id), bridge, 'Startup must fence admission before asynchronous backend disarm');
    await assert.rejects(call(service, 'POST', '/runs', { bindingId: binding.id, bindingRevision: binding.revision,
      companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'new-backend-run' }),
    { code: 'worker_grant_inactive', status: 409 });
    assert.deepEqual(service.store.runs(), [], 'Revoked grants must not launch new work');
    assert.deepEqual(service.store.bindings(), [binding], 'Restart must not enrol a replacement worker');
    assert.deepEqual(requests, [], 'Startup and refused dispatch must not access the backend');
    if (configuration !== 'absent') {
      const deadline = Date.now() + 8000;
      while (!service.store.operation(grant.id).disarmed && Date.now() < deadline) await delay(25);
      assert.equal(service.store.operation(grant.id).disarmed, true, 'An empty allowlist must still schedule revocation');
      assert.equal(service.store.operation(grant.id).blocker, 'grant_revoked');
      assert.equal(service.store.operation(bridge.id).state, 'configured');
      assert.equal(service.store.operation(bridge.id).backendPaused, true);
      assert.equal(agent.status, 'paused');
      assert.equal(agent.adapterConfig.observationOnly, true);
      assert.equal(agent.runtimeConfig.heartbeat.enabled, false);
      assert.equal(agent.runtimeConfig.heartbeat.wakeOnDemand, false);
      assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
        { method: 'GET', path: '/api/agents/agent' }, { method: 'PATCH', path: '/api/agents/agent' },
      ]);
    }
  });
}

test('worker routes require bridge credentials and refuse absent operator repository scope', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-worker-auth-'));
  const service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const worker = service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'instance', conversationId: 'conversation' });
  service.store.saveOperation({ id: 'opencode-bridge:origin', runId: '', state: 'configured',
    tokenHash: digest('bridge-token'), identity: { observedId: 'herdr-agent:origin' } });
  const before = service.store.db.prepare('SELECT * FROM operations ORDER BY id').all();
  const fields = { epoch: 'epoch', conversationId: 'conversation', terminalId: 'terminal', sessionCreatedAt: 123,
    idle: true, key: 'prepare', mode: 'create', repository: '/work', branch: 'worker', base: 'HEAD',
    source: { id: 'human', text: 'Prepare a worker', createdAt: Date.now() } };
  for (const path of ['/bridge/workers', '/bridge/prepare-worker']) {
    await t.test(path, async t => {
      await t.test('unknown credential is unauthorised', async () => {
        await assert.rejects(call({ socketPath: service.socketPath, token: 'unknown' }, 'POST', path, fields),
          { code: 'unauthorised', status: 401 });
      });
      await t.test('worker credential is forbidden', async () => {
        await assert.rejects(call({ socketPath: service.socketPath, token: worker.token }, 'POST', path, fields),
          { code: 'forbidden', status: 403 });
      });
      await t.test('bridge reaches the route but cannot grant itself repository scope', async () => {
        const bridge = { socketPath: service.socketPath, token: 'bridge-token' };
        await assert.rejects(call(bridge, 'POST', path, fields), { code: 'worker_repository_forbidden', status: 409 });
        await assert.rejects(call(bridge, 'GET', path), { code: 'forbidden', status: 403 });
      });
    });
  }
  assert.deepEqual(service.store.db.prepare('SELECT * FROM operations ORDER BY id').all(), before,
    'Refused routes must not prepare workers or alter bridge state');
  assert.deepEqual(service.store.runs(), []);
});

test('worker-scoped wait-children uses the real backend client, preserves blockers and records one canonical set', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-worker-wait-'));
  const requests = [];
  const parent = { id: 'parent', companyId: 'company', assigneeAgentId: 'agent', executionRunId: 'backend-run',
    status: 'in_progress', blockedBy: [{ issueId: 'existing' }] };
  const children = ['a', 'b'].map(id => ({ id, companyId: 'company', parentId: 'parent', assigneeAgentId: 'peer', status: 'todo' }));
  let service, run;
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body, token: req.headers.authorization, runId: req.headers['x-paperclip-run-id'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/issues/parent') res.end(JSON.stringify(parent));
    else if (req.method === 'GET' && children.some(child => req.url === `/api/issues/${child.id}`)) {
      res.end(JSON.stringify(children.find(child => req.url === `/api/issues/${child.id}`)));
    } else if (req.method === 'PATCH' && req.url === '/api/issues/parent') {
      assert.equal(service.store.operation(`dependency:${run.id}`).state, 'uncertain', 'Intent must precede the backend write');
      parent.status = body.status;
      parent.blockedBy = body.blockedByIssueIds.map(id => ({ id }));
      res.end(JSON.stringify(parent));
    } else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
  });
  t.after(async () => {
    await service?.close(); await new Promise(resolve => backend.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}` });
  const store = service.store;
  const worker = store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'conversation' });
  const other = store.register({ id: 'other', companyId: 'company', agentId: 'other', harness: 'opencode', instanceId: 'instance', conversationId: 'other-conversation' });
  store.saveOperation({ id: 'opencode-bridge:origin', runId: '', state: 'configured',
    tokenHash: digest('bridge-token'), identity: { observedId: 'herdr-agent:origin' } });
  run = store.dispatch({ bindingId: worker.binding.id, bindingRevision: worker.binding.revision,
    companyId: 'company', agentId: 'agent', taskId: 'parent', runId: 'backend-run' });
  const connection = { socketPath: service.socketPath, token: worker.token };
  const path = `/runs/${run.id}/wait-children`;
  for (const token of [other.token, 'bridge-token']) {
    await assert.rejects(call({ ...connection, token }, 'POST', path, { taskIds: ['b', 'a'] }), { code: 'forbidden', status: 403 });
  }
  await assert.rejects(call(connection, 'POST', path, { taskIds: ['b', 'a'] }), { code: 'adapter_unavailable', status: 503 });
  await call(service, 'POST', `/runs/${run.id}/attach`, { token: 'backend-token', runId: 'backend-run' });
  await assert.rejects(call(connection, 'POST', path, { taskIds: ['b', 'a'] }), { code: 'work_inactive', status: 409 });
  await call(connection, 'POST', `/runs/${run.id}/acknowledge`, {});
  await assert.rejects(call(connection, 'POST', path, { taskIds: ['a', 'a'] }), { code: 'invalid_request' });
  assert.deepEqual(requests, [], 'Authentication, adapter and input fences must precede backend access');
  children[1].parentId = 'foreign-parent';
  await assert.rejects(call(connection, 'POST', path, { taskIds: ['b', 'a'] }), { code: 'dependency_scope_mismatch', status: 409 });
  assert.equal(requests.some(request => request.method !== 'GET'), false);
  assert.equal(store.operation(`dependency:${run.id}`), null);
  children[1].parentId = 'parent';
  requests.length = 0;
  const waiting = await call(connection, 'POST', path, { taskIds: ['b', 'a'] });
  assert.deepEqual(waiting.dependency, { taskIds: ['a', 'b'], state: 'recorded' });
  assert.equal(waiting.dependencyWait.state, 'waiting');
  assert.deepEqual(waiting.dependencyWait.pendingTaskIds, ['a', 'b']);
  assert.equal(waiting.nativeState, 'claimed', 'Recording a dependency must not settle the native turn');
  assert.deepEqual(requests.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'GET', path: '/api/issues/a', body: undefined },
    { method: 'GET', path: '/api/issues/b', body: undefined },
    { method: 'GET', path: '/api/issues/parent', body: undefined },
    { method: 'PATCH', path: '/api/issues/parent', body: { status: 'blocked', blockedByIssueIds: ['a', 'b', 'existing'] } },
    { method: 'GET', path: '/api/issues/parent', body: undefined },
  ]);
  assert.ok(requests.every(request => request.token === 'Bearer backend-token' && request.runId === 'backend-run'),
    'Backend requests must use the attached adapter credential and exact run, not the worker credential');
  assert.deepEqual(store.operation(`dependency:${run.id}`).taskIds, ['a', 'b']);
  assert.equal(store.operation(`dependency:${run.id}`).state, 'recorded');
  const retry = await call(connection, 'POST', path, { taskIds: ['a', 'b'] });
  assert.deepEqual(retry.dependency, waiting.dependency);
  await assert.rejects(call(connection, 'POST', path, { taskIds: ['a'] }), { code: 'operation_conflict', status: 409 });
  await assert.rejects(call(connection, 'POST', `/runs/${run.id}/submit`, { key: 'premature', candidate: 'revision', summary: 'Not finished' }),
    { code: 'work_waiting' });
  assert.equal(requests.filter(request => request.method === 'PATCH').length, 1, 'Canonical retries must not replay the backend mutation');
});
