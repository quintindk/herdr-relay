import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { configureBridge, armBridge } from '../src/opencode-bridge.mjs';
import { createServer } from 'node:http';
import { digest } from '../src/protocol.mjs';
import plugin from '../src/opencode-bridge-plugin.mjs';

test('in-process plugin delivers and settles through the authenticated Relay bridge once', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://127.0.0.1:3100' });
  let hooks;
  t.after(async () => {
    await hooks?.dispose(); await service.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  service.store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'worker' } } });
  const backend = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } };
  const api = async (method, path, body) => { if (method === 'PATCH') Object.assign(backend, body); return structuredClone(backend); };
  const configured = await configureBridge(service.store, join(root, 'relay'), api, { observedId: 'herdr-agent:test', reserved: true });
  let sends = 0, run, historyReads = 0;
  const messages = [];
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 }, agent: 'build', model: { providerID: 'litellm', id: 'fixture-model' } } }),
    messages: async () => { historyReads++; return { data: structuredClone(messages) }; },
    status: async () => ({ data: {} }),
    promptAsync: async ({ body }) => {
      sends++;
      assert.equal(body.agent, 'build'); assert.equal(body.model.modelID, 'fixture-model');
      messages.push({ info: { id: body.messageID, sessionID: 'conversation', role: 'user' }, parts: body.parts });
      await hooks['chat.message']({ sessionID: 'conversation', messageID: body.messageID }, { message: { id: body.messageID } });
      service.store.acknowledge(run.id);
      service.store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Fixture answer' });
      messages.push({ info: { id: 'assistant', sessionID: 'conversation', role: 'assistant', parentID: body.messageID,
        finish: 'stop', time: { created: 124, completed: 125 } }, parts: [] });
      throw new Error('Response lost after provider accepted delivery');
    },
  } };
  const otherConfig = join(root, 'other-bridge.json');
  writeFileSync(otherConfig, JSON.stringify({ directory: '/other', conversationId: 'other', terminalId: 'other' }));
  const sameDirectory = join(root, 'same-directory.json');
  writeFileSync(sameDirectory, JSON.stringify({ directory: '/work', conversationId: 'other', terminalId: 'other' }));
  await assert.rejects(plugin({ client, directory: '/work' }, { configFiles: [configured.bridgeConfigFile, configured.bridgeConfigFile] }), /No unique bridge/);
  hooks = await plugin({ client, directory: '/work' }, { configFiles: [otherConfig, sameDirectory, configured.bridgeConfigFile] });
  await hooks.config();
  const until = async predicate => { for (let i = 0; i < 160; i++) { if (predicate()) return; await delay(50); } assert.fail('Bridge did not settle'); };
  await until(() => service.store.operation(`opencode-bridge:${configured.bindingId}`).ready);
  assert.equal(historyReads, 0, 'No task: readiness must not load conversation history');
  const firstSeen = service.store.operation(`opencode-bridge:${configured.bindingId}`).lastSeen;
  await until(() => service.store.operation(`opencode-bridge:${configured.bindingId}`).lastSeen !== firstSeen);
  assert.equal(historyReads, 0, 'Repeated idle polls must not load history');
  assert.ok(Date.parse(service.store.operation(`opencode-bridge:${configured.bindingId}`).lastSeen) - Date.parse(firstSeen) >= 2900,
    'Idle heartbeat must not spin at the active-work cadence');
  await armBridge(service.store, join(root, 'relay'), api, { bindingId: configured.bindingId });
  run = service.store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  await call({ socketPath: service.socketPath, token: service.token }, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-backend', runId: 'backend' });
  await until(() => service.store.run(run.id).nativeState === 'settled');
  assert.equal(sends, 1);
  assert.equal(service.store.run(run.id).settlement.outcome, 'completed');
  assert.equal(service.store.run(run.id).native.messageId, 'assistant');
});

