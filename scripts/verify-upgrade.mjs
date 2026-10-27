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
import { historicalUpgradeFixture } from './historical-upgrade-fixture.mjs';
import { OpenCode } from '@opencode/client';
import { NodeJournal } from '../src/node-journal.mjs';

process.umask(0o077);
const execute = promisify(execFile), root = mkdtempSync('/tmp/opencode/relay-upgrade-smoke-');
const releases = join(root, 'releases'), backendState = join(root, 'backend'), nodeState = join(root, 'node'), bin = join(root, 'bin');
for (const path of [backendState, nodeState, bin]) mkdirSync(path);
const wait = async (label, check, timeout = 60000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await check(); if (value) return value; } catch (error) { if (error.fatal) throw error; } await delay(100); }
  throw Error(`Timed out: ${label}. Isolated state retained at ${root}`);
};
const activeWork = process.argv.includes('--active-work');
let runtime, owner, sender, receiver, failCandidate = false, releaseActive, activeHeld = false, ownedClient, ownedPid, ownedDescriptorPath, conflictRows;
const activeGate = new Promise(resolve => { releaseActive = resolve; });
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
    await wait(`${entry.role} startup`, () => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) throw Object.assign(Error(`Fixture ${entry.role} exited during startup: ${entry.log}. Fixture: ${root}`), { fatal: true });
      return entry.log.includes(entry.role === 'backend' ? '"state":"listening"' : '"state":"running"');
    }).catch(error => { console.error(JSON.stringify({ fixture: root, role: entry.role, startupLog: entry.log })); throw error; });
  },
  async reload() {},
};
const model = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body), isActiveWork = activeWork && JSON.stringify(input.messages).includes('active-upgrade-execution');
  let tool;
  if (isActiveWork) {
    const root = input.messages.findLastIndex(message => message.role === 'user');
    const called = input.messages.slice(root + 1).filter(message => message.role === 'tool').length;
    if (called === 1) { activeHeld = true; await activeGate; }
    const name = ['relay_work_read', 'relay_work_submit'][called];
    if (name) {
      const selected = input.tools.find(item => item.function.name.endsWith(name)); assert.ok(selected);
      tool = { index: 0, id: `active-call-${called}`, type: 'function', function: { name: selected.function.name,
        arguments: JSON.stringify(called === 0 ? {} : { key: 'active-result', candidate: 'active-upgrade-fixture', summary: 'Same owned process and invocation continued across compatible code upgrade.' }) } };
    }
  }
  const base = { id: 'upgrade-fixture', created: 1, model: 'fixture', object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content: 'UPGRADE_DELIVERY_OK' }, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
