import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/local-grant-cli-'), state = join(root, 'node'); mkdirSync(state);
  const backend = await startBackend({ database: ':memory:' }), cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  const owner = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
  const bundleFile = join(root, 'bundle.json'), configFile = join(state, 'node.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'node', name: 'Surface fixture', url: backend.origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile });
  await owner('POST', '/v1/commands', { key: 'coordinator', action: 'agent.enrol', payload: { id: 'coordinator', nodeId: joined.nodeId, name: 'Coordinator', directory: root } });
  await owner('POST', '/v1/commands', { key: 'attach', action: 'agent.attach', payload: { id: 'coordinator', expectedBindingRevision: 0, conversationId: 'ses_coordinator', directory: root, bindingId: 'binding' } });
  const payload = { id: 'grant', requesterAgentId: 'coordinator', nodeId: joined.nodeId, name: 'sweep', directory: root,
    model: { providerID: 'provider', id: 'model', integrationID: 'auth', connectionId: 'existing' }, permissions: { mcp: true, shell: true },
    contract: '.opencode/skills/job/SKILL.md', schedule: { id: 'schedule', cron: '0 7-18 * * 1-5', timezone: 'Africa/Johannesburg', reviewPolicy: 'none' } };
  const file = join(root, 'grant.json'); writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  const cli = async (args, sessionId = '') => JSON.parse((await execute(process.execPath, ['src/cli.mjs', 'headless', ...args, '--config', configFile],
    { env: { ...process.env, OPENCODE_SESSION_ID: sessionId }, timeout: 15000 })).stdout);
  return { root, state, backend, owner, joined, configFile, payload, file, cli, cleanups };
}

test('CLI defaults to the existing local node operator without --context or any owner file', async t => {
  const f = await fixture(t);
  const args = ['grant', '--file', f.file, '--key', 'local-once'];
  const grant = await f.cli(args);
  assert.equal(grant.state, 'active'); assert.equal(grant.issuedBy.type, 'node_operator'); assert.equal(grant.issuedBy.nodeId, f.joined.nodeId);
  assert.deepEqual(await f.cli(args), grant);
  assert.equal(existsSync(join(f.root, 'owner.json')), false); assert.equal(existsSync(join(f.state, 'owner.json')), false);
  const revoke = join(f.root, 'revoke.json'); writeFileSync(revoke, JSON.stringify({ id: 'grant', expectedRevision: 1 }));
  assert.equal((await f.cli(['revoke', '--file', revoke, '--key', 'revoke-once'])).state, 'revoked');
  assert.equal((await f.owner('GET', '/v1/headless_setups')).items.length, 0);
  assert.equal((await f.owner('GET', '/v1/schedules')).items.length, 0);
});

test('enrolled CLI uses the exact agent connector, preserving idempotency and rejecting spoofed scope/headless workers', async t => {
  const f = await fixture(t), config = JSON.parse(readFileSync(f.configFile));
  const journal = new NodeJournal(join(f.state, 'test-node.sqlite'), { nodeId: f.joined.nodeId, instanceId: f.backend.store.instance });
  journal.db.prepare('INSERT INTO settings VALUES (?,?)').run('receiver:coordinator', JSON.stringify({ state: 'active', bindingId: 'binding', generation: 1 }));
  const worker = { agentId: 'coordinator', sessionId: 'ses_coordinator', bindingId: 'binding', bindingRevision: 1, token: 'fixture-worker', socketPath: join(f.state, 'test.sock') };
  const contextFile = join(f.state, 'worker.json'); writeFileSync(contextFile, JSON.stringify(worker));
  writeFileSync(join(f.state, 'worker-index.json'), JSON.stringify({ sessions: { ses_coordinator: contextFile } }));
  let grantsSupported = true;
  const service = await startNodeService({ journal, socketPath: worker.socketPath, workers: [worker], api: nativeBackendClient(config.backend),
    getBackendFeatures: async () => ({ nodeHeadlessGrants: grantsSupported }) });
  f.cleanups.push(async () => { await service.close(); journal.close(); });
  const args = ['grant', '--file', f.file, '--key', 'agent-once'];
  const receipt = await f.cli(args, 'ses_coordinator');
  assert.equal(receipt.state, 'recorded'); assert.equal(receipt.receipt.issuedBy.type, 'agent');
  assert.equal(receipt.receipt.issuedBy.agentId, 'coordinator');
  assert.equal((await f.cli(args, 'ses_coordinator')).receipt.revision, 1);
  assert.equal(f.backend.store.all('headless_grant').length, 1);
  await assert.rejects(call(worker, 'POST', '/agent/headless-grant', { key: 'forged', payload: { ...f.payload, id: 'forged', requesterAgentId: 'another-agent' } }), { code: 'headless_requester_scope' });
  grantsSupported = false;
  await assert.rejects(call(worker, 'POST', '/agent/headless-grant', { key: 'old-backend', payload: { ...f.payload, id: 'old-backend' } }), { code: 'backend_upgrade_required' });
  worker.headlessSetupId = 'setup';
  await assert.rejects(call(worker, 'POST', '/agent/headless-grant', { key: 'worker-escalation', payload: { ...f.payload, id: 'escalation' } }), { code: 'headless_requester_scope' });
  assert.equal(f.backend.store.all('headless_grant').length, 1);
});