test('configDirectory discovers enrolments after startup, follows the exact live chat and stops polling on disposal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-discovery-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const configDirectory = join(directory, 'bridges'); mkdirSync(configDirectory, { recursive: true });
  const inventoryFile = join(root, 'herdr.json');
  const countFile = join(root, 'calls'); writeFileSync(countFile, '');
  const pane = { agent: 'opencode', agent_session: { value: 'first', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(countFile)}, 'call\\n');\nconsole.log(fs.readFileSync(${JSON.stringify(inventoryFile)}, 'utf8'));\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let hooks, service;
  t.after(async () => {
    await hooks?.dispose(); await service?.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  const sdkCalls = [], prompts = [];
  const client = { session: {
    get: async ({ path, query }) => {
      sdkCalls.push({ method: 'get', id: path.id, directory: query.directory });
      return { data: { id: path.id, directory: '/work', time: { created: path.id === 'first' ? 123 : 456 } } };
    },
    status: async () => { sdkCalls.push({ method: 'status' }); return { data: {} }; },
    messages: async ({ path }) => { sdkCalls.push({ method: 'messages', id: path.id }); return { data: [] }; },
    promptAsync: async request => { prompts.push(request); },
  } };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory });
  const tools = hooks.tool;
  assert.deepEqual(Object.keys(tools).sort(), ['relay_agents', 'relay_answer', 'relay_delegate', 'relay_delegations', 'relay_questions', 'relay_review', 'relay_reviews']);
  await hooks.config();
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.execute, 'function');
    await assert.rejects(tool.execute({}, { sessionID: 'first' }), /not enrolled for this chat yet/);
  }
  assert.equal(readFileSync(countFile, 'utf8'), 'call\n', 'Empty-directory discovery has completed before enrolment');
  assert.deepEqual(sdkCalls, [], 'An empty directory must not inspect a native session');

  const configured = [];
  for (const conversationId of ['first', 'second']) {
    const observedId = `herdr-agent:${conversationId}`;
    service.store.saveOperation({ id: observedId, runId: '', marker: conversationId, agentId: conversationId, availability: 'present',
      identity: { harness: 'opencode', sessionKind: 'id', conversationId, machineId: 'machine', session: 'default', companyId: 'company' },
      placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: conversationId } } });
    const api = async () => ({ id: conversationId, companyId: 'company', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: conversationId } });
    const config = await configureBridge(service.store, directory, api, { observedId, reserved: true });
    configured.push(config);
    // Each chat also has a historical config for another terminal in the same directory.
    writeFileSync(join(configDirectory, `historical-${conversationId}.json`), JSON.stringify({
      ...JSON.parse(readFileSync(config.bridgeConfigFile, 'utf8')), terminalId: 'old-terminal',
    }));
  }
  const bridge = index => service.store.operation(`opencode-bridge:${configured[index].bindingId}`);
  const until = async (predicate, message) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
    assert.fail(message);
  };
  await until(() => bridge(0).ready, 'Config added after startup was not discovered');
  assert.equal(bridge(0).sessionCreatedAt, 123);
  assert.equal(bridge(1).lastSeen, undefined, 'The other chat must not report readiness on the same terminal');
  assert.deepEqual(sdkCalls.filter(call => call.method === 'get'), [{ method: 'get', id: 'first', directory: '/work' }]);
  assert.deepEqual(prompts, []);

  pane.agent_session.value = 'second';
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  // Neither plugin() nor config() is called again when the native chat changes.
  await until(() => bridge(1).ready, 'Fresh chat did not select its config without a plugin restart');
  assert.equal(bridge(1).sessionCreatedAt, 456);
  assert.deepEqual(sdkCalls.filter(call => call.method === 'get').at(-1), { method: 'get', id: 'second', directory: '/work' });
  assert.equal(hooks.tool, tools, 'Tools remain registered across enrolment and chat changes');
  const firstSeen = bridge(0).lastSeen;
  const secondSeen = bridge(1).lastSeen;
  const switchedAt = sdkCalls.length;
  await until(() => bridge(1).lastSeen !== secondSeen, 'The newly selected chat did not continue polling');
  assert.equal(bridge(0).lastSeen, firstSeen, 'The old chat must stop reporting readiness');
  assert.deepEqual(sdkCalls.slice(switchedAt).filter(call => call.method === 'get'), [{ method: 'get', id: 'second', directory: '/work' }]);
  assert.equal(sdkCalls.some(call => call.method === 'messages'), false, 'Idle discovery must not load conversation history');

  await hooks.dispose();
  const stoppedCalls = readFileSync(countFile, 'utf8');
  const stoppedSdkCalls = structuredClone(sdkCalls);
  const stoppedSeen = configured.map((_, index) => bridge(index).lastSeen);
  await delay(5500);
  assert.equal(readFileSync(countFile, 'utf8'), stoppedCalls, 'Disposal stops both discovery and native placement polling');
  assert.deepEqual(sdkCalls, stoppedSdkCalls, 'Disposal stops SDK polling');
  assert.deepEqual(configured.map((_, index) => bridge(index).lastSeen), stoppedSeen, 'Disposal stops Relay heartbeats');
  assert.deepEqual(prompts, [], 'Enrolment and switching idle chats must not send prompts');
});