try {
  const old = await historicalUpgradeFixture({ version: process.env.RELAY_UPGRADE_BASELINE ?? '0.2.0-rc.9', directory: releases });
  const migration = old.compatibility.backendSchema === 1;
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
  if (activeWork) {
    assert.equal(migration, false, 'Active work gate is for a schema-compatible baseline');
    const workspace = join(root, 'owned-workspace'); mkdirSync(workspace);
    const config = JSON.parse(readFileSync(joined.configFile));
    config.bindings.push({ id: 'owned-active-binding', agentId: 'owned-active-agent', name: 'Owned active fixture', harness: 'opencode-v2-owned', mode: 'headless',
      reserved: true, directory: workspace, executable: process.env.RELAY_V2_BINARY ?? resolve('packages/opencode-relay/node_modules/.bin/opencode2'),
      config: { model: 'upgrade-fixture/fixture', compaction: { auto: false }, permissions: [{ action: '*', resource: '*', effect: 'deny' },
        { action: 'relay_work_read', resource: '*', effect: 'allow' }, { action: 'relay_work_submit', resource: '*', effect: 'allow' }],
        providers: { 'upgrade-fixture': { package: '@ai-sdk/openai-compatible', settings: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' },
          models: { fixture: { name: 'Fixture', limit: { context: 8192, output: 256 } } } } } } });
    writeFileSync(joined.configFile, JSON.stringify(config));
  }
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
  if (activeWork) {
    await wait('owned agent availability', async () => (await owner('GET', '/v1/agents/owned-active-agent')).availability === 'available');
    const task = await owner('POST', '/v1/commands', { key: 'active-task', action: 'task.create', payload: { id: 'active-task', title: 'Active compatible upgrade fixture' } });
    await owner('POST', '/v1/commands', { key: 'active-request', action: 'execution.request', payload: { id: 'active-upgrade-execution', taskId: task.id, taskRevision: task.revision,
      targetAgentId: 'owned-active-agent', instructions: 'Call relay_work_read then relay_work_submit with the actual native terminal.' } });
    await wait('owned provider stream held', () => activeHeld);
    ownedDescriptorPath = join(nodeState, 'managed', digest('owned-active-binding'), 'runtime/runtime.json');
    const descriptor = JSON.parse(readFileSync(ownedDescriptorPath)); ownedPid = descriptor.pid;
    const auth = JSON.parse(readFileSync(join(nodeState, 'managed', digest('owned-active-binding'), 'runtime/auth.json')));
    ownedClient = OpenCode.make({ baseUrl: descriptor.origin, headers: { authorization: `Basic ${Buffer.from(`opencode:${auth.password}`).toString('base64')}` } });
    assert.equal((await ownedClient.server.info()).pid, ownedPid);
    const journal = new NodeJournal(join(nodeState, 'node.sqlite'), { nodeId: joined.nodeId, instanceId: oldInfo.instanceId });
    try {
      for (const [key, action, error] of [['legacy-validation', 'headless.task', 'invalid_headless_request'], ['uncertain-key', 'task.create', 'operation_conflict']]) {
        journal.queue({ key, action, payload: { id: `must-not-apply-${key}`, title: 'Historical fixture, never replay' } });
        const row = journal.receipt(key);
        journal.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run('conflict', JSON.stringify({ ...row, state: 'conflict', error }), key);
      }
      conflictRows = journal.db.prepare("SELECT * FROM outbox WHERE key IN ('legacy-validation','uncertain-key') ORDER BY key").all();
    } finally { journal.close(); }
  }
  const identityFiles = [ownerPath, ...readdirSync(nodeState).filter(name => name.endsWith('.json') && !['runtime.json', 'maintenance.json'].includes(name)).map(name => join(nodeState, name))];
  const identityHash = path => basename(path) === 'worker-index.json' ? digest(JSON.parse(readFileSync(path, 'utf8'))) : hashBytes(readFileSync(path));
  const identities = identityFiles.map(identityHash);
  const nativeConfig = join(root, 'runtime/home/.config/opencode');
  writeFileSync(join(nativeConfig, 'cli.json'), JSON.stringify({ theme: 'preserve', plugins: [{ package: join(old.directory, 'packages/opencode-relay'),
    options: { ownerContextFile: joined.operatorContextFile, notificationSessionId: sender.sessionId } }] }), { mode: 0o600 });
  const request = { services: ['backend', 'node'], version: candidate.version, key: 'real-upgrade', nodeConfig: joined.configFile,
    migrateTaskReferences: migration,
    directory: join(root, 'upgrades'), configDirectory: nativeConfig, binDirectory: bin, apply: true };
  const upgradeDependencies = { manager, stageRelease: async () => candidate,
    health: async (...args) => { if (failCandidate && args[4] && args[1].release.version === candidate.version) throw Error('Intentional health failure'); return verifyServiceHealth(...args); },
    healthAttempts: 20, healthDelay: 100 };
  // Node schema is unchanged: prove compatible code rollback before the
  // irreversible backend identity migration, without restoring any database.
  const backendPid = (await manager.inspect(backendName)).pid;
  const nodeOnly = await serviceUpgrade({ ...request, migrateTaskReferences: false, services: ['node'], key: 'node-only' }, upgradeDependencies);
  assert.equal((await manager.inspect(backendName)).pid, backendPid);
  await send('node-only-upgrade');
  await serviceUpgrade({ rollback: nodeOnly.operationId, directory: request.directory, apply: true }, upgradeDependencies);
  failCandidate = true;
  await assert.rejects(serviceUpgrade({ ...request, migrateTaskReferences: false, services: ['node'], key: 'failed-health' }, upgradeDependencies), { code: 'upgrade_rolled_back' });
  failCandidate = false;
  const pendingForm = await runtime.client.session.form.create({ sessionID: sender.sessionId, title: 'Fixture pending decision',
    fields: [{ type: 'boolean', key: 'fixture', title: 'Fixture only', required: true }] });
  const beforeDecisionGuard = [(await manager.inspect(backendName)).pid, (await manager.inspect(nodeName)).pid];
  let result;
  if (migration) await assert.rejects(serviceUpgrade({ ...request, key: 'blocked-pending-form' }, upgradeDependencies), { code: 'upgrade_pending_decisions' });
  else {
    result = await serviceUpgrade({ ...request, key: 'compatible-pending-form' }, upgradeDependencies);
    assert.equal(result.state, 'committed'); assert.equal(result.pluginReloadDeferred.reason, 'upgrade_pending_decisions');
  }
  assert.equal((await runtime.client.session.form.get({ sessionID: sender.sessionId, formID: pendingForm.id })).state.status, 'pending');
  if (migration) assert.deepEqual([(await manager.inspect(backendName)).pid, (await manager.inspect(nodeName)).pid], beforeDecisionGuard);
  await runtime.client.session.form.cancel({ sessionID: sender.sessionId, formID: pendingForm.id }); // Own fixture only, never a user approval.
  if (migration) result = await serviceUpgrade(request, upgradeDependencies);
  else {
    const finished = await serviceUpgrade({ resume: result.operationId, directory: request.directory, apply: true }, upgradeDependencies);
    assert.equal(finished.pluginReloadDeferred, null); assert.equal(finished.servicesRestarted, false);
  }
  assert.equal(result.state, 'committed'); assert.equal((await owner('GET', '/v1/info')).version, candidate.version);
  assert.equal((await owner('GET', '/v1/info')).instanceId, oldInfo.instanceId);
  assert.deepEqual(identityFiles.map(identityHash), identities);
  assert.equal((await runtime.client.server.info()).pid, nativePid);
  if (activeWork) {
    assert.equal((await ownedClient.server.info()).pid, ownedPid, 'Supervisor upgrades must not stop the owned model process');
    assert.equal((await owner('GET', '/v1/executions/active-upgrade-execution')).state, 'accepted');
    const journal = new NodeJournal(join(nodeState, 'node.sqlite'), { nodeId: joined.nodeId, instanceId: oldInfo.instanceId });
    try { assert.deepEqual(journal.db.prepare("SELECT * FROM outbox WHERE key IN ('legacy-validation','uncertain-key') ORDER BY key").all(), conflictRows); }
    finally { journal.close(); }
    releaseActive();
    await wait('same active execution completes once after upgrade', async () => (await owner('GET', '/v1/executions/active-upgrade-execution')).state === 'completed');
    const provision = JSON.parse(readFileSync(join(nodeState, 'managed', digest('owned-active-binding'), 'provision.json')));
    const messages = (await ownedClient.message.list({ sessionID: provision.sessionId, order: 'asc', limit: 100 })).data;
    assert.equal(messages.filter(message => message.metadata?.herdrRelayInvocation).length, 1, 'No original prompt is replayed');
    assert.equal((await ownedClient.server.info()).pid, ownedPid);
  }
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
  if (migration) await assert.rejects(serviceUpgrade({ rollback: result.operationId, directory: request.directory, apply: true }, upgradeDependencies), { code: 'upgrade_incompatible' });
  else await serviceUpgrade({ rollback: result.operationId, directory: request.directory, apply: true }, upgradeDependencies);
  assert.equal((await owner('GET', '/v1/tasks/later-task')).title, 'Must survive rollback');
  assert.match((await owner('GET', '/v1/tasks/keep-task')).reference, /^REL-[1-9][0-9]*$/);
  assert.match((await owner('GET', '/v1/tasks/later-task')).reference, /^REL-[1-9][0-9]*$/);
  assert.deepEqual(identityFiles.map(identityHash), identities);
  assert.equal((await owner('GET', '/v1/info')).instanceId, oldInfo.instanceId);
  assert.equal((await runtime.client.server.info()).pid, nativePid);
  const snapshot = await owner('GET', '/v1/snapshot');
  assert.equal(snapshot.collections.task.length, activeWork ? 3 : 2); assert.equal(snapshot.collections.execution.length, activeWork ? 1 : 0);
  assert.equal(snapshot.collections.message.length, 3); assert.equal(snapshot.collections.agent.length, activeWork ? 3 : 2);
  assert.deepEqual(identityFiles.map(identityHash), identities);
  console.log(JSON.stringify({ passed: true, from: old.version, to: candidate.version, actualBackendAndNodeProcesses: true,
    historicalBaselineFixtureOnly: old.historicalFixtureOnly, baselineProductionAuditFindings: old.productionAuditFindings,
    baselineProductionActivationAllowed: old.productionActivationAllowed, candidateFreshProductionAuditPassed: candidate.auditVerified,
    installedUpgradeEntrypoint: true, nativeToolsWithoutInjectedRuntimePaths: true,
    versionedCliActivationPassed: true, cachedReleaseAuditPassed: true,
    pendingFormPreservedDuringMaintenance: true, compatiblePluginReloadDeferred: !migration, migrationDecisionGuardPassed: migration,
    realOpenCodeChatsPreserved: true, backendInstanceAndNodeIdentityPreserved: true, credentialsUnchanged: true,
    taskDataAndPostUpgradeEditsPreserved: true, nodeOnlyDidNotRestartBackend: true, messageDeliveryBeforeAndAfterPassed: true,
    explicitCompatibleNodeRollbackPassed: true, explicitCompatibleBackendRollbackPassed: !migration, failedHealthAutomaticRollbackPassed: true,
    schema2MigrationPassed: migration, schema1RollbackRefused: migration, databasesRestored: false,
    activeOwnedModelSurvivedSupervisorUpgrade: activeWork, activeExecutionContinuedWithoutReplay: activeWork, conflictingPublicationsPreservedWithoutReplay: activeWork,
    userServicesTouched: false, userChatsTouched: false, physicalMachines: 1, state: root }, null, 2));
} finally {
  releaseActive();
  for (const role of ['node', 'backend']) for (const [name, entry] of services) if (entry.role === role) await manager.stop(name);
  if (runtime) { await wait('fixture native idle', async () => Object.keys(await runtime.client.session.active()).length === 0); await runtime.stop(); }
  if (ownedClient && ownedDescriptorPath) {
    await wait('owned fixture idle', async () => Object.keys(await ownedClient.session.active()).length === 0);
    const descriptor = JSON.parse(readFileSync(ownedDescriptorPath));
    const { launchOwnedV2 } = await import('../packages/opencode-relay/owned-runtime.mjs');
    const handle = await launchOwnedV2({ directory: join(ownedDescriptorPath, '..'), executable: descriptor.request.executable, workspace: descriptor.request.workspace, config: descriptor.request.config });
    await handle.stop();
  }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
