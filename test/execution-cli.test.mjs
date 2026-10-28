import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { runRelayCli } from '../packages/opencode-relay/cli-bridge.mjs';

test('the same native CLI comments through exact worker execution scope without a human operator credential', async t => {
  const root = mkdtempSync('/tmp/opencode/execution-cli-'), store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
  command(owner, 'node', 'node.enrol', { id: 'node', name: 'Node' });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  command(node, 'agent', 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'interactive' });
  for (const id of ['task', 'other']) command(owner, id, 'task.create', { id, title: id });
  command(owner, 'request', 'execution.request', { id: 'execution', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Bounded check' });
  const execution = command(node, 'admit', 'execution.admit', { id: 'execution', expectedRevision: 1, runId: 'run', bindingId: 'binding' });
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: store.instance });
  journal.save({ id: execution.id, execution, state: 'observing', bindingId: 'binding', nativeConversationId: 'ses_worker', invocation: { messageId: 'source' } });
  const worker = { socketPath: join(root, 'node.sock'), token: 'worker-only', sessionId: 'ses_worker', agentId: 'agent', bindingId: 'binding' };
  const workerFile = join(root, 'worker.json'); writeFileSync(workerFile, JSON.stringify(worker), { mode: 0o600 });
  const api = async (method, path, body) => {
    if (method === 'POST') return store.command(node, body);
    if (path === '/v1/info') return { instanceId: store.instance };
    throw Error(`Unexpected read ${path}`);
  };
  const service = await startNodeService({ journal, socketPath: worker.socketPath, workers: [worker], api });
  t.after(async () => { await service.close(); journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const base = { directory: root, sessionId: worker.sessionId, workerContextFile: workerFile,
    executionSource: { id: 'source', executionId: execution.id, runId: execution.runId } };
  const input = { ...base, args: ['native', 'task', 'comment', '--key', 'comment-once', '--file', '{payload}'], payload: { id: 'comment', taskId: 'task', body: 'Actual progress' } };
  const result = await runRelayCli(input); assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).author.type, 'node');
  assert.equal((await runRelayCli(input)).exitCode, 0); assert.equal(store.all('comment').length, 1);
  const foreign = await runRelayCli({ ...input, payload: { ...input.payload, taskId: 'other' } });
  assert.notEqual(foreign.exitCode, 0); assert.match(foreign.stderr, /execution_cli_scope/);
  const stale = await runRelayCli({ ...input, executionSource: { ...base.executionSource, id: 'unrelated-notice' } });
  assert.notEqual(stale.exitCode, 0); assert.match(stale.stderr, /execution_source_required/);
  const admin = await runRelayCli({ ...base, args: ['native', 'command', '--file', '{payload}'], payload: { key: 'escalate', action: 'node.enrol', payload: { id: 'bad', name: 'Bad' } } });
  assert.notEqual(admin.exitCode, 0); assert.match(admin.stderr, /execution_cli_scope/);
  assert.equal(store.all('node').length, 1); assert.equal(journal.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='conflict'").get().n, 0);
});
