import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';
import { enrolmentDirectories } from '../src/enrolment.mjs';

const issueId = '00000000-0000-4000-8000-000000000001';
const collectionPaths = ['/api/companies/company', '/api/companies/company/agents',
  '/api/companies/company/projects?includeArchived=true',
  '/api/companies/company/issues?limit=1000&sortField=id&sortDir=asc&includePluginOperations=true'];
const bridgeActions = ['poll', 'begin', 'observe', 'questions', 'answer', 'reviews', 'review',
  'agents', 'delegate', 'delegation-status', 'tasks', 'enrolment-candidates', 'enrol-agent',
  'workers', 'prepare-worker', 'grant-review', 'revoke-review',
  'notification-list', 'notification-history', 'notification-begin', 'notification-observe'];

async function fixture(t, { configured = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'relay-enrol-service-'));
  const sockets = new Set();
  let subscribed;
  const subscription = new Promise(resolve => { subscribed = resolve; });
  const herdr = createSocketServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) throw error; });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (request.method === 'events.subscribe') {
          socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
          subscribed();
        } else {
          assert.equal(request.method, 'session.snapshot');
          // Hold inventory RPCs: these route tests own their seeded observations.
          // Keep the subscription live so reconnects cannot mark them unknown.
        }
      }
    });
  });
  const requests = [];
  const backend = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, token: req.headers.authorization });
    const routes = new Map([
      [collectionPaths[0], { id: 'company', name: 'Company', secret: 'company-secret' }],
      [collectionPaths[1], [{ id: 'agent-origin', companyId: 'company', name: 'Origin',
        adapterConfig: { token: 'adapter-secret' }, runtimeConfig: { token: 'runtime-secret' } }]],
      [collectionPaths[2], [{ id: 'project', companyId: 'company', name: 'Project',
        workspaces: [{ token: 'workspace-secret' }] }]],
      [collectionPaths[3], [{ id: issueId, companyId: 'company', identifier: 'TEST-1', title: 'Human backlog',
        status: 'backlog', priority: 'medium', assigneeUserId: 'human', projectId: 'project',
        description: 'Collection preview', executionRun: { token: 'execution-secret' },
        source: { text: 'full-source-secret' }, credentials: { token: 'task-secret' } }]],
    ]);
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET' || !routes.has(req.url)) {
      res.writeHead(404); res.end(JSON.stringify({ message: 'Unexpected fixture request' })); return;
    }
    res.end(JSON.stringify(routes.get(req.url)));
  });
  let service;
  t.after(async () => {
    await service?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => herdr.close(resolve));
    await new Promise(resolve => backend.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendContextFile = join(root, 'backend.json');
  writeFileSync(backendContextFile, JSON.stringify({ token: 'backend-operator-secret' }));
  const config = { companyId: 'company', machineId: 'machine', session: 'session',
    socketPath: join(root, 'herdr.sock') };
  if (configured) await new Promise(resolve => herdr.listen(config.socketPath, resolve));
  const herdrConfigFile = join(root, 'herdr.json');
  writeFileSync(herdrConfigFile, JSON.stringify(config));
  service = await startService({ directory: join(root, 'state'),
    paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile,
    ...(configured ? { herdrConfigFile } : {}) });
  if (configured) await subscription;
  const observations = [];
  const add = (name, state = 'configured', companyId = 'company') => {
    const directory = join(root, name);
    mkdirSync(directory);
    const identity = { companyId, machineId: config.machineId, session: config.session,
      harness: 'opencode', sessionKind: 'id', conversationId: `session-${name}` };
    const observed = service.store.saveOperation({ id: `herdr-agent:${digest(identity)}`, runId: '', identity,
      state: 'recorded', availability: 'present', agentId: `agent-${name}`, marker: `marker-${name}`,
      placement: { directory, terminalId: `terminal-${name}` }, token: 'observation-secret',
      observation: { state: state === 'armed' ? 'idle' : 'busy', display: { name }, source: 'full-source-secret' } });
    observations.push(observed);
    const registered = service.store.register({ id: `observed-${digest(observed.id).slice(0, 24)}`,
      companyId, agentId: observed.agentId, harness: 'opencode', delivery: 'pull',
      instanceId: digest([config.machineId, config.session]), conversationId: identity.conversationId });
    const token = `bridge-${name}-secret`;
    const bridge = service.store.saveOperation({ id: `opencode-bridge:${registered.binding.id}`, runId: '', state,
      tokenHash: digest(token), epoch: `epoch-${name}`, sessionCreatedAt: 123, ready: state === 'armed',
      lastSeen: new Date().toISOString(), workerContext: '/private/context-secret.json',
      identity: { bindingId: registered.binding.id, observedId: observed.id,
        conversationId: identity.conversationId, ...observed.placement } });
    return { observed, bridge, binding: registered.binding, workerToken: registered.token,
      connection: { socketPath: service.socketPath, token }, directory };
  };
  const origin = add('origin'), target = add('target', 'armed');
  add('foreign', 'armed', 'other-company');
  const snapshot = { conversationId: origin.bridge.identity.conversationId,
    terminalId: origin.bridge.identity.terminalId, epoch: origin.bridge.epoch, sessionCreatedAt: 123, idle: false };
  const source = { id: 'native-human', text: 'Reserve this exact directory for Relay. full-source-secret', createdAt: 456, role: 'user' };
  const refresh = () => {
    for (const observed of observations) service.store.saveOperation(observed);
  };
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }));
  return { root, service, requests, config, herdrConfigFile, origin, target, snapshot, source, context, refresh,
    invoke(action, input = {}) { refresh(); return call(origin.connection, 'POST', `/bridge/${action}`, { ...snapshot, ...input }); },
    enrol(input = {}) { refresh(); return call(service, 'POST', '/herdr/enrol', {
      key: 'operator-enrol', directory: origin.directory, reserved: true, ...input }); } };
}

