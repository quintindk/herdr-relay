import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
