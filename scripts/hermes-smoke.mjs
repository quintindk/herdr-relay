// Opt-in real-model smoke against an already isolated Hermes gateway. Creates a
// fresh conversation with seed context, then drives the actual Relay adapter.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hermes } from '../src/hermes.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { execute } from '../src/adapter.mjs';

const workspace = process.env.HERMES_SMOKE_WORKSPACE ?? '/tmp/opencode/retinue-native/hermes';
const config = { url: process.env.HERMES_SMOKE_URL ?? 'ws://127.0.0.1:17402/api/ws',
  authFile: process.env.HERMES_SMOKE_TOKEN_FILE ?? join(workspace, 'gateway-token'),
  directory: workspace, runtimeId: 'pending', epoch: 'pending', exclusive: true };
const root = mkdtempSync(join(workspace, 'relay-smoke-'));
let service;
let native;
const deadline = new AbortController();
const cancel = new AbortController();
try {
  native = new Hermes({ hermes: config, conversationId: 'pending' });
  const word = `continuity-${randomUUID()}`;
  const session = await native.request('session.create', { cwd: workspace, title: 'Relay Hermes native smoke',
    model: 'gpt-6-astra', provider: 'copilot', messages: [{ role: 'user', content: `Remember this exact continuity word: ${word}` }] });
  config.runtimeId = session.session_id;
  native.sessionId = session.stored_session_id;
  config.epoch = (await native.request('session.events.since', { last_seen: 0 })).epoch;
  const comments = [];
  service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://paperclip.test',
    api: async (run, token, method, path, body) => {
      if (!path.endsWith('/comments')) return { companyId: 'company', title: 'Recall context and submit',
        description: `Write the exact continuity word from earlier context to ${join(root, 'result.md')}. Submit using the supplied Relay CLI with candidate fixture:hermes-smoke. Reply REPORTED. Do not delegate.` };
      if (method === 'GET') return comments;
      const comment = { id: randomUUID(), ...body, authorAgentId: run.request.agentId, createdByRunId: run.request.runId };
      comments.push(comment);
      return comment;
    } });
  const operator = { socketPath: service.socketPath, token: service.token };
  const contextFile = join(root, 'operator.json');
  writeFileSync(contextFile, JSON.stringify(operator), { mode: 0o600 });
  await call(operator, 'POST', '/bindings', { id: 'hermes-smoke', companyId: 'company', agentId: 'agent',
    harness: 'hermes', instanceId: config.epoch, conversationId: session.stored_session_id, delivery: 'hermes', hermes: config });
  const adapter = execute({ agent: { id: 'agent', companyId: 'company' }, runId: 'backend', authToken: 'fixture-token',
    config: { bindingId: 'hermes-smoke', relayContextFile: contextFile, timeoutSec: 180 }, context: { taskId: 'task' },
    signal: cancel.signal, onLog: async () => {} });
  const result = await Promise.race([adapter, delay(190000, undefined, { signal: deadline.signal }).then(() => { throw new Error('Hermes smoke deadline'); })]);
  deadline.abort();
  assert.equal(result.exitCode, 0);
  const run = service.store.runs()[0];
  assert.ok(run.result.summary.includes(word));
  assert.equal(comments.length, 1);
  assert.equal((await native.snapshot()).session.session_id, session.session_id);
  console.log(JSON.stringify({ hermesVersion: '0.21.5+2164.gfdec926', backend: 'deterministic fixture',
    realModel: 'copilot/gpt-6-astra', existingContextRecalled: true, comments: 1,
    conversationPreserved: true, native: run.native, settlement: run.settlement }, null, 2));
} catch (error) {
  if (native) {
    try {
      const snapshot = await native.snapshot();
      console.error(JSON.stringify({ idle: snapshot.idle,
        rows: snapshot.session.messages.map(message => ({ role: message.role, rowId: message.row_id })),
        terminalCount: snapshot.events.events.filter(event => event.type === 'message.complete').length }));
    } catch {}
  }
  console.error(JSON.stringify({ error: error.message, run: service?.store.runs().map(({ native, deliveryState }) => ({ native, deliveryState })) }));
  await service?.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
} finally {
  deadline.abort();
  cancel.abort();
  await service?.close();
  rmSync(root, { recursive: true, force: true });
}
