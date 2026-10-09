import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { herdrConfig, observedAgents, reconcileHerdrAgents, watchHerdrAgents } from '../src/herdr-agents.mjs';
import { execute } from '../src/adapter.mjs';
import { systemdUnit } from '../src/installation.mjs';

const config = { socketPath: '/tmp/herdr-test.sock', machineId: 'machine', session: 'default', companyId: 'company', excludedWorkspaces: [] };
const agent = (session = 'one', extra = {}) => ({ agent: 'opencode', agent_status: 'idle', pane_id: 'w1:p1',
  terminal_id: 'terminal', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/work',
  agent_session: { agent: 'opencode', kind: 'id', value: session, source: 'herdr:opencode' }, ...extra });
function backend() {
  const agents = [];
  const calls = [];
  return { agents, calls, api: async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return structuredClone(agents);
    if (method === 'POST') {
      const result = { ...structuredClone(body), id: `agent-${agents.length + 1}`, companyId: 'company', status: 'idle' };
      agents.push(result);
      return structuredClone(result);
    }
    const target = agents.find(item => path.endsWith(`/${item.id}`));
    Object.assign(target, structuredClone(body));
    return structuredClone(target);
  } };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(20); }
  assert.fail('Condition did not settle');
}

test('only detected conversations register; movement, replacement, exit and resume preserve identity', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const b = backend();
  const sync = agents => reconcileHerdrAgents(store, b.api, config, { agents });
  await sync([]);
  await sync([agent('one', { agent: null, agent_session: null })]);
  await sync([agent('one', { agent_session: null })]);
  assert.equal(b.agents.length, 0);
  await sync([agent()]);
  const id = observedAgents(store)[0].agentId;
  assert.equal(b.agents[0].status, 'paused');
  assert.equal(b.agents[0].runtimeConfig.heartbeat.wakeOnDemand, false);
  await sync([agent('one', { pane_id: 'w2:p2', workspace_id: 'w2' })]);
  assert.equal(observedAgents(store)[0].agentId, id);
  assert.equal(observedAgents(store)[0].placement.paneId, 'w2:p2');
  await sync([]);
  assert.equal(observedAgents(store)[0].availability, 'offline');
  await sync([agent()]);
  assert.equal(observedAgents(store)[0].availability, 'present');
  await sync([agent('two')]);
  assert.equal(b.agents.length, 2);
  assert.equal(observedAgents(store).find(item => item.agentId === id).availability, 'offline');
  assert.equal(store.bindings().length, 0, 'Observations must not create deliverable bindings');
});

test('lost create replies reconcile after restart, without retrying uncertain absent creation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-herdr-state-'));
  let store = new Store(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const b = backend(); let lost = true;
  const api = async (...args) => { const result = await b.api(...args); if (args[0] === 'POST' && lost) { lost = false; throw new Error('lost'); } return result; };
  await reconcileHerdrAgents(store, api, config, { agents: [agent()] });
  assert.equal(observedAgents(store)[0].state, 'uncertain');
  store.close(); store = new Store(join(root, 'state.sqlite'));
  await reconcileHerdrAgents(store, api, config, { agents: [agent()] });
  assert.equal(observedAgents(store)[0].state, 'recorded');
  assert.equal(b.agents.length, 1);
  const absent = async method => { if (method === 'GET') return []; throw new Error('lost before commit'); };
  await reconcileHerdrAgents(store, absent, config, { agents: [agent('new')] });
  await reconcileHerdrAgents(store, absent, config, { agents: [agent('new')] });
  assert.equal(observedAgents(store).find(item => item.identity.conversationId === 'new').error, 'agent_creation_uncertain');
});