test('configured busy native bridge reads only its company board and ready peers without dispatch or arming', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.invoke('poll'), { state: 'configured', run: null });
  const board = await f.invoke('tasks', { companyId: 'other-company', bindingId: f.target.binding.id,
    scope: '*', directory: '/unrelated', source: f.source });
  assert.deepEqual(board, {
    tasks: [{ id: issueId, companyId: 'company', identifier: 'TEST-1', title: 'Human backlog',
      status: 'backlog', priority: 'medium', parentId: null, assigneeAgentId: null, assigneeUserId: 'human',
      projectId: 'project', descriptionPreview: 'Collection preview', updatedAt: null }],
    projects: [{ id: 'project', companyId: 'company', name: 'Project' }],
    agents: [{ id: 'agent-origin', companyId: 'company', name: 'origin', availability: 'present',
      bridgeState: 'configured', nativeState: 'busy' }], fetchedAt: board.fetchedAt, warnings: [],
  });
  assert.ok(Number.isFinite(Date.parse(board.fetchedAt)));
  assert.equal(JSON.stringify(board).includes('secret'), false);
  assert.deepEqual(await f.invoke('agents'), { agents: [{ bindingId: f.target.binding.id,
    agentId: 'agent-target', label: 'target', directory: f.target.directory }] });
  assert.deepEqual(await f.invoke('delegation-status'), { delegations: [] });
  assert.deepEqual(await f.invoke('notification-history'), { notifications: [] });
  assert.deepEqual(f.requests, collectionPaths.map(path => ({ method: 'GET', path, token: 'Bearer backend-operator-secret' })));
  for (const action of ['delegate', 'answer', 'review', 'notification-list', 'notification-begin', 'notification-observe']) {
    await assert.rejects(f.invoke(action, { key: 'write', targetBindingId: f.target.binding.id,
      title: 'Do not create', description: 'Do not dispatch', decision: 'accept', interactionId: 'review', source: f.source }),
    { code: 'bridge_unavailable', status: 409 });
  }
  const live = f.service.store.operation(f.origin.bridge.id);
  assert.equal(live.state, 'configured');
  assert.equal(live.ready, false);
  assert.equal(live.sessionCreatedAt, 123);
  assert.equal(live.epoch, f.snapshot.epoch);
  assert.deepEqual(f.service.store.runs(), []);
  assert.equal(f.requests.length, collectionPaths.length);
});

