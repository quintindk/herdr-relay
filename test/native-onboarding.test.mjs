import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode, revokeNodeBundle } from '../src/native-onboarding.mjs';
import { enrolInteractive, attachInteractive } from '../src/native-enrol.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { inventoryProjection } from '../src/native-admin-cli.mjs';

const execute = promisify(execFile), cli = resolve('src/cli.mjs');
test('backend inventory reports native records and pending contract revisions without migration tooling', () => {
  const snapshot = { instanceId: 'backend', collections: { task: [
    { id: 'native-work', status: 'todo' },
    { id: 'imported', title: 'Edited here', description: 'body', priority: 'high', status: 'todo', source: { provider: 'paperclip',
      metadata: { title: 'Original', description: 'body', priority: 'high', status: 'in_progress' } }, migrationDisposition: { toStatus: 'todo' } },
  ], comment: [{ id: 'native-comment' }, { id: 'source-comment', source: { id: 'pc' } }], execution: [], question: [], schedule: [] } };
  const report = inventoryProjection(snapshot);
  assert.equal(report.counts.task, 2);
  assert.deepEqual(report.outstandingExecutions, []);
  assert.deepEqual(report.headlessSetups, []);
  assert.equal(report.reimportRisk, undefined);
});
async function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/onboarding-');
  const evo = join(root, 'evo'), surface = join(root, 'surface'); mkdirSync(evo); mkdirSync(surface);
  const backendState = join(evo, 'backend'); mkdirSync(backendState);
  const backend = await startBackend({ database: join(backendState, 'backend.sqlite') });
  const owner = { url: backend.origin, userId: 'owner', token: backend.store.bootstrap().token };
  const ownerFile = join(evo, 'owner.json'); writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  const api = nativeBackendClient(owner);
  const env = home => ({ ...process.env, HOME: home, XDG_STATE_HOME: join(home, 'state'), XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'), RELAY_NATIVE_CONTEXT: '', OPENCODE_SESSION_ID: '' });
  const run = async (home, args) => { const result = await execute(process.execPath, [cli, 'native', ...args], { env: env(home), timeout: 20000 }); return JSON.parse(result.stdout); };
  const bundle = async (name, extras = {}) => {
    const output = join(evo, `${name}.bundle.json`);
    const result = await createNodeBundle({ api, output, key: `bootstrap-${name}`, name, url: backend.origin, mode: 'localUser', ...extras });
    return { ...result, data: JSON.parse(readFileSync(output, 'utf8')), file: output };
  };
  t.after(async () => { await backend.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, evo, surface, backendState, backend, owner, ownerFile, api, run, bundle };
}

test('Evo bootstrap and Surface join install distinct scoped credentials without transferring backend-root authority', async t => {
  const f = await fixture(t), evo = await f.bundle('Evo'), surface = await f.bundle('Surface');
  assert.notEqual(evo.nodeId, surface.nodeId);
  assert.equal(f.backend.store.all('node').length, 2);
  assert.equal(JSON.stringify(surface.data).includes(f.owner.token), false);
  assert.equal(JSON.stringify(surface).includes(f.owner.token), false);
  assert.notEqual(surface.data.nodeToken, surface.data.operatorToken);
  const configFile = join(f.surface, 'state/herdr-relay-native/node.json');
  const result = await joinNode({ bundleFile: surface.file, configFile });
  assert.equal(result.rootOwnerCredentialTransferred, false);
  for (const file of [configFile, result.operatorContextFile, surface.file]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await joinNode({ bundleFile: surface.file, configFile })).state, 'existing');
  const operator = JSON.parse(readFileSync(result.operatorContextFile));
  const node = JSON.parse(readFileSync(configFile));
  const opApi = nativeBackendClient(operator), nodeApi = nativeBackendClient(node.backend);
  assert.equal((await opApi('GET', '/v1/identity')).scope.nodeId, surface.nodeId);
  assert.equal((await nodeApi('GET', '/v1/identity')).type, 'node');
  await assert.rejects(opApi('POST', '/v1/node-credentials', { nodeId: surface.nodeId, key: 'elevate' }), { code: 'forbidden' });
  await assert.rejects(opApi('POST', '/v1/node-bootstrap', { key: 'new-node', id: 'new-node', name: 'Other', mode: 'localUser' }), { code: 'forbidden' });
  await assert.rejects(opApi('POST', '/v1/commands', { key: 'new-node', action: 'node.enrol', payload: { id: 'new-node', name: 'Other' } }), { code: 'forbidden' });
  await assert.rejects(opApi('POST', '/v1/commands', { key: 'grant', action: 'interactive.grant', payload: {} }), { code: 'forbidden' });
  await assert.rejects(nodeApi('POST', '/v1/commands', { key: 'raw-enrol', action: 'agent.enrol', payload: { id: 'raw', nodeId: surface.nodeId, name: 'Raw', directory: f.surface } }), { code: 'forbidden' });
});

test('Surface scoped human enrolment/attachment works against an Evo backend and cannot adopt an Evo agent', async t => {
  const f = await fixture(t), surface = await f.bundle('Surface', { mode: 'roots', roots: [f.surface], maxAgents: 1 });
  const configFile = join(f.surface, 'node.json'), joined = await joinNode({ bundleFile: surface.file, configFile });
  const operator = JSON.parse(readFileSync(joined.operatorContextFile));
  const api = nativeBackendClient(operator);
  const session = { id: 'ses_surface', projectID: 'global', location: { directory: f.surface }, time: { created: 1 } };
  const client = { server: { info: async () => ({ version: '2.1.2' }) }, session: { get: async () => session } };
  const dependencies = { discover: async () => ({ url: 'http://127.0.0.1:4096', auth: { type: 'basic', username: 'opencode', password: 'native-secret' } }), makeClient: () => client };
  const input = { configFile, api, backend: { url: f.backend.origin }, directory: f.surface, sessionId: session.id, reserved: true, name: 'Surface chat' };
  const enrolled = await enrolInteractive(input, dependencies);
  assert.equal(enrolled.nodeId, surface.nodeId);
  assert.equal((await enrolInteractive(input, dependencies)).state, 'existing');
  session.id = 'ses_surface_fresh'; session.time.created = 2;
  const attached = await attachInteractive({ ...input, sessionId: session.id, agentId: enrolled.agentId, expectedGeneration: 1, key: 'replacement' }, dependencies);
  assert.equal(attached.generation, 2);
  await assert.rejects(api('POST', '/v1/commands', { key: 'outside', action: 'agent.enrol', payload: { id: 'outside', nodeId: surface.nodeId, name: 'Outside', directory: f.evo } }), { code: 'operator_scope_mismatch' });
  const evo = await f.bundle('Evo');
  await f.api('POST', '/v1/commands', { key: 'evo-agent', action: 'agent.enrol', payload: { id: 'evo-agent', nodeId: evo.nodeId, name: 'Evo', directory: f.evo } });
  await assert.rejects(api('POST', '/v1/commands', { key: 'adopt-evo', action: 'agent.attach', payload: { id: 'evo-agent', expectedBindingRevision: 0, directory: f.evo, conversationId: 'ses_evo', bindingId: 'foreign' } }), { code: 'operator_scope_mismatch' });
});

test('lost bootstrap replies reconcile one node and revocation disables both roles without printing secrets', async t => {
  const f = await fixture(t);
  let lost = false;
  const api = async (...args) => { const result = await f.api(...args); if (args[1] === '/v1/node-bootstrap' && !lost) { lost = true; throw Error('Lost reply'); } return result; };
  const input = { api, output: join(f.evo, 'lost.bundle'), key: 'lost-bootstrap', name: 'Surface', mode: 'localUser', url: f.backend.origin };
  await assert.rejects(createNodeBundle(input), /Lost reply/);
  const result = await createNodeBundle(input);
  assert.equal(f.backend.store.all('node').length, 1);
  const bundle = JSON.parse(readFileSync(input.output));
  assert.equal(JSON.stringify(result).includes(bundle.nodeToken), false); assert.equal(JSON.stringify(result).includes(bundle.operatorToken), false);
  assert.equal((await createNodeBundle(input)).state, 'existing');
  await assert.rejects(createNodeBundle({ ...input, name: 'Changed' }), { code: 'operation_conflict' });
  await revokeNodeBundle({ api: f.api, bundleFile: input.output, key: 'revoke' });
  await assert.rejects(nativeBackendClient({ ...bundle.backend, token: bundle.nodeToken })('GET', '/v1/info'), { code: 'unauthorised' });
  await assert.rejects(nativeBackendClient({ ...bundle.backend, token: bundle.operatorToken })('GET', '/v1/info'), { code: 'unauthorised' });
  await assert.rejects(createNodeBundle(input), { code: 'credential_superseded' });
});

test('join refuses backend resets, root-credential substitution and unrelated local state rather than erasing journals', async t => {
  const f = await fixture(t), bundle = await f.bundle('Surface');
  const configFile = join(f.surface, 'node.json');
  const altered = join(f.root, 'altered.bundle');
  writeFileSync(altered, JSON.stringify({ ...bundle.data, operatorToken: f.owner.token }), { mode: 0o600 });
  await assert.rejects(joinNode({ bundleFile: altered, configFile }), { code: 'invalid_bundle' });
  assert.equal(existsSync(configFile), false);
  writeFileSync(altered, JSON.stringify({ ...bundle.data, instanceId: 'old-backend' }));
  await assert.rejects(joinNode({ bundleFile: altered, configFile }), { code: 'backend_identity_mismatch' });
  await joinNode({ bundleFile: bundle.file, configFile });
  const before = readFileSync(configFile, 'utf8');
  const other = await f.bundle('Other');
  await assert.rejects(joinNode({ bundleFile: other.file, configFile }), { code: 'configuration_conflict' });
  assert.equal(readFileSync(configFile, 'utf8'), before);
  const orphan = join(f.root, 'orphan'); mkdirSync(orphan);
  const journal = new NodeJournal(join(orphan, 'node.sqlite'), { nodeId: 'old-node', instanceId: 'old-backend' }); journal.close();
  await assert.rejects(joinNode({ bundleFile: bundle.file, configFile: join(orphan, 'node.json') }), { code: 'backend_identity_mismatch' });
  assert.equal(existsSync(join(orphan, 'node.json')), false); assert.equal(existsSync(join(orphan, 'operator.json')), false);
});

test('invalid client bootstrap limits cannot turn into defaults after an intent-file retry', async t => {
  const f = await fixture(t), output = join(f.evo, 'invalid.bundle');
  for (let i = 0; i < 2; i++) await assert.rejects(createNodeBundle({ api: f.api, output, key: 'invalid', name: 'Surface', url: f.backend.origin,
    mode: 'localUser', maxAgents: NaN }), { code: 'invalid_bootstrap' });
  assert.equal(existsSync(`${output}.intent`), false); assert.equal(f.backend.store.all('node').length, 0);
});

test('installed-style CLI bootstraps/joins a clean Surface home and installs enrolment commands without an existing session', async t => {
  const f = await fixture(t), file = join(f.evo, 'cli.bundle');
  const created = await f.run(f.evo, ['node', 'bootstrap', '--context', f.ownerFile, '--key', 'cli-surface', '--name', 'Surface', '--url', f.backend.origin, '--local-user', '--output', file]);
  const joined = await f.run(f.surface, ['node', 'join', '--bundle', file]);
  assert.equal(created.nodeId, joined.nodeId);
  assert.equal((await f.run(f.surface, ['node', 'join', '--bundle', file])).state, 'existing');
  const installed = await f.run(f.surface, ['plugin', 'install']);
  assert.equal(installed.state, 'installed');
  const config = JSON.parse(readFileSync(join(f.surface, 'config/opencode/cli.json')));
  assert.equal(config.plugins[0].options.ownerContextFile, joined.operatorContextFile);
  assert.equal(config.plugins[0].options.notificationSessionId, undefined);
  assert.equal(existsSync(join(f.surface, 'state/herdr-relay-backend/owner.json')), false);
  const node = JSON.parse(readFileSync(joined.configFile)), op = JSON.parse(readFileSync(joined.operatorContextFile));
  const output = JSON.stringify([created, joined, installed, config]);
  for (const token of [f.owner.token, node.backend.token, op.token]) assert.equal(output.includes(token), false);
  assert.equal((await f.run(f.surface, ['plugin', 'install'])).state, 'existing');
  assert.equal((await f.run(f.surface, ['plugin', 'uninstall'])).state, 'uninstalled');
  const dry = await f.run(f.evo, ['backend', 'install', '--state-dir', join(f.root, 'unused-backend'), '--dry-run']);
  assert.equal(dry.mutationPerformed, false); assert.match(dry.unit, /--port.*3210/);
  assert.equal(existsSync(join(f.root, 'unused-backend')), false);
  const initialised = await f.run(f.evo, ['backend', 'init', '--state-dir', join(f.evo, 'cli-backend')]);
  assert.equal(initialised.state, 'initialised');
  assert.equal(statSync(join(f.evo, 'cli-backend/owner.json')).mode & 0o777, 0o600);
  const doctor = await f.run(f.evo, ['doctor', '--context', f.ownerFile, '--backend-only']);
  assert.equal(doctor.ready, true); assert.equal(doctor.destructiveChanges, false); assert.equal(doctor.servicesStarted, false);
});