test('Herdr display details enrich existing agents and follow renames without losing other metadata', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const b = backend();
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent()] });
  const id = b.agents[0].id;
  b.agents[0].metadata.notes = 'Keep this';
  b.agents[0].capabilities = 'Operator-written description';
  const snapshot = { agents: [agent('one', { terminal_title: '\x1b[31mOC | Build gateway\x1b[0m', foreground_cwd: '/work/src' })],
    workspaces: [{ workspace_id: 'w1', label: 'Relay' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Development' }] };
  await reconcileHerdrAgents(store, b.api, config, snapshot);
  assert.equal(b.agents[0].name, 'Relay');
  assert.equal(b.agents[0].metadata.relayObservation.display.terminalTitle, 'OC | Build gateway');
  assert.equal(b.agents[0].title, 'opencode | Relay | tab Development');
  assert.equal(b.agents[0].metadata.relayObservation.placement.foregroundDirectory, '/work/src');
  snapshot.workspaces[0].label = 'Renamed workspace';
  snapshot.agents[0].name = 'reviewer';
  await reconcileHerdrAgents(store, b.api, config, snapshot);
  assert.equal(b.agents[0].name, 'reviewer');
  assert.equal(b.agents[0].metadata.relayObservation.display.workspaceLabel, 'Renamed workspace');
  assert.equal(b.agents[0].id, id);
  assert.equal(b.agents.length, 1);
  assert.equal(b.agents[0].metadata.notes, 'Keep this');
  assert.equal(b.agents[0].capabilities, 'Operator-written description');
  const writes = b.calls.filter(call => call.method === 'PATCH').length;
  await reconcileHerdrAgents(store, b.api, config, snapshot);
  assert.equal(b.calls.filter(call => call.method === 'PATCH').length, writes, 'Unchanged labels must not generate repeated updates');
  await reconcileHerdrAgents(store, b.api, config, { agents: [] });
  assert.equal(b.agents[0].name, 'reviewer', 'Offline agents retain their last known name');
  assert.equal(b.agents[0].metadata.relayObservation.display.agentName, 'reviewer');
});

test('display falls back to pane label or directory and remains bounded', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const b = backend();
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent()],
    panes: [{ pane_id: 'w1:p1', terminal_id: 'terminal', label: 'Worker' }] });
  assert.equal(b.agents[0].name, 'work');
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent('one', { name: 'x'.repeat(500) + '\n' })] });
  assert.equal(b.agents[0].name.length, 240);
});

test('Paperclip allocated names are retained while observation metadata keeps updating', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const b = backend();
  const api = async (method, path, body) => {
    if (method === 'PATCH') assert.equal(body.name, undefined, 'Do not restore a conflicting name');
    const result = await b.api(method, path, body);
    if (method === 'POST') { b.agents.at(-1).name = 'work 2'; result.name = 'work 2'; }
    return result;
  };
  await reconcileHerdrAgents(store, api, config, { agents: [agent()] });
  await reconcileHerdrAgents(store, api, config, { agents: [agent('one', { agent_status: 'working' })] });
  assert.equal(b.agents[0].name, 'work 2');
  assert.equal(observedAgents(store)[0].error, null);
  assert.equal(b.agents[0].metadata.relayObservation.state, 'working');
});

test('duplicate identities, excluded workspaces, stale snapshots and changed backend ownership fail closed', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const b = backend();
  await reconcileHerdrAgents(store, b.api, { ...config, excludedWorkspaces: ['w1'] }, { agents: [agent()] });
  assert.equal(b.agents.length, 0);
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent()] }, () => false);
  assert.equal(b.agents.length, 0);
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent(), agent('one', { pane_id: 'w2:p1', terminal_id: 'other' })] });
  assert.equal(b.agents.length, 0);
  assert.equal(observedAgents(store)[0].availability, 'unknown');
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent()] });
  b.agents[0].adapterConfig.observationOnly = false;
  await reconcileHerdrAgents(store, b.api, config, { agents: [agent()] });
  assert.equal(observedAgents(store)[0].error, 'observed_agent_conflict');
  assert.equal(b.agents[0].adapterConfig.observationOnly, false);
  await assert.rejects(reconcileHerdrAgents(store, b.api, config, { agents: [{}] }), { code: 'invalid_herdr_snapshot' });
  await assert.rejects(execute({ config: { observationOnly: true } }), { code: 'agent_observation_only' });
});