test('configured reads require the exact current native conversation and reject inactive bridges', async t => {
  const f = await fixture(t);
  for (const action of ['tasks', 'agents', 'delegation-status', 'notification-history', 'enrolment-candidates', 'enrol-agent']) {
    for (const input of [{ conversationId: 'other' }, { terminalId: 'other' }, { sessionCreatedAt: 124 }]) {
      await assert.rejects(f.invoke(action, input), { code: 'bridge_identity_mismatch', status: 409 });
    }
  }
  f.service.store.retireBinding(f.origin.binding.id);
  await assert.rejects(f.invoke('tasks'), { code: 'bridge_unavailable', status: 409 });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.service.store.runs(), []);
});

test('worker credentials cannot access any bridge route or operator enrolment routes', async t => {
  const f = await fixture(t, { configured: true });
  const worker = { socketPath: f.service.socketPath, token: f.origin.workerToken };
  for (const action of bridgeActions) {
    await assert.rejects(call(worker, 'POST', `/bridge/${action}`, f.snapshot), { code: 'forbidden', status: 403 });
  }
  for (const connection of [worker, f.origin.connection]) {
    await assert.rejects(call(connection, 'GET', '/herdr/enrolment-candidates'), { code: 'forbidden', status: 403 });
    await assert.rejects(call(connection, 'POST', '/herdr/enrol', {
      key: 'forbidden', directory: f.origin.directory, reserved: true }), { code: 'forbidden', status: 403 });
  }
  await assert.rejects(call({ ...worker, token: 'unknown' }, 'POST', '/bridge/tasks', f.snapshot),
    { code: 'unauthorised', status: 401 });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.service.store.runs(), []);
  assert.equal(f.service.store.operation(f.origin.bridge.id).state, 'configured');
});

test('operator enrolment inspects a real directory and persists an idempotent scoped reservation, not readiness', async t => {
  const f = await fixture(t, { configured: true });
  const originalConfig = readFileSync(f.herdrConfigFile, 'utf8');
  f.refresh();
  const { candidates } = await call(f.service, 'GET', '/herdr/enrolment-candidates');
  assert.deepEqual(new Set(candidates.map(item => item.directory)), new Set([f.origin.directory, f.target.directory]));
  assert.equal(JSON.stringify(candidates).includes('secret'), false);
  assert.ok(candidates.every(item => item.enrolled === false && item.ready === false));
  assert.deepEqual((await f.invoke('enrolment-candidates', { companyId: 'other-company', scope: '*' })).candidates, candidates);
  const result = await f.enrol();
  assert.deepEqual(result, { enrolmentId: result.enrolmentId, directory: f.origin.directory,
    state: 'requested', observedId: f.origin.observed.id, alreadyConfigured: false, status: null, blocker: null, ready: false });
  const grant = f.service.store.operation(result.enrolmentId);
  assert.equal(grant.state, 'recorded');
  assert.deepEqual(grant.scope, f.config);
  assert.deepEqual(grant.request, { key: 'operator-enrol', directory: f.origin.directory, reserved: true });
  assert.deepEqual(grant.origin, { kind: 'operator' });
  assert.deepEqual(enrolmentDirectories(f.service.store, f.config), [f.origin.directory]);
  assert.deepEqual(await f.enrol(), result);
  assert.deepEqual(f.service.store.operation(result.enrolmentId), grant);
  const listed = (await f.invoke('enrolment-candidates')).candidates.find(item => item.directory === f.origin.directory);
  assert.equal(listed.enrolled, true);
  assert.equal(listed.ready, false);
  assert.equal(readFileSync(f.herdrConfigFile, 'utf8'), originalConfig);
  assert.deepEqual(f.service.store.operation(f.origin.bridge.id), {
    ...f.origin.bridge, lastSeen: f.service.store.operation(f.origin.bridge.id).lastSeen,
    updatedAt: f.service.store.operation(f.origin.bridge.id).updatedAt,
  });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.service.store.runs(), []);
});