test('configDirectory preserves an in-flight invocation and its epoch through a missing Herdr inventory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-inventory-gap-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const inventoryFile = join(root, 'herdr.json');
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(require('node:fs').readFileSync(${JSON.stringify(inventoryFile)}, 'utf8'));\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let hooks, service, run, busy = false, sdkCalls = 0;
  t.after(async () => {
    await hooks?.dispose(); await service?.close();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100' });
  service.store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'worker' } } });
  const backend = { id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } };
  const api = async (method, path, body) => { if (method === 'PATCH') Object.assign(backend, body); return structuredClone(backend); };
  const configured = await configureBridge(service.store, directory, api, { observedId: 'herdr-agent:test', reserved: true });
  const bridge = () => service.store.operation(`opencode-bridge:${configured.bindingId}`);
  const messages = [], prompts = [];
  const client = { session: {
    get: async () => { sdkCalls++; return { data: { id: 'conversation', directory: '/work', time: { created: 123 },
      agent: 'build', model: { providerID: 'litellm', id: 'fixture-model' } } }; },
    messages: async () => { sdkCalls++; return { data: structuredClone(messages) }; },
    status: async () => { sdkCalls++; return { data: busy ? { conversation: { type: 'busy' } } : {} }; },
    promptAsync: async ({ body }) => {
      prompts.push(body);
      busy = true;
      messages.push({ info: { id: body.messageID, sessionID: 'conversation', role: 'user' }, parts: body.parts });
      await hooks['chat.message']({ sessionID: 'conversation', messageID: body.messageID }, { message: { id: body.messageID } });
      service.store.acknowledge(run.id);
    },
  } };
  const until = async (predicate, message) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
    assert.fail(message);
  };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory: join(directory, 'bridges') });
  await hooks.config();
  await until(() => bridge().ready, 'Dynamic bridge did not report readiness');
  const epoch = bridge().epoch;
  assert.ok(epoch);
  await armBridge(service.store, directory, api, { bindingId: configured.bindingId });
  run = service.store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  await call({ socketPath: service.socketPath, token: service.token }, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-backend', runId: 'backend' });
  await until(() => service.store.run(run.id).native?.state === 'observed', 'Invocation was not delivered and observed');
  const invocation = service.store.run(run.id).invocation;
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].messageID, invocation.messageId);
  assert.equal(service.store.run(run.id).nativeState, 'claimed');

  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [] } }));
  const callsBeforeGap = sdkCalls, seenBeforeGap = bridge().lastSeen;
  // Cover the five-second discovery cycle as well as the active invocation's retry.
  await delay(5500);
  await assert.rejects(hooks.tool.relay_questions.execute({}, { sessionID: 'conversation' }), /Bridge placement changed/);
  assert.equal(sdkCalls, callsBeforeGap, 'Missing placement must block native snapshots');
  assert.equal(bridge().lastSeen, seenBeforeGap, 'Missing placement must block Relay heartbeats');
  assert.equal(bridge().epoch, epoch);
  assert.deepEqual(service.store.run(run.id).invocation, invocation);
  assert.equal(service.store.run(run.id).nativeState, 'claimed', 'Inventory loss must not settle pending work');
  assert.equal(prompts.length, 1, 'Inventory loss must not resend the prompt');

  service.store.submit(run.id, { key: 'result', candidate: 'candidate', summary: 'Fixture answer' });
  messages.push({ info: { id: 'assistant', sessionID: 'conversation', role: 'assistant', parentID: invocation.messageId,
    finish: 'stop', time: { created: 124, completed: 125 } }, parts: [] });
  busy = false;
  service.store.saveOperation(service.store.operation('herdr-agent:test'));
  writeFileSync(inventoryFile, JSON.stringify({ result: { agents: [pane] } }));
  await until(() => service.store.run(run.id).nativeState === 'settled', 'Restored placement did not settle the original invocation');
  const settledSeen = bridge().lastSeen;
  await until(() => bridge().lastSeen !== settledSeen, 'Bridge did not continue polling after settlement');
  assert.equal(bridge().epoch, epoch, 'Restoring the same placement must retain the plugin epoch');
  assert.deepEqual(service.store.run(run.id).invocation, invocation);
  assert.equal(service.store.run(run.id).settlement.outcome, 'completed');
  assert.equal(service.store.run(run.id).native.messageId, 'assistant');
  assert.equal(prompts.length, 1, 'Restoration and later polls must not duplicate delivery');
  const events = service.store.db.prepare('SELECT kind FROM events WHERE run_id = ?').all(run.id);
  assert.equal(events.filter(event => event.kind === 'native.delivery_intent').length, 1);
  assert.equal(events.filter(event => event.kind === 'native.settled').length, 1, 'The original invocation settles exactly once');
});