test('observer subscribes before snapshot, handles delayed session identity and reconnect inventory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-herdr-socket-'));
  const socketPath = join(root, 'herdr.sock');
  const store = new Store(':memory:'); const b = backend();
  let agents = [], connections = 0, subscriptionSeen = false; const sockets = new Set(), subscriptions = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => { sockets.delete(socket); subscriptions.delete(socket); });
    socket.on('error', error => { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) throw error; });
    let buffer = '', subscribed = false;
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (request.method === 'events.subscribe') {
          subscribed = true; subscriptionSeen = true; connections++; subscriptions.add(socket);
          socket.write(JSON.stringify({ id: request.id, result: { type: 'subscription_started' } }) + '\n');
        } else {
          assert.ok(subscriptionSeen);
          assert.equal(subscribed, false, 'Snapshot RPC must not reuse the subscription connection');
          socket.write(JSON.stringify({ id: request.id, result: { type: 'session_snapshot', snapshot: { agents } } }) + '\n');
        }
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  let slowPassCurrent;
  const watcher = watchHerdrAgents(store, b.api, { ...config, socketPath }, { intervalMs: 50, reconnectMs: 100,
    afterReconcile: async current => {
      if (slowPassCurrent !== undefined) return;
      await delay(150);
      slowPassCurrent = current();
    },
  });
  t.after(async () => { await watcher.close(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(root, { recursive: true, force: true }); });
  await until(() => watcher.status()?.state === 'connected');
  assert.equal(slowPassCurrent, true, 'Periodic ticks must not invalidate a slow enrolment pass without inventory events');
  agents = [agent('one', { agent_session: null })];
  for (const socket of subscriptions) socket.write('{"event":"pane.agent_detected","data":{}}\n');
  await delay(100); assert.equal(b.agents.length, 0);
  agents = [agent()];
  for (const socket of subscriptions) socket.write('{"event":"pane.updated","data":{}}\n');
  await until(() => b.agents.length === 1 && b.agents[0].status === 'paused');
  for (const socket of sockets) socket.destroy();
  await until(() => observedAgents(store)[0].availability === 'unknown');
  await until(() => connections >= 2 && observedAgents(store)[0].availability === 'present');
  assert.equal(b.agents.length, 1);
});

test('Herdr source config requires an explicit scoped socket and company', () => {
  assert.deepEqual(herdrConfig(config), config);
  assert.throws(() => herdrConfig({ ...config, socketPath: 'relative' }), { code: 'invalid_herdr_config' });
  assert.throws(() => herdrConfig({ ...config, bridgeDirectories: ['relative'] }), { code: 'invalid_herdr_config' });
  assert.deepEqual(herdrConfig({ ...config, bridgeDirectories: ['/work'] }).bridgeDirectories, ['/work']);
  assert.deepEqual(herdrConfig({ ...config, workerProvisioning: { mode: 'localUser', maxActiveWorkers: 10 } }).workerProvisioning,
    { mode: 'localUser', maxActiveWorkers: 10 });
  for (const workerProvisioning of [{ mode: 'strict' }, { mode: 'localUser', extra: true },
    { mode: 'localUser', maxActiveWorkers: 0 }, { mode: 'localUser', maxActiveWorkers: 101 }]) {
    assert.throws(() => herdrConfig({ ...config, workerProvisioning }), { code: 'invalid_herdr_config' });
  }
  const installation = { node: '/usr/bin/node', cli: '/app/cli.mjs', stateDirectory: '/state', paperclipUrl: 'http://127.0.0.1:3100',
    backendContextFile: '/state/backend.json', herdrConfigFile: '/state/herdr config.json' };
  assert.match(systemdUnit(installation), /"--herdr-config" "\/state\/herdr config.json"/);
  assert.throws(() => systemdUnit({ ...installation, herdrConfigFile: '/state/herdr\nExecStart=bad' }), { code: 'invalid_installation' });
});
