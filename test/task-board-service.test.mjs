import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

const issueId = '00000000-0000-4000-8000-000000000001';
const issueQuery = 'limit=1000&sortField=id&sortDir=asc&includePluginOperations=true';
const collectionPaths = [
  '/api/companies/company/agents',
  '/api/companies/company/projects?includeArchived=true',
  `/api/companies/company/issues?${issueQuery}`,
];

async function fixture(t, { configuredCompany = false, backendContext = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relay-board-'));
  const requests = [];
  const company = { id: 'company', name: 'Fixture company', secret: 'company-secret' };
  const agents = [{ id: 'agent', companyId: company.id, name: 'Fixture agent',
    adapterType: 'herdr_relay', adapterConfig: { token: 'adapter-secret', authFile: '/private/adapter.json' },
    runtimeConfig: { token: 'runtime-secret' } }];
  const projects = [{ id: 'project', companyId: company.id, name: 'Fixture project',
    workspaces: [{ cwd: '/private/workspace', token: 'workspace-secret' }] }];
  const tasks = [{ id: issueId, companyId: company.id, identifier: 'FIX-1', title: 'Fixture task',
    status: 'todo', priority: 'medium', parentId: null, assigneeAgentId: 'agent', assigneeUserId: null,
    projectId: 'project', description: 'Collection description preview', updatedAt: '2026-10-07T08:00:00.000Z',
    executionRunId: 'private-run', executionRun: { token: 'execution-secret' } }];
  const control = { failure: false, gate: null, entered: null };
  const backend = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url, token: req.headers.authorization,
      runId: req.headers['x-paperclip-run-id'] });
    control.entered?.();
    if (control.gate) await control.gate;
    res.setHeader('Content-Type', 'application/json');
    if (control.failure) {
      res.writeHead(503); res.end(JSON.stringify({ message: 'private backend failure: adapter-secret' })); return;
    }
    const routes = new Map([
      ['/api/companies', [company]], ['/api/companies/company', company],
      [collectionPaths[0], agents], [collectionPaths[1], projects], [collectionPaths[2], tasks],
    ]);
    if (req.method !== 'GET' || !routes.has(req.url)) {
      res.writeHead(404); res.end(JSON.stringify({ message: 'Unexpected fixture request' })); return;
    }
    res.end(JSON.stringify(routes.get(req.url)));
  });
  let service;
  t.after(async () => {
    await service?.close();
    await new Promise(resolve => backend.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json');
  writeFileSync(auth, JSON.stringify({ token: 'fixture-operator-token' }));
  const herdr = join(root, 'herdr.json');
  if (configuredCompany) writeFileSync(herdr, JSON.stringify({ companyId: company.id,
    machineId: 'fixture-machine', session: 'fixture-session', socketPath: join(root, 'absent-herdr.sock') }));
  service = await startService({ directory: join(root, 'state'),
    paperclipUrl: `http://127.0.0.1:${backend.address().port}`,
    backendContextFile: backendContext ? auth : undefined, herdrConfigFile: configuredCompany ? herdr : undefined });
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }));
  return { service, requests, tasks, control, context, read: () => call(service, 'GET', '/task-board') };
}

test('operator task board projects HTTP collections without exposing backend or adapter credentials', async t => {
  const f = await fixture(t);
  const board = await f.read();
  assert.deepEqual(board, {
    companies: [{ id: 'company', name: 'Fixture company' }],
    agents: [{ id: 'agent', companyId: 'company', name: 'Fixture agent', availability: 'unknown',
      bridgeState: null, nativeState: 'unknown' }],
    projects: [{ id: 'project', companyId: 'company', name: 'Fixture project' }],
    tasks: [{ id: issueId, companyId: 'company', identifier: 'FIX-1', title: 'Fixture task',
      status: 'todo', priority: 'medium', parentId: null, assigneeAgentId: 'agent', assigneeUserId: null,
      projectId: 'project', descriptionPreview: 'Collection description preview', updatedAt: '2026-10-07T08:00:00.000Z' }],
    totals: { companies: 1, agents: 1, projects: 1, tasks: 1 }, fetchedAt: board.fetchedAt, warnings: [],
  });
  assert.ok(Number.isFinite(Date.parse(board.fetchedAt)));
  assert.deepEqual(f.requests, ['/api/companies', ...collectionPaths].map(path => ({
    method: 'GET', path, token: 'Bearer fixture-operator-token', runId: undefined,
  })), 'The operator context must authorise collection reads, with no per-issue reads or writes');
});

