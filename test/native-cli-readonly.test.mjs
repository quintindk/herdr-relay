import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { runRelayCli } from '../packages/opencode-relay/cli-bridge.mjs';
import { call } from '../src/client.mjs';

test('actual native read CLI reconciles without an execution and cannot mutate or reach credential/grant administration', async t => {
  const root = mkdtempSync('/tmp/opencode/native-cli-readonly-'), backend = await startBackend({ database: ':memory:' });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = (key, action, payload) => owner('POST', '/v1/commands', { key, action, payload });
  await command('node', 'node.enrol', { id: 'node', name: 'Node' });
  await command('agent', 'agent.enrol', { id: 'agent', nodeId: 'node', name: 'Agent', directory: root });
  await command('task', 'task.create', { id: 'task', title: 'Human task' });
  const credential = await owner('POST', '/v1/node-credentials', { nodeId: 'node', key: 'credential' });
  const api = owner.withToken(credential.token), journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: backend.store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:agent', JSON.stringify({ state: 'active', bindingId: 'binding', generation: 1 }));
  const worker = { agentId: 'agent', sessionId: 'ses_agent', bindingId: 'binding', bindingRevision: 1, token: 'worker-only', socketPath: join(root, 'node.sock') };
  const workerFile = join(root, 'worker.json'); writeFileSync(workerFile, JSON.stringify(worker), { mode: 0o600 });
  const service = await startNodeService({ journal, socketPath: worker.socketPath, workers: [worker], api });
  t.after(async () => { await service.close(); journal.close(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const base = { directory: root, sessionId: worker.sessionId, workerContextFile: workerFile, agentReadSource: { authority: 'agent_read', id: 'notice' } };
  const missing = await runRelayCli({ ...base, args: ['native', 'execution', 'inspect', 'not-created'] });
  assert.equal(missing.exitCode, 1); assert.match(missing.stderr, /not_found/); assert.equal(missing.effectsUncertain, false);
  assert.equal(missing.authority, 'enrolled_read_only'); assert.equal(missing.operatorContextUsed, false);
  const listed = await runRelayCli({ ...base, args: ['native', 'task', 'list'] });
  assert.equal(listed.exitCode, 0, listed.stderr); assert.equal(JSON.parse(listed.stdout).items[0].id, 'task');
  assert.equal(backend.store.all('execution').length, 0); assert.equal(journal.works().length, 0);
  const request = body => call(worker, 'POST', '/agent/native-api', { request: body });
  await assert.rejects(request({ method: 'POST', path: '/v1/commands', body: { key: 'bad', action: 'task.create', payload: { title: 'Bad' } } }), { code: 'agent_cli_read_only' });
  for (const path of ['/v1/credentials', '/v1/grants/ui-session', '/v1/task_reference_grants', '/v1/snapshot']) {
    await assert.rejects(request({ method: 'GET', path }), { code: 'forbidden' });
  }
  backend.store.save('provision_request', { id: 'foreign', requesterAgentId: 'other', state: 'ready', revision: 1 });
  await assert.rejects(request({ method: 'GET', path: '/v1/provision_requests/foreign' }), { code: 'forbidden' });
  const mutation = { ...base, args: ['native', 'task', 'create', '--key', 'bad', '--file', '{payload}'], payload: { title: 'Bad' } };
  await assert.rejects(runRelayCli(mutation), { code: 'agent_cli_read_only' });
  journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ state: 'active', bindingId: 'replacement', generation: 2 }), 'receiver:agent');
  await assert.rejects(request({ method: 'GET', path: '/v1/tasks' }), { code: 'receiver_replaced' });
  assert.equal(backend.store.all('task').length, 1); assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});
