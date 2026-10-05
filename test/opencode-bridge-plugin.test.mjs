import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { configureBridge, armBridge } from '../src/opencode-bridge.mjs';
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
  let sends = 0, run;
  const messages = [];
  const client = { session: {
    get: async () => ({ data: { id: 'conversation', directory: '/work', time: { created: 123 }, agent: 'build', model: { providerID: 'litellm', id: 'fixture-model' } } }),
    messages: async () => ({ data: structuredClone(messages) }),
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
  hooks = await plugin({ client, directory: '/work' }, { configFile: configured.bridgeConfigFile });
  await hooks.config();
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50); } assert.fail('Bridge did not settle'); };
  await until(() => service.store.operation(`opencode-bridge:${configured.bindingId}`).ready);
  await armBridge(service.store, join(root, 'relay'), api, { bindingId: configured.bindingId });
  run = service.store.dispatch({ bindingId: configured.bindingId, bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'backend' });
  await call({ socketPath: service.socketPath, token: service.token }, 'POST', `/runs/${run.id}/attach`, { token: 'fixture-backend', runId: 'backend' });
  await until(() => service.store.run(run.id).nativeState === 'settled');
  assert.equal(sends, 1);
  assert.equal(service.store.run(run.id).settlement.outcome, 'completed');
  assert.equal(service.store.run(run.id).native.messageId, 'assistant');
});
