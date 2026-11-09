import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
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
