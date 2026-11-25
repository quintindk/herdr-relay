import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startBackend } from '../src/backend-service.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { NativeReceivers } from '../src/native-receivers.mjs';

test('real node daemon starts, stops, restarts offline from pinned identity and preserves its journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-daemon-'));
  const state = join(root, 'node'); mkdirSync(state);
  let backend = await startBackend({ database: join(root, 'backend.sqlite') });
  const owner = backend.store.authenticate(backend.store.bootstrap().token);
  backend.store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const token = backend.store.enrolCredential(owner, 'node', 'credential').token;
  const configPath = join(root, 'node.json');
  writeFileSync(configPath, JSON.stringify({ nodeId: 'node', stateDirectory: state, backend: { url: backend.origin, token }, bindings: [] }), { mode: 0o600 });
  let child;
  const launch = async () => {
    child = spawn(process.execPath, [resolve('src/node-cli.mjs'), '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    for (let i = 0; i < 100 && !log.includes('"state":"running"'); i++) {
      if (child.exitCode !== null) throw new Error(log);
      await delay(25);
    }
    assert.match(log, /"state":"running"/);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  };
  try {
    await launch();
    assert.ok(existsSync(join(state, 'node.sqlite')));
    await stop();
    assert.equal(existsSync(join(state, 'node.sock')), false);
    await backend.close(); backend = null;
    await launch();
    await stop();
  } finally { await stop(); await backend?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real node startup excludes a refused attachment before native authentication or receiver loading', async t => {
  const root = mkdtempSync('/tmp/opencode/relay-refused-binding-daemon-'), state = join(root, 'node'); mkdirSync(state);
  const backend = await startBackend({ database: ':memory:' });
  const owner = backend.store.authenticate(backend.store.bootstrap().token);
  const command = (key, action, payload) => backend.store.command(owner, { key, action, payload });
  command('node', 'node.enrol', { id: 'node', name: 'Node' });
  const token = backend.store.enrolCredential(owner, 'node', 'credential').token;
  command('occupant', 'agent.enrol', { id: 'occupant', nodeId: 'node', name: 'Occupant', directory: root });
  command('occupied', 'agent.attach', { id: 'occupant', expectedBindingRevision: 0, bindingId: 'occupied-binding',
    conversationId: 'occupied-session', directory: root });
  command('agent', 'agent.enrol', { id: 'agent', nodeId: 'node', name: 'Agent', directory: root });
  const journal = new NodeJournal(join(state, 'node.sqlite'), { nodeId: 'node', instanceId: backend.store.instance });
  const receivers = new NativeReceivers(journal);
  receivers.enrol({ id: 'agent', name: 'Agent', directory: root, transport: 'tools' });
  const operation = receivers.prepare({ key: 'refused', agentId: 'agent', expectedGeneration: 0,
    identity: { sessionId: 'occupied-session', projectId: 'project', directory: root, createdAt: 1 },
    url: 'http://127.0.0.1:1', authFile: join(root, 'must-not-be-read.json') });
  assert.throws(() => command(operation.command.key, operation.command.action, operation.command.payload), { code: 'conversation_alias' });
  receivers.reject(operation, { code: 'conversation_alias' }, backend.store.get('agent', 'agent'));
  const before = receivers.get('attachment:refused'), configPath = join(root, 'node.json');
  writeFileSync(configPath, JSON.stringify({ identityVersion: 2, nodeId: 'node', stateDirectory: state,
    backend: { url: backend.origin, token }, bindings: [] }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve('src/node-cli.mjs'), '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    journal.close(); await backend.close(); rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !log.includes('"state":"running"'); i++) {
    if (child.exitCode !== null) throw Error(log);
    await delay(25);
  }
  assert.match(log, /"state":"running"/); assert.doesNotMatch(log, /conversation_alias|ENOENT|node_failed/);
  assert.ok(existsSync(join(state, 'worker-index.json')));
  assert.deepEqual(receivers.get('attachment:refused'), before);
  assert.deepEqual(receivers.get(`native-binding:${operation.binding.id}`), operation.binding);
  assert.equal(receivers.get(`retired-binding:${operation.binding.id}`), null);
});

test('the daemon advertises OpenCode presence without requesting transcripts on repeated heartbeats', { timeout: 20000 }, async t => {
  const root = mkdtempSync('/tmp/opencode/relay-presence-daemon-'), state = join(root, 'node');
  mkdirSync(state, { mode: 0o700 });
  const backend = await startBackend({ database: ':memory:' });
  const sessionId = 'ses_presence', info = { id: sessionId, projectID: 'global', location: { directory: root }, time: { created: 1 } };
  const requests = [];
  let active = {}, child, diagnostics = '';
  const runtime = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push(path);
    const reply = path === '/api/info' ? { version: '2.1.0', pid: process.pid, urls: [], paths: { tmp: root } }
      : path === `/api/session/${sessionId}` ? { data: info }
        : path === '/api/session/active' ? { data: active } : null;
    res.writeHead(reply ? 200 : 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply));
  });
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
    }
    await new Promise(resolve => runtime.close(resolve)); await backend.close();
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));

  const owner = backend.store.authenticate(backend.store.bootstrap().token);
  backend.store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const token = backend.store.enrolCredential(owner, 'node', 'credential').token;
  const configPath = join(root, 'node.json'), authFile = join(root, 'fixture-auth.json');
  writeFileSync(authFile, JSON.stringify({ password: 'fixture-only' }), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ nodeId: 'node', stateDirectory: state, backend: { url: backend.origin, token }, bindings: [{
    id: 'binding', agentId: 'agent', mode: 'interactive', harness: 'opencode-v2', reserved: true, authFile,
    url: `http://127.0.0.1:${runtime.address().port}`,
    identity: { sessionId, projectId: info.projectID, directory: root, createdAt: info.time.created },
  }] }), { mode: 0o600 });

  child = spawn(process.execPath, [resolve('src/node-cli.mjs'), '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { diagnostics += chunk; });
  child.stderr.on('data', chunk => { diagnostics += chunk; });
  const waitFor = async availability => {
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (backend.store.get('agent', 'agent', false)?.availability === availability) return;
      await delay(30);
    }
    assert.fail(`Agent did not advertise ${availability}: ${diagnostics}`);
  };
  await waitFor('available');
  active = { [sessionId]: { type: 'running' } };
  await waitFor('busy');
  assert.equal(requests.filter(path => path === '/api/session/active').length, 2);
  assert.ok(requests.every(path => ['/api/info', `/api/session/${sessionId}`, '/api/session/active'].includes(path)), requests.join('\n'));
});
