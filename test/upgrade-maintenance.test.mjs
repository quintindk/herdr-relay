import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';
import { nodeAgentInstructions } from '../src/node-agent-instructions.mjs';

test('backend maintenance leaves inspection available, rejects mutations and permits the same immutable request afterwards', async t => {
  const root = mkdtempSync('/tmp/opencode/maintenance-'), maintenanceFile = join(root, 'maintenance.json');
  const backend = await startBackend({ database: ':memory:', maintenanceFile });
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const api = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const command = { key: 'after-maintenance', action: 'task.create', payload: { id: 'task', title: 'Preserved request' } };
  writeFileSync(maintenanceFile, '{}');
  assert.equal((await api('GET', '/v1/info')).maintenance, true);
  assert.equal((await api('GET', '/v1/snapshot')).collections.task.length, 0);
  await assert.rejects(api('POST', '/v1/commands', command), { code: 'maintenance' });
  assert.equal(backend.store.all('task').length, 0);
  rmSync(maintenanceFile);
  assert.equal((await api('POST', '/v1/commands', command)).id, 'task');
  assert.equal((await api('POST', '/v1/commands', command)).id, 'task');
  assert.equal(backend.store.all('task').length, 1);
});

test('node maintenance keeps read-only status available and never stages a worker result', async t => {
  const root = mkdtempSync('/tmp/opencode/node-maintenance-'), journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  journal.save({ id: 'execution', state: 'observing', execution: { id: 'execution', state: 'accepted', targetAgentId: 'worker', runId: 'run' } });
  const socketPath = join(root, 'node.sock');
  const service = await startNodeService({ journal, socketPath, workers: [{ agentId: 'worker', token: 'token' }], maintenance: () => true });
  t.after(async () => { await service.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const connection = { socketPath, token: 'token' };
  assert.equal((await call(connection, 'POST', '/agent/status', {})).agentId, 'worker');
  await assert.rejects(call(connection, 'POST', '/work/submit', { executionId: 'execution', runId: 'run', key: 'result', payload: { candidate: 'one', summary: 'Done' } }), { code: 'maintenance' });
  assert.equal(journal.work('execution').staged, undefined);
});

test('tool-enabled agent briefings use native tool names, never nodejs/private CLI commands', () => {
  const tools = nodeAgentInstructions({ directTools: true, cli: '/private/nvm/node /private/node-worker-cli.mjs --context /private/worker.json' });
  assert.match(tools, /relay_questions/); assert.match(tools, /relay_messages/);
  assert.doesNotMatch(tools, /node-worker-cli|--context|private\/|nvm\/|nodejs/);
  assert.match(nodeAgentInstructions({ directTools: false, cli: 'herdr-relay native work --context FILE' }), /herdr-relay native work/);
});
