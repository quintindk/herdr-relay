// Real isolated backend/node processes and OpenCode chats. The service manager
// implements start/stop using child processes, never the user's systemd units.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stageRelease, hashBytes } from '../src/release-install.mjs';
import { pathToFileURL } from 'node:url';
import { parseManagedUnit } from '../src/managed-service-unit.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { createNodeBundle, joinNode } from '../src/native-onboarding.mjs';
import { enrolInteractive } from '../src/native-enrol.mjs';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from '../src/client.mjs';
import { digest } from '../src/protocol.mjs';

process.umask(0o077);
const execute = promisify(execFile), root = mkdtempSync('/tmp/opencode/relay-upgrade-smoke-');
const releases = join(root, 'releases'), backendState = join(root, 'backend'), nodeState = join(root, 'node'), bin = join(root, 'bin');
for (const path of [backendState, nodeState, bin]) mkdirSync(path);
const wait = async (label, check, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch {} await delay(100); }
  throw Error(`Timed out: ${label}. Isolated state retained at ${root}`);
};
let runtime, owner, sender, receiver, failCandidate = false;
const services = new Map();
const manager = {
  async inspect(name) {
    const entry = services.get(name); assert.ok(entry, 'Only fixture-owned services are supported');
    return { name, path: entry.path, active: Boolean(entry.child && entry.child.exitCode === null && entry.child.signalCode === null), pid: entry.child?.pid ?? 0 };
  },
  async stop(name) {
    const entry = services.get(name); if (!(await this.inspect(name)).active) return;
    const exited = once(entry.child, 'exit'); entry.child.kill('SIGTERM');
    const timer = setTimeout(() => entry.child.kill('SIGKILL'), 15000);
    try { const [code] = await exited; assert.equal(code, 0, 'Fixture service did not stop cleanly'); } finally { clearTimeout(timer); }
  },
  async start(name) {
    const entry = services.get(name), unit = parseManagedUnit(readFileSync(entry.path, 'utf8'), entry.role);
    assert.equal((await this.inspect(name)).active, false);
    entry.log = ''; entry.child = spawn(unit.args[0], unit.args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [entry.child.stdout, entry.child.stderr]) stream.on('data', chunk => { entry.log = (entry.log + chunk).slice(-6000); });
    await wait(`${entry.role} startup`, () => entry.log.includes(entry.role === 'backend' ? '"state":"listening"' : '"state":"running"'));
  },
  async reload() {},
};
const model = createServer(async (req, res) => {
  for await (const _chunk of req) {};
  const base = { id: 'upgrade-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'UPGRADE_DELIVERY_OK' }, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
try {
  const old = await stageRelease({ version: process.env.RELAY_UPGRADE_BASELINE ?? '0.2.0-rc.6', directory: releases });
  const [packed] = JSON.parse((await execute('npm', ['pack', '--json', '--pack-destination', root])).stdout);
  const tarball = join(root, packed.filename), artifactHash = hashBytes(readFileSync(tarball));
  const candidate = await stageRelease({ artifact: tarball, sha256: artifactHash, directory: releases });
  const reused = await stageRelease({ version: candidate.version, artifact: tarball, sha256: artifactHash, directory: releases });
  assert.equal(reused.reused, true); assert.equal(reused.auditVerified, true);
  const { serviceUpgrade, verifyServiceHealth, installCliRelease } = await import(pathToFileURL(join(candidate.directory, 'src/service-upgrade.mjs')));
  await execute(process.execPath, [join(old.directory, 'src/cli.mjs'), 'native', 'backend', 'init', '--state-dir', backendState]);
  const free = createServer(); await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
  const port = free.address().port; await new Promise(resolve => free.close(resolve));
  const origin = `http://127.0.0.1:${port}`, ownerPath = join(backendState, 'owner.json');
  const ownerContext = { ...JSON.parse(readFileSync(ownerPath)), url: origin };
  writeFileSync(ownerPath, JSON.stringify(ownerContext), { mode: 0o600 }); owner = nativeBackendClient(ownerContext);
  const addService = (role, name, args) => {
    const path = join(root, name);
    writeFileSync(path, `# Managed by herdr-relay/scripts/install-native-${role}.mjs\n[Service]\nExecStart=${[process.execPath, join(old.directory, 'src', `${role}-cli.mjs`), ...args].map(v => JSON.stringify(v)).join(' ')}\nRestart=on-failure\n`);
    services.set(name, { role, path }); return name;
  };
  const backendName = addService('backend', 'herdr-relay-backend.service', ['serve', '--state-dir', backendState, '--port', String(port)]);
  await manager.start(backendName);
  const oldInfo = await owner('GET', '/v1/info');
  const bundleFile = join(root, 'node.bundle.json');
  await createNodeBundle({ api: owner, output: bundleFile, key: 'upgrade-fixture-node', name: 'Fixture node', url: origin, mode: 'localUser' });
  const joined = await joinNode({ bundleFile, configFile: join(nodeState, 'node.json') });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace,
    executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
    config: { plugins: [{ package: join(old.directory, 'packages/opencode-relay'), options: { workerDirectory: nodeState } }],
      model: 'upgrade-fixture/fixture', compaction: { auto: false }, providers: { 'upgrade-fixture': { package: '@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 256 } } } } } } });
  const nativePid = (await runtime.client.server.info()).pid;
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const dependencies = { discover: async () => ({ url: runtime.descriptor.origin, auth: { type: 'basic', username: 'opencode', password } }), makeClient: () => runtime.client };
  const enrol = async name => {
    const session = await runtime.client.session.create({ location: { directory: workspace }, title: name });
    return enrolInteractive({ api: owner, backend: { url: origin }, configFile: joined.configFile, directory: workspace,
      sessionId: session.id, reserved: true, transport: 'tools', name }, dependencies);
  };
  sender = await enrol('Upgrade sender'); receiver = await enrol('Upgrade receiver');
  const nodeName = addService('node', `herdr-relay-node-${joined.nodeId}.service`, ['--config', joined.configFile]);
  symlinkSync(join(old.directory, 'src/cli.mjs'), join(bin, 'herdr-relay'));
  symlinkSync(join(old.directory, 'src/remote.mjs'), join(bin, 'herdr-relay-remote'));
  const activated = await installCliRelease({ version: candidate.version, directory: join(root, 'upgrades'), binDirectory: bin }, { stageRelease: async () => candidate });
  assert.equal(activated.servicesChanged, false);
  await manager.start(nodeName);
  await owner('POST', '/v1/commands', { key: 'keep-task', action: 'task.create', payload: { id: 'keep-task', title: 'Preserve through upgrade and rollback' } });
  const send = async key => {
    const connection = workerConnection({ workerDirectory: nodeState }, sender.sessionId);
    const sent = await call(connection, 'POST', '/agent/message-send', { key, recipientAgentId: receiver.agentId, kind: 'status', body: `Isolated upgrade smoke ${key}. No action requested.` });
    return wait(`delivered ${key}`, async () => { const m = await owner('GET', `/v1/messages/${sent.receipt.id}`); return m.state === 'delivered' && m; });
  };
  await send('before-upgrade');
  const identityFiles = [ownerPath, ...readdirSync(nodeState).filter(name => name.endsWith('.json') && !['runtime.json', 'maintenance.json'].includes(name)).map(name => join(nodeState, name))];
  const identityHash = path => basename(path) === 'worker-index.json' ? digest(JSON.parse(readFileSync(path, 'utf8'))) : hashBytes(readFileSync(path));
  const identities = identityFiles.map(identityHash);
  const nativeConfig = join(root, 'runtime/home/.config/opencode');
  writeFileSync(join(nativeConfig, 'cli.json'), JSON.stringify({ theme: 'preserve', plugins: [{ package: join(old.directory, 'packages/opencode-relay'),
    options: { ownerContextFile: joined.operatorContextFile, notificationSessionId: sender.sessionId } }] }), { mode: 0o600 });
  const request = { services: ['backend', 'node'], version: candidate.version, key: 'real-upgrade', nodeConfig: joined.configFile,
    directory: join(root, 'upgrades'), configDirectory: nativeConfig, binDirectory: bin, apply: true };
  const upgradeDependencies = { manager, stageRelease: async () => candidate,
    health: async (...args) => { if (failCandidate && args[4] && args[1].release.version === candidate.version) throw Error('Intentional health failure'); return verifyServiceHealth(...args); },
    healthAttempts: 20, healthDelay: 100 };
  const pendingForm = await runtime.client.session.form.create({ sessionID: sender.sessionId, title: 'Fixture pending decision',
    fields: [{ type: 'boolean', key: 'fixture', title: 'Fixture only', required: true }] });
  const beforeDecisionGuard = [(await manager.inspect(backendName)).pid, (await manager.inspect(nodeName)).pid];
  await assert.rejects(serviceUpgrade({ ...request, key: 'blocked-pending-form' }, upgradeDependencies), { code: 'upgrade_pending_decisions' });
  assert.equal((await runtime.client.session.form.get({ sessionID: sender.sessionId, formID: pendingForm.id })).state.status, 'pending');
  assert.deepEqual([(await manager.inspect(backendName)).pid, (await manager.inspect(nodeName)).pid], beforeDecisionGuard);
  await runtime.client.session.form.cancel({ sessionID: sender.sessionId, formID: pendingForm.id }); // Own fixture only, never a user approval.
  const result = await serviceUpgrade(request, upgradeDependencies);
  assert.equal(result.state, 'committed'); assert.equal((await owner('GET', '/v1/info')).version, candidate.version);
  assert.equal((await owner('GET', '/v1/info')).instanceId, oldInfo.instanceId);
  assert.deepEqual(identityFiles.map(identityHash), identities);
  assert.equal((await runtime.client.server.info()).pid, nativePid);
  assert.equal((await runtime.client.session.get({ sessionID: receiver.sessionId })).id, receiver.sessionId);
  const deliveredAfterUpgrade = await send('after-upgrade');
  const transcript = await runtime.client.message.list({ sessionID: receiver.sessionId, order: 'desc', limit: 20 });
  const peerPrompt = transcript.data.find(message => message.id === deliveredAfterUpgrade.delivery.nativeMessageId);
  assert.ok(peerPrompt); assert.match(peerPrompt.text, /relay_questions/);
  assert.doesNotMatch(peerPrompt.text, /node-worker-cli|\/\.nvm\/|--context/);
  assert.equal((await execute(join(bin, 'herdr-relay'), ['--version'])).stdout.trim(), candidate.version);
  const recorded = JSON.parse((await execute(join(bin, 'herdr-relay'), ['upgrade', 'status', result.operationId, '--upgrade-dir', request.directory])).stdout);
  assert.equal(recorded.operations[0].phase, 'committed');
  await owner('POST', '/v1/commands', { key: 'later-task', action: 'task.create', payload: { id: 'later-task', title: 'Must survive rollback' } });
  await serviceUpgrade({ rollback: result.operationId, directory: request.directory, apply: true }, upgradeDependencies);
  assert.equal((await owner('GET', '/v1/tasks/later-task')).title, 'Must survive rollback');
  assert.deepEqual(identityFiles.map(identityHash), identities);
  const backendPid = (await manager.inspect(backendName)).pid;
  const nodeOnly = await serviceUpgrade({ ...request, services: ['node'], key: 'node-only' }, upgradeDependencies);
  assert.equal((await manager.inspect(backendName)).pid, backendPid);
  await send('node-only-upgrade');
  await serviceUpgrade({ rollback: nodeOnly.operationId, directory: request.directory, apply: true }, upgradeDependencies);
  failCandidate = true;
  await assert.rejects(serviceUpgrade({ ...request, key: 'failed-health' }, upgradeDependencies), { code: 'upgrade_rolled_back' });
  failCandidate = false;
  assert.equal((await owner('GET', '/v1/info')).instanceId, oldInfo.instanceId);
  assert.equal((await runtime.client.server.info()).pid, nativePid);
  const snapshot = await owner('GET', '/v1/snapshot');
  assert.equal(snapshot.collections.task.length, 2); assert.equal(snapshot.collections.execution.length, 0);
  assert.equal(snapshot.collections.message.length, 3); assert.equal(snapshot.collections.agent.length, 2);
  assert.deepEqual(identityFiles.map(identityHash), identities);
  console.log(JSON.stringify({ passed: true, from: old.version, to: candidate.version, actualBackendAndNodeProcesses: true,
    installedUpgradeEntrypoint: true, nativeToolsWithoutInjectedRuntimePaths: true,
    versionedCliActivationPassed: true, cachedReleaseAuditPassed: true,
    pendingFormPreservedDuringRefusal: true,
    realOpenCodeChatsPreserved: true, backendInstanceAndNodeIdentityPreserved: true, credentialsUnchanged: true,
    taskDataAndPostUpgradeEditsPreserved: true, nodeOnlyDidNotRestartBackend: true, messageDeliveryBeforeAndAfterPassed: true,
    explicitCodeRollbackPassed: true, failedHealthAutomaticRollbackPassed: true, databasesRestored: false,
    userServicesTouched: false, userChatsTouched: false, physicalMachines: 1, state: root }, null, 2));
} finally {
  for (const role of ['node', 'backend']) for (const [name, entry] of services) if (entry.role === role) await manager.stop(name);
  if (runtime) { await wait('fixture native idle', async () => Object.keys(await runtime.client.session.active()).length === 0); await runtime.stop(); }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