test('configured busy bridge enrolment requires native human input and cannot override enrolment scope', async t => {
  const f = await fixture(t, { configured: true });
  const input = { key: 'native-enrol', directory: f.origin.directory, reserved: true, source: f.source };
  for (const source of [undefined, { ...f.source, synthetic: true }, { ...f.source, role: 'assistant' }]) {
    await assert.rejects(f.invoke('enrol-agent', { ...input, source }), { code: 'invalid_enrolment_source' });
  }
  for (const override of [{ scope: '*' }, { machineId: 'other' }, { session: 'other' },
    { socketPath: '/other.sock' }, { command: 'arbitrary' }, { origin: { kind: 'operator' } }]) {
    await assert.rejects(f.invoke('enrol-agent', { ...input, ...override }), { code: 'invalid_request' });
    await assert.rejects(f.enrol(override), { code: 'invalid_request' });
  }
  await assert.rejects(f.invoke('enrol-agent', { ...input, companyId: 'other-company' }), { code: 'company_mismatch', status: 403 });
  await assert.rejects(f.enrol({ companyId: 'other-company' }), { code: 'company_mismatch', status: 403 });
  await assert.rejects(f.enrol({ reserved: false }), { code: 'reservation_required' });
  assert.equal(f.service.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'directory-enrolment:%'").get().count, 0);
  const result = await f.invoke('enrol-agent', input);
  const grant = f.service.store.operation(result.enrolmentId);
  assert.equal(grant.origin.kind, 'native');
  assert.equal(grant.origin.bindingId, f.origin.binding.id);
  assert.equal(grant.origin.sourceMessageId, f.source.id);
  assert.equal(grant.origin.sourceDigest, digest(f.source.text));
  assert.equal(JSON.stringify(grant).includes('secret'), false);
  assert.deepEqual(grant.scope, f.config);
  assert.deepEqual(await f.invoke('enrol-agent', input), result);
  assert.equal(result.ready, false);
  assert.equal(f.service.store.operation(f.origin.bridge.id).state, 'configured');
  assert.equal(f.service.store.operation(f.origin.bridge.id).ready, false);
  assert.deepEqual(f.service.store.runs(), []);
  assert.deepEqual(f.requests, []);
});

test('enrolment requires a configured Herdr source even for operator and valid native credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(call(f.service, 'GET', '/herdr/enrolment-candidates'), { code: 'enrolment_unavailable', status: 409 });
  await assert.rejects(f.enrol(), { code: 'enrolment_unavailable', status: 409 });
  for (const action of ['enrolment-candidates', 'enrol-agent']) {
    await assert.rejects(f.invoke(action), { code: 'enrolment_unavailable', status: 409 });
  }
  assert.deepEqual(f.requests, []);
});

test('real CLI uses the operator context for enrolment and refuses an omitted reservation or company override', async t => {
  const f = await fixture(t, { configured: true });
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const run = async args => {
    f.refresh();
    return promisify(execFile)(process.execPath, [cli, '--context', f.context, 'agent', ...args],
      { cwd: f.root, timeout: 10000 });
  };
  const args = ['enrol', '--directory', f.origin.directory, '--key', 'cli-enrol'];
  await delay(1100);
  assert.equal(f.service.store.operation(f.origin.observed.id).availability, 'present', 'A live subscription preserves seeded observations past reconnect time');
  await assert.rejects(run(args), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).code, 'reservation_required');
    return true;
  });
  await assert.rejects(run([...args, '--reserved', '--company', 'other-company']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).code, 'invalid_request');
    return true;
  });
  assert.equal(f.service.store.db.prepare("SELECT count(*) AS count FROM operations WHERE id LIKE 'directory-enrolment:%'").get().count, 0);
  const result = JSON.parse((await run([...args, '--reserved'])).stdout);
  assert.deepEqual(f.service.store.operation(result.enrolmentId).request,
    { key: 'cli-enrol', directory: f.origin.directory, reserved: true });
  assert.deepEqual(JSON.parse((await run([...args, '--reserved'])).stdout), result);
  const listed = JSON.parse((await run(['enrolment-candidates'])).stdout);
  assert.equal(listed.candidates.find(item => item.directory === f.origin.directory).enrolled, true);
  assert.equal(result.ready, false);
  assert.deepEqual(f.service.store.runs(), []);
  assert.deepEqual(f.requests, []);
});