test('stale placement backs off discovery and disposal prevents further retries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-backoff-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const countFile = join(root, 'calls');
  const configFile = join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ directory: '/work', conversationId: 'original', terminalId: 'original' }));
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(countFile)}, 'call\\n');\nconsole.log('{"result":{"agents":[]}}');\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let hooks;
  t.after(async () => {
    await hooks?.dispose();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  let sdkCalls = 0;
  const unexpected = async () => { sdkCalls++; throw new Error('Must not inspect a replaced conversation'); };
  hooks = await plugin({ directory: '/work', client: { session: { get: unexpected, messages: unexpected, status: unexpected } } }, { configFile });
  await hooks.config();
  const calls = () => readFileSync(countFile, 'utf8').trim().split('\n').length;
  for (let i = 0; i < 100 && calls() < 2; i++) await delay(20);
  assert.equal(calls(), 2, 'One startup discovery and one initial tick');
  await delay(1200);
  assert.equal(calls(), 2, 'First failure waits two seconds before retry');
  for (let i = 0; i < 100 && calls() < 3; i++) await delay(20);
  assert.equal(calls(), 3);
  await delay(1200);
  assert.equal(calls(), 3, 'Second failure waits four seconds before retry');
  assert.equal(sdkCalls, 0);
  await hooks.dispose();
  const stoppedAt = calls();
  await delay(3200);
  assert.equal(calls(), stoppedAt, 'No background retry after dispose');
});