for (const configuredCompany of [false, true]) {
  test(`task board selects company from ${configuredCompany ? 'Herdr configuration before bindings' : 'bindings before discovery'}`, async t => {
    const f = await fixture(t, { configuredCompany });
    for (const id of ['worker-a', 'worker-b']) f.service.store.register({ id,
      companyId: configuredCompany ? 'other-company' : 'company', agentId: id,
      harness: 'opencode', instanceId: 'fixture', conversationId: id });
    assert.deepEqual((await f.read()).companies, [{ id: 'company', name: 'Fixture company' }]);
    assert.deepEqual(f.requests.map(request => request.path), ['/api/companies/company', ...collectionPaths],
      'Company scope must not broaden to discovery or repeat reads for duplicate company bindings');
  });
}

test('task board refuses unknown, worker and bridge credentials before backend or cached access', async t => {
  const f = await fixture(t);
  const worker = f.service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'fixture', conversationId: 'worker' });
  f.service.store.saveOperation({ id: 'opencode-bridge:origin', runId: '', state: 'configured',
    tokenHash: digest('bridge-token'), identity: { observedId: 'herdr-agent:origin' } });
  for (const cached of [false, true]) {
    if (cached) await f.read();
    const before = f.requests.length;
    for (const [token, code, status] of [
      ['unknown', 'unauthorised', 401], ['', 'unauthorised', 401],
      [worker.token, 'forbidden', 403], ['bridge-token', 'forbidden', 403],
    ]) await assert.rejects(call({ socketPath: f.service.socketPath, token }, 'GET', '/task-board'), { code, status });
    assert.equal(f.requests.length, before, 'Denied requests must not touch the backend');
  }
});

test('task board shares concurrent refreshes and caches successful responses for exactly four seconds', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  f.control.gate = gate.promise;
  f.control.entered = entered.resolve;
  const pending = Promise.all(Array.from({ length: 8 }, () => f.read()));
  try {
    await entered.promise;
    // Keep the first backend response pending while the other socket requests arrive.
    await delay(30);
    assert.equal(f.requests.length, 1, 'Concurrent readers must share the pending backend request');
  } finally { gate.resolve(); }
  const boards = await pending;
  for (const board of boards) assert.deepEqual(board, boards[0]);
  assert.equal(f.requests.length, 4);
  f.tasks[0].title = 'Refreshed title';
  t.mock.timers.tick(3999);
  assert.deepEqual(await f.read(), boards[0]);
  assert.equal(f.requests.length, 4, 'A fresh cached response must not repeat collection reads');
  t.mock.timers.tick(1);
  const refreshed = await f.read();
  assert.equal(refreshed.tasks[0].title, 'Refreshed title');
  assert.equal(Date.parse(refreshed.fetchedAt) - Date.parse(boards[0].fetchedAt), 4000);
  assert.deepEqual(f.requests.map(request => request.path), [...Array(2)].flatMap(() => ['/api/companies', ...collectionPaths]));
});

test('failed task board refreshes return errors rather than stale success and can retry immediately', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t);
  for (const previouslyCached of [false, true]) {
    if (previouslyCached) t.mock.timers.tick(4000);
    f.control.failure = true;
    const before = f.requests.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.read(), { code: 'backend_unavailable', status: 502,
        message: 'Paperclip task board could not be refreshed' });
      assert.equal(f.requests.length, before + attempt + 1, 'Failed promises must not remain cached');
    }
    f.control.failure = false;
    f.tasks[0].title = previouslyCached ? 'Recovered after stale cache' : 'Recovered initial read';
    const recovered = await f.read();
    assert.equal(recovered.tasks[0].title, f.tasks[0].title);
    assert.equal(f.requests.length, before + 6);
    assert.deepEqual(await f.read(), recovered);
    assert.equal(f.requests.length, before + 6, 'Only successful recovery should populate the cache');
  }
});

test('task board requires a configured backend operator context', async t => {
  const f = await fixture(t, { backendContext: false });
  await assert.rejects(f.read(), { code: 'backend_unavailable', status: 502 });
  assert.deepEqual(f.requests, [], 'Relay admin credentials must not be forwarded as backend credentials');
});

test('real CLI board --json reads Relay and rejects --json --watch without contacting the backend', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const args = [cli, '--context', f.context, 'board', '--json'];
  await assert.rejects(promisify(execFile)(process.execPath, [...args, '--watch'], { timeout: 10000 }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.deepEqual(JSON.parse(error.stderr), { code: 'invalid_request', message: 'Choose --json or --watch' });
    return true;
  });
  assert.deepEqual(f.requests, []);
  const result = await promisify(execFile)(process.execPath, args, { timeout: 10000 });
  const board = JSON.parse(result.stdout);
  assert.equal(board.tasks[0].id, issueId);
  assert.deepEqual(board, await f.read());
  assert.deepEqual(f.requests.map(request => request.path), ['/api/companies', ...collectionPaths]);
});