test('discovery delegates verified native user requests and announces UI-only completions without retrying uncertain toasts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-delegation-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const directory = join(root, 'relay');
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' },
    terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  const requests = [];
  const backend = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/companies/company') res.end(JSON.stringify({ id: 'company' }));
    else if (req.method === 'GET' && req.url === '/api/agents/worker') res.end(JSON.stringify({ id: 'worker', companyId: 'company' }));
    else if (req.method === 'POST' && req.url === '/api/companies/company/issues') {
      res.end(JSON.stringify({ ...body, id: 'task', identifier: 'TEST-1', companyId: 'company' }));
    } else { res.statusCode = 404; res.end(JSON.stringify({ message: 'Unexpected backend request' })); }
  });
  let hooks, service;
  t.after(async () => {
    await hooks?.dispose(); await service?.close(); await new Promise(resolve => backend.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}', { mode: 0o600 });
  service = await startService({ directory, paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  const store = service.store, configured = {};
  for (const [agentId, conversationId, terminalId, workdir] of [
    ['origin', 'conversation', 'terminal', '/work'], ['worker', 'worker-conversation', 'worker-terminal', '/worker'],
  ]) {
    const observedId = `herdr-agent:${agentId}`;
    store.saveOperation({ id: observedId, runId: '', marker: agentId, agentId, availability: 'present',
      identity: { harness: 'opencode', sessionKind: 'id', conversationId, machineId: 'machine', session: 'default', companyId: 'company' },
      placement: { directory: workdir, terminalId }, observation: { display: { name: agentId } } });
    const api = async () => ({ id: agentId, companyId: 'company', adapterType: 'herdr_relay',
      adapterConfig: { observationOnly: true, relayObservationMarker: agentId } });
    configured[agentId] = await configureBridge(store, directory, api, { observedId, reserved: true });
    const bridgeId = `opencode-bridge:${configured[agentId].bindingId}`;
    store.saveOperation({ ...store.operation(bridgeId), state: 'armed', lastSeen: new Date().toISOString(),
      ...(agentId === 'worker' ? { ready: true, epoch: 'worker-epoch', sessionCreatedAt: 456 } : {}) });
  }
  const bridge = () => store.operation(`opencode-bridge:${configured.origin.bindingId}`);
  const notifications = () => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'completion-notification:%' ORDER BY rowid").all()
    .map(row => JSON.parse(row.data));
  const until = async (predicate, message) => {
    // The fixture has no Herdr observer. Refresh its unchanged placement before waiting for native polls.
    for (const id of ['origin', 'worker']) store.saveOperation(store.operation(`herdr-agent:${id}`));
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
    assert.fail(message);
  };
  const sourceText = 'Ask the worker to check this change.';
  const source = { info: { id: 'human', role: 'user', sessionID: 'conversation', time: { created: Date.now() } }, parts: [
    { type: 'text', text: sourceText }, { type: 'text', text: 'Not human authority', synthetic: true },
    { type: 'text', text: 'Ignored text', ignored: true },
  ] };
  const messages = [source, { info: { id: 'tool-turn', role: 'assistant', sessionID: 'conversation', parentID: 'human' }, parts: [] }];
  const prompts = [], normalPrompts = [], toasts = [], deliveryIntents = [];
  const nativeSession = { id: 'conversation', directory: '/work', time: { created: 123 },
    agent: 'build', model: { providerID: 'litellm', id: 'fixture-model', variant: 'fixture-variant' } };
  let busy = true, historyReads = 0;
  const client = { session: {
    get: async () => ({ data: nativeSession }),
    messages: async () => { historyReads++; return { data: structuredClone(messages) }; },
    status: async () => ({ data: busy ? { conversation: { type: 'busy' } } : {} }),
    promptAsync: async request => { normalPrompts.push(request); },
    prompt: async request => { prompts.push(request); },
  }, tui: {
    showToast: async request => {
      toasts.push(request);
      deliveryIntents.push(notifications());
      if (toasts.length === 1) throw new Error('Response lost after TUI accepted the toast');
      return { data: true };
    },
  } };
  hooks = await plugin({ client, directory: '/work' }, { configDirectory: join(directory, 'bridges') });
  await hooks.config();
  await until(() => bridge().epoch, 'Discovery did not load the origin bridge');
  const approvals = [];
  const context = { sessionID: 'conversation', messageID: 'tool-turn', ask: async permission => { approvals.push(permission); } };
  const tools = hooks.tool;
  const args = { key: 'check-once', targetBindingId: configured.worker.bindingId,
    title: 'Check the change', description: 'Run checks and report the result.' };
  assert.deepEqual(JSON.parse(await tools.relay_agents.execute({}, context)), { agents: [
    { bindingId: configured.worker.bindingId, agentId: 'worker', label: 'worker', directory: '/worker' },
  ] });
  assert.deepEqual(JSON.parse(await tools.relay_delegations.execute({}, context)), { delegations: [], notifications: [] });
  for (const name of ['relay_agents', 'relay_delegate', 'relay_delegations']) {
    await assert.rejects(tools[name].execute(args, { ...context, sessionID: 'foreign' }), /enrolled conversation/);
  }
  await assert.rejects(tools.relay_delegate.execute(args, { ...context, messageID: 'missing' }), /user message could not be verified/);
  messages[1].info.parentID = 'old-human';
  await assert.rejects(tools.relay_delegate.execute(args, context), /user message could not be verified/);
  messages[1].info.parentID = 'human';
  for (const flag of ['synthetic', 'ignored']) {
    source.parts[0][flag] = true;
    await assert.rejects(tools.relay_delegate.execute(args, context), /user message could not be verified/);
    delete source.parts[0][flag];
  }
  assert.deepEqual(approvals, [], 'Unverified source text must not reach the permission prompt');
  await assert.rejects(tools.relay_delegate.execute(args, { ...context, ask: async () => { throw new Error('Permission denied'); } }), /Permission denied/);
  for (const change of ['text', 'id']) {
    await assert.rejects(tools.relay_delegate.execute(args, { ...context, ask: async () => {
      if (change === 'text') source.parts[0].text = 'Changed request';
      else source.info.id = 'new-human';
    } }), /User message changed; no delegation sent/);
    source.parts[0].text = sourceText; source.info.id = 'human';
  }
  assert.deepEqual(requests, [], 'Denied, stale or synthetic source requests must not reach the backend');

  const delegated = JSON.parse(await tools.relay_delegate.execute(args, context));
  assert.deepEqual(approvals, [{ permission: 'relay_delegate', patterns: [args.targetBindingId], always: [],
    metadata: { ...args, sourceMessageId: 'human', sourceText } }]);
  assert.equal(delegated.state, 'recorded');
  assert.deepEqual(delegated.receipt, { id: 'task', identifier: 'TEST-1', title: args.title,
    status: 'todo', companyId: 'company', assigneeAgentId: 'worker' });
  const operation = store.operation(delegated.id);
  assert.deepEqual(operation.request.origin, { bindingId: configured.origin.bindingId, conversationId: 'conversation',
    sessionCreatedAt: 123, sourceMessageId: 'human', sourceDigest: digest(sourceText) });
  assert.equal(operation.request.relayReviewPolicy, 'human');
  assert.deepEqual(requests, [
    { method: 'GET', path: '/api/companies/company', body: undefined },
    { method: 'GET', path: '/api/agents/worker', body: undefined },
    { method: 'POST', path: '/api/companies/company/issues', body: operation.request.body },
  ]);
  assert.equal(operation.request.body.origin, undefined, 'Origin is retained by Relay, not sent to the backend');
  assert.deepEqual(JSON.parse(await tools.relay_delegate.execute(args, context)), delegated);
  assert.equal(requests.length, 3, 'Retrying the same source and key must not create another task');
  assert.deepEqual(JSON.parse(await tools.relay_delegations.execute({}, context)), { delegations: [delegated], notifications: [] });
  const historyBeforeNotifications = structuredClone(messages);
  const sessionBeforeNotifications = structuredClone(nativeSession);
  const readsBeforeNotifications = historyReads;

  // Seed the completed worker result and exact backend completion receipt, not a notification.
  const binding = store.binding(configured.worker.bindingId);
  const run = store.dispatch({ bindingId: binding.id, bindingRevision: binding.revision, companyId: 'company',
    agentId: 'worker', taskId: 'task', runId: 'backend-worker' });
  store.acknowledge(run.id);
  store.submit(run.id, { key: 'result', candidate: 'revision', summary: 'Checks passed' });
  store.publication(run.id, { state: 'recorded' });
  store.settle(run.id, { outcome: 'completed', evidence: 'Fixture worker finished' });
  store.saveOperation({ id: `completion:${run.id}`, runId: run.id, state: 'recorded', status: 'done', candidate: 'revision' });
  await until(() => notifications().length === 1, 'Service lifecycle did not create a completion notification');
  const notification = notifications()[0];
  assert.equal(notification.state, 'pending');
  assert.deepEqual(notification.origin, { bindingId: configured.origin.bindingId, conversationId: 'conversation', sessionCreatedAt: 123 });
  const nextRun = store.dispatch({ ...run.request, runId: 'backend-worker-next' });
  store.acknowledge(nextRun.id);
  store.submit(nextRun.id, { key: 'next-result', candidate: 'next-revision', summary: 'Follow-up checks passed' });
  store.publication(nextRun.id, { state: 'recorded' });
  store.settle(nextRun.id, { outcome: 'completed', evidence: 'Fixture follow-up finished' });
  store.saveOperation({ id: `completion:${nextRun.id}`, runId: nextRun.id, state: 'recorded', status: 'done', candidate: 'next-revision' });
  await until(() => notifications().length === 2, 'Service lifecycle did not create the next completion notification');
  const nextNotification = notifications()[1];
  for (let i = 0; i < 2; i++) {
    const seen = bridge().lastSeen;
    await until(() => bridge().lastSeen !== seen, 'Busy origin stopped polling');
    assert.deepEqual(notifications().map(item => item.state), ['pending', 'pending'], 'Busy native turns must defer notification delivery');
    assert.equal(toasts.length, 0);
  }
  busy = false;
  await until(() => toasts.length === 1, 'Idle origin did not receive its completion toast');
  assert.equal(deliveryIntents[0].length, 2);
  assert.equal(deliveryIntents[0][0].state, 'uncertain', 'Delivery intent must be durable before sending');
  assert.equal(deliveryIntents[0][1].state, 'pending');
  assert.equal(store.operation(notification.id).state, 'uncertain', 'A lost toast response must remain uncertain, not reconcile through history');
  const uncertain = store.operation(notification.id);
  assert.deepEqual(JSON.parse(notification.text.split('\n').slice(1).join('\n')),
    { status: 'done', identifier: 'TEST-1', title: args.title, summary: 'Checks passed' });
  await until(() => store.operation(nextNotification.id).state === 'announced', 'An uncertain toast must not starve the next pending notification');
  assert.equal(toasts.length, 2);
  assert.deepEqual(deliveryIntents[1].map(item => item.state), ['uncertain', 'uncertain']);
  for (const [index, item] of [notification, nextNotification].entries()) {
    assert.deepEqual(toasts[index].query, { directory: '/work' });
    assert.equal(toasts[index].path, undefined, 'TUI toasts must not target the session prompt endpoint');
    assert.equal(toasts[index].throwOnError, true);
    assert.ok(toasts[index].signal instanceof AbortSignal);
    assert.deepEqual(toasts[index].body, { title: 'TEST-1 completed',
      message: `${args.title}\n${item.summary}\nFull result: relay_delegations`, variant: 'success', duration: 15000 });
  }
  const announced = store.operation(nextNotification.id);
  for (let i = 0; i < 2; i++) {
    const seen = bridge().lastSeen;
    await until(() => bridge().lastSeen !== seen, 'Origin stopped polling after delivery');
  }
  assert.deepEqual(notifications(), [uncertain, announced], 'Repeated lifecycle and native polls must neither recreate nor rewrite notification state');
  assert.equal(toasts.length, 2, 'Neither an uncertain nor an announced toast may be retried');
  assert.equal(historyReads, readsBeforeNotifications, 'UI-only notifications must never load native history');
  await assert.rejects(tools.relay_delegate.execute({ ...args, key: 'notification-is-not-authority' },
    { ...context, messageID: notification.messageId }), /user message could not be verified/);
  assert.equal(approvals.length, 2, 'A UI-only completion must not request delegation permission');
  const readsBeforeStatus = historyReads;
  const status = JSON.parse(await tools.relay_delegations.execute({}, context));
  assert.equal(historyReads, readsBeforeStatus, 'Notification history must come from Relay, not native messages');
  assert.deepEqual(status.notifications, [announced, uncertain], 'Delegation status must retain both announced and uncertain notification history');
  assert.equal(status.delegations.length, 1);
  assert.deepEqual(status.delegations[0].runs.find(item => item.id === run.id), { id: run.id, deliveryState: 'acknowledged', nativeState: 'settled',
    outcome: 'completed', publicationState: 'recorded', reviewStatus: null, candidate: 'revision', summary: 'Checks passed' });
  assert.deepEqual(status.delegations[0].runs.find(item => item.id === nextRun.id), { id: nextRun.id, deliveryState: 'acknowledged', nativeState: 'settled',
    outcome: 'completed', publicationState: 'recorded', reviewStatus: null, candidate: 'next-revision', summary: 'Follow-up checks passed' });
  assert.equal(status.delegations[0].runs.length, 2);
  await hooks.dispose();
  assert.deepEqual(prompts, [], 'UI-only completion must never call the native prompt endpoint, even with noReply');
  assert.deepEqual(normalPrompts, [], 'UI-only completion must never start a promptAsync model turn');
  assert.deepEqual(messages, historyBeforeNotifications, 'Completion toasts must not alter native conversation history');
  assert.deepEqual(nativeSession, sessionBeforeNotifications, 'Completion toasts must not alter the native model, variant or agent');
  assert.equal(requests.length, 3, 'Status reads and notifications must not create more backend work');
});

test('answer tool reads the current native message, asks permission and resolves only its exact waiting question', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-plugin-answer-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const prior = { PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  const pane = { agent: 'opencode', agent_session: { value: 'conversation', kind: 'id' }, terminal_id: 'terminal', pane_id: 'pane', cwd: '/work' };
  writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ result: { agents: [pane] } }))});\n`, { mode: 0o700 });
  Object.assign(process.env, { PATH: `${bin}:${prior.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'pane' });
  let question, posts = 0;
  const backend = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { posts++; question.status = req.url.endsWith('/accept') ? 'accepted' : 'answered'; question.result = JSON.parse(body); }
    res.end(JSON.stringify(req.url.endsWith('/interactions') ? [question] : req.method === 'POST' ? question :
      { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress' }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const auth = join(root, 'backend.json'); writeFileSync(auth, '{"localTrusted":true}');
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: `http://127.0.0.1:${backend.address().port}`, backendContextFile: auth });
  let hooks;
  t.after(async () => {
    await hooks?.dispose(); await service.close(); await new Promise(resolve => backend.close(resolve));
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const store = service.store;
  store.saveOperation({ id: 'herdr-agent:test', runId: '', marker: 'marker', agentId: 'agent', availability: 'present',
    identity: { harness: 'opencode', sessionKind: 'id', conversationId: 'conversation', machineId: 'machine', session: 'default', companyId: 'company' },
    placement: { directory: '/work', terminalId: 'terminal' }, observation: { display: { name: 'worker' } } });
  const api = async () => ({ id: 'agent', companyId: 'company', adapterType: 'herdr_relay', adapterConfig: { observationOnly: true, relayObservationMarker: 'marker' } });
  const configured = await configureBridge(store, join(root, 'relay'), api, { observedId: 'herdr-agent:test', reserved: true });
  const bridgeId = `opencode-bridge:${configured.bindingId}`;
  store.saveOperation({ ...store.operation(bridgeId), state: 'armed', lastSeen: new Date().toISOString() });
  const run = store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  store.acknowledge(run.id); store.ask(run.id, { key: 'city', question: 'Which city?' });
  store.questionReceipt(run.id, { state: 'recorded', interactionId: 'question' });
  store.settle(run.id, { outcome: 'waiting', evidence: 'Fixture waiting' });
  question = { id: 'question', ...store.run(run.id).waiting.request, status: 'pending' };
  const messages = [
    { info: { id: 'human', role: 'user', sessionID: 'conversation', time: { created: Date.now() + 1 } }, parts: [{ type: 'text', text: 'What if I answer here?' }] },
    { info: { id: 'tool-turn', role: 'assistant', sessionID: 'conversation', parentID: 'human' }, parts: [] },
  ];
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 } } }),
    messages: async () => ({ data: structuredClone(messages) }), status: async () => ({ data: { conversation: { type: 'busy' } } }),
  } };
  hooks = await plugin({ client, directory: '/work' }, { configFile: configured.bridgeConfigFile });
  const approvals = [];
  const context = { sessionID: 'conversation', messageID: 'tool-turn', ask: async permission => { approvals.push(permission); } };
  assert.equal(JSON.parse(await hooks.tool.relay_questions.execute({}, context)).questions.length, 1);
  const denied = { ...context, ask: async () => { throw new Error('Permission denied'); } };
  await assert.rejects(hooks.tool.relay_answer.execute({ answer: 'Johannesburg' }, denied), /Permission denied/);
  assert.equal(posts, 0); assert.equal(approvals.length, 0);
  messages[0].parts[0].text = 'Use Johannesburg please';
  assert.equal(JSON.parse(await hooks.tool.relay_answer.execute({ answer: 'Johannesburg' }, context)).answered, true);
  assert.equal(approvals[0].permission, 'relay_answer');
  assert.equal(approvals[0].metadata.answer, 'Johannesburg');
  assert.equal(posts, 1);
  await assert.rejects(hooks.tool.relay_answer.execute({ answer: 'Johannesburg' }, context), /No unique pending item/);
  assert.equal(posts, 1);
  await assert.rejects(hooks.tool.relay_answer.execute({}, { ...context, sessionID: 'foreign' }));
  const completed = store.dispatch({ ...run.request, runId: 'continuation' });
  store.acknowledge(completed.id);
  store.submit(completed.id, { key: 'one', candidate: 'candidate', summary: 'Johannesburg result' });
  store.publication(completed.id, { state: 'recorded' });
  store.settle(completed.id, { outcome: 'completed', evidence: 'Fixture terminal' });
  store.recordReview(completed.id, { interactionId: 'review', status: 'pending', candidate: 'candidate' });
  question = { id: 'review', kind: 'request_confirmation', status: 'pending', createdAt: new Date().toISOString(),
    idempotencyKey: `relay-review:${completed.id}:${digest(store.run(completed.id).result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: completed.id } } };
  messages[0].info.id = 'approval'; messages[0].info.time.created = Date.now() + 1;
  messages[0].parts[0].text = 'accpeted'; messages[1].info.parentID = 'approval';
  assert.equal(JSON.parse(await hooks.tool.relay_reviews.execute({}, context)).reviews.length, 1);
  await assert.rejects(hooks.tool.relay_review.execute({ decision: 'accept' }, denied), /Permission denied/);
  assert.equal(posts, 1);
  assert.equal(JSON.parse(await hooks.tool.relay_review.execute({ decision: 'accept' }, context)).status, 'accepted');
  assert.equal(approvals.at(-1).permission, 'relay_review');
  assert.equal(approvals.at(-1).metadata.candidate, 'candidate');
  assert.equal(approvals.at(-1).metadata.sourceText, 'accpeted');
  assert.equal(posts, 2);
});
