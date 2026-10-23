import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { serviceUpgrade, installationStatus, installCliRelease } from '../src/service-upgrade.mjs';
import { parseManagedUnit } from '../src/managed-service-unit.mjs';
import { pluginUpgradeFiles } from '../src/upgrade-plugin.mjs';
import { compatibility, releaseInfo } from '../src/release-info.mjs';
import { readOpenCodeConfig } from '../src/opencode-config-file.mjs';
import { serviceIdentity, identityFingerprint } from '../src/upgrade-safety.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/upgrade-');
  const backend = join(root, 'backend'), node = join(root, 'node'), config = join(root, 'config'), bin = join(root, 'bin'), units = join(root, 'units');
  for (const directory of [backend, node, config, bin, units]) mkdirSync(directory);
  const makePackage = (version, contract = compatibility) => {
    const directory = join(root, `release ${version}`); mkdirSync(join(directory, 'src'), { recursive: true });
    mkdirSync(join(directory, 'packages/opencode-relay'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'herdr-relay', version, ...(contract ? { relayCompatibility: contract } : {}) }));
    for (const file of ['cli.mjs', 'backend-cli.mjs', 'node-cli.mjs']) writeFileSync(join(directory, 'src', file), '#!/usr/bin/env node\n');
    writeFileSync(join(directory, 'packages/opencode-relay/package.json'), JSON.stringify({ name: '@herdr/relay-opencode-v2-spike', version }));
    return directory;
  };
  // Synthetic compatible packages, not claims that historical RC4 supported schema 2.
  const previous = makePackage('0.2.0-rc.4'), candidate = makePackage('0.2.0-rc.5');
  symlinkSync(join(previous, 'src/cli.mjs'), join(bin, 'herdr-relay'));
  const store = new BackendStore(join(backend, 'backend.sqlite'));
  const ownerToken = store.bootstrap().token, owner = store.authenticate(ownerToken);
  writeFileSync(join(backend, 'owner.json'), JSON.stringify({ token: ownerToken }), { mode: 0o600 });
  const journal = new NodeJournal(join(node, 'node.sqlite'), { nodeId: 'test-node', instanceId: store.instance });
  const nodeConfig = join(node, 'node.json');
  writeFileSync(nodeConfig, JSON.stringify({ identityVersion: 2, nodeId: 'test-node', stateDirectory: node,
    backend: { url: 'http://127.0.0.1:3210', token: 'private-daemon-token' }, bindings: [] }), { mode: 0o600 });
  writeFileSync(join(node, 'backend-instance.json'), JSON.stringify({ instanceId: store.instance }), { mode: 0o600 });
  writeFileSync(join(node, 'operator.json'), JSON.stringify({ token: 'private-operator-token' }), { mode: 0o600 });
  const serverConfig = join(config, 'opencode.jsonc'), terminalConfig = join(config, 'cli.json');
  writeFileSync(serverConfig, `// Keep this comment\n{"model":"unchanged/model","plugins":[{"package":${JSON.stringify(join(previous, 'packages/opencode-relay'))},"options":{"workerDirectory":${JSON.stringify(node)}}}]}\n`);
  writeFileSync(terminalConfig, JSON.stringify({ theme: 'unchanged', plugins: [{ package: join(previous, 'packages/opencode-relay'),
    options: { ownerContextFile: join(node, 'operator.json'), notificationSessionId: 'ses_keep' } }] }));
  const states = new Map(), calls = [];
  for (const role of ['backend', 'node']) {
    const name = role === 'backend' ? 'herdr-relay-backend.service' : 'herdr-relay-node-test-node.service';
    const path = join(units, name), script = join(previous, 'src', `${role}-cli.mjs`);
    const args = role === 'backend' ? ['serve', '--state-dir', backend, '--port', '3210'] : ['--config', nodeConfig];
    writeFileSync(path, `# Managed by herdr-relay/scripts/install-native-${role}.mjs\n[Service]\nExecStart=${[process.execPath, script, ...args].map(v => JSON.stringify(v.replaceAll('%', '%%'))).join(' ')}\nRestart=on-failure\n`);
    states.set(name, { name, path, active: true, pid: role === 'backend' ? 100 : 200 });
  }
  const f = { root, backend, node, config, bin, previous, candidate, store, owner, journal, states, calls, nodeConfig, serverConfig, terminalConfig };
  f.manager = {
    inspect: async name => ({ ...states.get(name) }),
    stop: async name => { calls.push(['stop', name]); states.get(name).active = false; if (f.onStop) { const hook = f.onStop; f.onStop = null; hook(); } },
    start: async name => { calls.push(['start', name]); states.get(name).active = true; states.get(name).pid++; },
    reload: async () => { calls.push(['reload']); },
  };
  f.dependencies = { manager: f.manager, stageRelease: async () => ({ directory: candidate, version: '0.2.0-rc.5', auditVerified: true }), healthAttempts: 1, healthDelay: 0,
    health: async (service, unit, manager, paused, required) => {
      assert.equal((await manager.inspect(service.name)).active, service.active);
      if (f.failHealth && required) throw Error('candidate failed');
      if (f.onHealth) f.onHealth(service, unit, paused, required);
    } };
  f.input = { services: ['backend', 'node'], version: '0.2.0-rc.5', key: 'test-upgrade', nodeConfig,
    directory: join(root, 'upgrades'), configDirectory: config, binDirectory: bin };
  f.apply = extra => serviceUpgrade({ ...f.input, apply: true, ...extra }, f.dependencies);
  f.operation = id => join(root, 'upgrades/operations', id);
  t.after(() => { journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return f;
}

test('database schema mismatch refuses downgrade or implicit migration before any service stop', async t => {
  const f = fixture(t), manifest = join(f.candidate, 'package.json'), value = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...value, relayCompatibility: { ...compatibility, backendSchema: 1 } }));
  await assert.rejects(f.apply(), { code: 'upgrade_incompatible' });
  assert.equal(f.calls.some(([action]) => action === 'stop'), false);
});

function legacyBackend(f) {
  // Disposable fixture only. Represent the actual schema-1 predecessor without
  // loading a second implementation into this process.
  for (const row of f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'task_%'").all()) f.store.db.exec(`DROP TRIGGER ${row.name}`);
  f.store.db.exec('DROP TABLE task_reference_claims; DROP TABLE task_reference_counters; DROP TABLE task_aliases; PRAGMA user_version=1;');
  const task = { id: 'legacy-task', title: 'Keep original task', revision: 1, createdAt: '2020-01-01', updatedAt: '2020-01-01' };
  f.store.db.prepare('INSERT INTO entities VALUES (?,?,?,?)').run('task', task.id, task.revision, JSON.stringify(task));
  const path = join(f.previous, 'package.json'), manifest = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ ...manifest, relayCompatibility: { ...compatibility, backendSchema: 1 } }));
}

test('explicit managed schema migration preserves identity/data, backfills references and refuses old-writer rollback', async t => {
  const f = fixture(t); legacyBackend(f);
  const plan = await serviceUpgrade({ ...f.input, migrateTaskReferences: true }, f.dependencies);
  assert.equal(plan.taskReferenceMigration, true); assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(f.calls.some(([action]) => action === 'stop'), false);
  const result = await f.apply({ migrateTaskReferences: true });
  assert.equal(result.state, 'committed'); assert.equal(f.store.get('task', 'legacy-task').reference, 'REL-1');
  const record = JSON.parse(readFileSync(join(f.operation(result.operationId), 'operation.json')));
  assert.equal(record.migration.backfilled, 1); assert.equal(record.migration.instanceId, f.store.instance);
  assert.ok(existsSync(record.migration.backup));
  await assert.rejects(serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies), { code: 'upgrade_incompatible' });
  assert.ok([...f.states.values()].every(state => state.active));
});

test('failed health after schema migration retains candidate state for exact roll-forward resume, never schema-1 rollback', async t => {
  const f = fixture(t); legacyBackend(f); f.failHealth = true;
  await assert.rejects(f.apply({ migrateTaskReferences: true }), { code: 'upgrade_recovery_required' });
  const id = JSON.parse(readFileSync(join(f.root, 'upgrades/operations', readdirSync(join(f.root, 'upgrades/operations'))[0], 'operation.json'))).id;
  const path = join(f.operation(id), 'operation.json'), record = JSON.parse(readFileSync(path));
  assert.equal(record.recoveryAction, 'resume'); assert.equal(f.store.get('task', 'legacy-task').reference, 'REL-1');
  // Emulate a crash between migration commit and saving its result receipt.
  delete record.migration; writeFileSync(path, JSON.stringify(record));
  f.failHealth = false;
  const result = await serviceUpgrade({ resume: id, directory: f.input.directory, apply: true }, f.dependencies);
  assert.equal(result.state, 'committed'); assert.equal(f.store.all('task').length, 1);
  assert.equal(f.store.get('task', 'legacy-task').reference, 'REL-1');
});

test('post-activation migration recovery resumes health checks without stopping newly admitted work', async t => {
  const f = fixture(t); legacyBackend(f);
  f.onHealth = (_service, _unit, paused, required) => {
    if (required && !paused) {
      f.journal.save({ id: 'post-activation', state: 'observing', execution: { id: 'post-activation', state: 'accepted' } });
      throw Error('Post-activation health unavailable');
    }
  };
  await assert.rejects(f.apply({ migrateTaskReferences: true }), { code: 'upgrade_recovery_required' });
  const id = readdirSync(join(f.root, 'upgrades/operations'))[0], path = join(f.operation(id), 'operation.json');
  assert.equal(JSON.parse(readFileSync(path)).resumePhase, 'activating');
  f.onHealth = null; f.calls.length = 0;
  assert.equal((await serviceUpgrade({ resume: id, directory: f.input.directory, apply: true }, f.dependencies)).state, 'committed');
  assert.equal(f.calls.some(([action]) => action === 'stop'), false);
  assert.equal(f.journal.work('post-activation').state, 'observing');
});

test('retained schema-1 rollback is refused after migration without touching current service pointers', async t => {
  const f = fixture(t), manifest = join(f.previous, 'package.json'), value = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...value, relayCompatibility: { ...compatibility, backendSchema: 1 } }));
  const result = await f.apply();
  f.calls.length = 0;
  await assert.rejects(serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies), { code: 'upgrade_incompatible' });
  assert.equal(f.calls.some(([action]) => action === 'stop'), false);
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.candidate, 'src/cli.mjs'));
});

test('managed service parsing preserves quoted paths, port, runtime executable and state while changing release only', t => {
  const f = fixture(t), service = f.states.get('herdr-relay-backend.service');
  const before = readFileSync(service.path, 'utf8'), unit = parseManagedUnit(before, 'backend');
  assert.equal(unit.release.version, '0.2.0-rc.4'); assert.equal(unit.statePath, f.backend);
  const after = parseManagedUnit(unit.replace(f.candidate), 'backend');
  assert.equal(after.release.version, '0.2.0-rc.5'); assert.deepEqual(after.args.slice(2), unit.args.slice(2));
  assert.equal(after.args[0], process.execPath);
  assert.throws(() => parseManagedUnit(before.replace('# Managed', '# Unmanaged'), 'backend'), { code: 'unmanaged_service' });
  assert.throws(() => releaseInfo(fixture(t).root));
});

test('generated worker index key reordering during service restart does not block upgrade or compatible rollback', async t => {
  const f = fixture(t), index = join(f.node, 'worker-index.json');
  writeFileSync(index, '{"nodeId":"test-node","sessions":{"ses_a":"a","ses_b":"b"}}');
  f.onHealth = service => { if (service.role === 'node') writeFileSync(index, '{"sessions":{"ses_b":"b","ses_a":"a"},"nodeId":"test-node"}'); };
  const result = await f.apply(); assert.equal(result.state, 'committed');
  const record = JSON.parse(readFileSync(join(f.operation(result.operationId), 'operation.json'), 'utf8'));
  assert.ok(record.services.every(s => s.identityFingerprintVersion === 2));
  const rollback = await serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies);
  assert.equal(rollback.state, 'rolled_back');
});

test('retained RC5 operation records without a fingerprint version still use their original byte-level guard', async t => {
  const f = fixture(t);
  writeFileSync(join(f.node, 'worker-index.json'), '{"nodeId":"test-node","sessions":{}}');
  const result = await f.apply(), path = join(f.operation(result.operationId), 'operation.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  for (const service of record.services) {
    delete service.identityFingerprintVersion;
    const unit = parseManagedUnit(readFileSync(service.unitPath, 'utf8'), service.role);
    service.identityFingerprint = identityFingerprint(serviceIdentity(unit), 1);
  }
  writeFileSync(path, JSON.stringify(record));
  const rollback = await serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies);
  assert.equal(rollback.state, 'rolled_back');
});

test('compatible rollback verifies the restored node is unpaused before reporting success', async t => {
  const f = fixture(t), result = await f.apply(), observations = [];
  f.onHealth = (service, unit, paused, required) => observations.push({ role: service.role, paused, required });
  await serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies);
  assert.deepEqual(observations.filter(o => o.role === 'node').map(o => o.paused), [true, false]);
  assert.ok(observations.every(o => o.required === false));
});

test('plan stages a compatible release without stopping services, changing configuration or activating a CLI', async t => {
  const f = fixture(t), original = readFileSync(f.serverConfig, 'utf8');
  const plan = await serviceUpgrade(f.input, f.dependencies);
  assert.equal(plan.state, 'upgrade_plan'); assert.equal(plan.pluginConfigurationReload, true);
  assert.equal(f.calls.length, 0); assert.equal(readFileSync(f.serverConfig, 'utf8'), original);
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.previous, 'src/cli.mjs'));
  assert.equal(existsSync(f.operation(plan.operationId)), false);
});

test('upgrade switches backend/node/plugin/CLI together and preserves all identity/configuration bytes and task data', async t => {
  const f = fixture(t), configBefore = readFileSync(f.nodeConfig), ownerBefore = readFileSync(join(f.backend, 'owner.json'));
  f.store.command(f.owner, { key: 'task', action: 'task.create', payload: { id: 'task', title: 'Keep me' } });
  const result = await f.apply();
  assert.equal(result.state, 'committed'); assert.equal(result.identitiesPreserved, true); assert.equal(result.databasesRestored, false);
  assert.deepEqual(readFileSync(f.nodeConfig), configBefore); assert.deepEqual(readFileSync(join(f.backend, 'owner.json')), ownerBefore);
  assert.equal(f.store.get('task', 'task').title, 'Keep me');
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.candidate, 'src/cli.mjs'));
  assert.match(readFileSync(f.serverConfig, 'utf8'), /Keep this comment/);
  const terminal = readOpenCodeConfig(f.terminalConfig).value;
  assert.equal(terminal.theme, 'unchanged'); assert.equal(terminal.plugins[0].options.notificationSessionId, 'ses_keep');
  assert.equal(terminal.plugins[0].options.ownerContextFile, join(f.node, 'operator.json'));
  for (const role of ['backend', 'node']) {
    assert.equal(existsSync(join(f.operation(result.operationId), `${role}-before-upgrade.sqlite`)), true);
    assert.equal(existsSync(join(f[role], 'maintenance.json')), false);
  }
  assert.deepEqual(f.calls.filter(c => c[0] === 'stop').map(c => c[1]), ['herdr-relay-node-test-node.service', 'herdr-relay-backend.service']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'start').map(c => c[1]), ['herdr-relay-backend.service', 'herdr-relay-node-test-node.service']);
  assert.equal(f.calls.some(c => String(c).includes('opencode')), false);
  const count = f.calls.length;
  assert.equal((await f.apply()).replayed, true); assert.equal(f.calls.length, count);
  await assert.rejects(f.apply({ version: '0.2.0-rc.6' }), { code: 'operation_conflict' });
});

test('node-only upgrade needs no backend-root credential and does not restart the backend', async t => {
  const f = fixture(t); rmSync(join(f.backend, 'owner.json'));
  const result = await f.apply({ services: ['node'] });
  assert.deepEqual(result.services, ['node']); assert.ok(f.calls.every(c => c[1] !== 'herdr-relay-backend.service'));
  const status = await installationStatus({ services: ['node'], nodeConfig: f.nodeConfig }, { manager: f.manager });
  assert.equal(status.services[0].version, '0.2.0-rc.5'); assert.equal(status.services[0].nodeId, 'test-node');
});

test('backend-only upgrade neither reads node credentials nor rewrites node/plugin configuration', async t => {
  const f = fixture(t), before = readFileSync(f.serverConfig, 'utf8'); rmSync(f.nodeConfig);
  const result = await f.apply({ services: ['backend'] });
  assert.deepEqual(result.services, ['backend']); assert.ok(f.calls.every(c => c[1] !== 'herdr-relay-node-test-node.service'));
  assert.equal(readFileSync(f.serverConfig, 'utf8'), before);
});

test('release install activates one verified public CLI without service changes and removes only the package-owned SSH executable', async t => {
  const f = fixture(t); writeFileSync(join(f.previous, 'src/remote.mjs'), '// retired');
  symlinkSync(join(f.previous, 'src/remote.mjs'), join(f.bin, 'herdr-relay-remote'));
  const request = { version: '0.2.0-rc.5', directory: f.input.directory, binDirectory: f.bin };
  const result = await installCliRelease(request, f.dependencies);
  assert.equal(result.servicesChanged, false); assert.equal(result.state, 'cli_activated'); assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(f.bin, 'herdr-relay-remote')), false);
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.candidate, 'src/cli.mjs'));
  await installCliRelease(request, f.dependencies); assert.equal(f.calls.length, 0);
  writeFileSync(join(f.bin, 'herdr-relay-remote'), '# unrelated user wrapper');
  await installCliRelease(request, f.dependencies);
  assert.equal(readFileSync(join(f.bin, 'herdr-relay-remote'), 'utf8'), '# unrelated user wrapper');
});

test('an unfinished operation fences CLI-only activation too', async t => {
  const f = fixture(t), path = join(f.input.directory, 'operations/pending'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'operation.json'), JSON.stringify({ phase: 'switching' }));
  await assert.rejects(installCliRelease({ version: '0.2.0-rc.5', directory: f.input.directory, binDirectory: f.bin }, f.dependencies), { code: 'upgrade_in_progress' });
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.previous, 'src/cli.mjs'));
});

test('pending native forms/permissions block plugin upgrade before any stop, including a decision appearing during the stop window', async t => {
  const f = fixture(t), before = readFileSync(f.serverConfig, 'utf8');
  const blocked = () => { const error = Error('pending decision'); error.code = 'upgrade_pending_decisions'; throw error; };
  f.dependencies.nativeDecisions = blocked;
  await assert.rejects(f.apply(), { code: 'upgrade_pending_decisions' }); assert.equal(f.calls.length, 0);
  let checks = 0;
  f.dependencies.nativeDecisions = async () => { if (++checks === 2) blocked(); return { pendingForms: 0, pendingPermissions: 0 }; };
  await assert.rejects(f.apply(), { code: 'upgrade_rolled_back' });
  assert.equal(readFileSync(f.serverConfig, 'utf8'), before); assert.ok([...f.states.values()].every(s => s.active));
});

test('active and uncertain native turns, pending publications and active backend executions refuse upgrade before stopping anything', async t => {
  for (const state of ['observing', 'uncertain', 'conflict', 'admitted']) {
    const f = fixture(t); f.journal.save({ id: 'work', state, execution: { id: 'work', state: 'accepted' } });
    await assert.rejects(f.apply(), { code: 'upgrade_busy' }); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t); f.journal.queue({ key: 'pending', action: 'task.create', payload: { id: 'task', title: 'Keep' } });
  await assert.rejects(f.apply(), { code: 'upgrade_busy' }); assert.equal(f.calls.length, 0);
  const backend = fixture(t); backend.store.save('execution', { id: 'active', revision: 1, state: 'accepted' });
  await assert.rejects(backend.apply(), { code: 'upgrade_busy' }); assert.equal(backend.calls.length, 0);
});

test('a turn admitted by old code immediately before stop resumes under the original supervisor instead of being discarded', async t => {
  const f = fixture(t);
  f.onStop = () => f.journal.save({ id: 'race', state: 'observing', execution: { id: 'race', state: 'accepted' } });
  await assert.rejects(f.apply(), { code: 'upgrade_rolled_back' });
  assert.ok([...f.states.values()].every(s => s.active)); assert.equal(f.journal.work('race').state, 'observing');
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.previous, 'src/cli.mjs'));
});

test('failed candidate health rolls back service/plugin/CLI pointers without restoring any database', async t => {
  const f = fixture(t), before = readFileSync(f.serverConfig, 'utf8'); f.failHealth = true;
  await assert.rejects(f.apply(), { code: 'upgrade_rolled_back' });
  assert.equal(readFileSync(f.serverConfig, 'utf8'), before);
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.previous, 'src/cli.mjs'));
  assert.ok([...f.states.values()].every(s => s.active));
  assert.equal(f.store.instance, JSON.parse(readFileSync(join(f.node, 'backend-instance.json'))).instanceId);
});

test('work that starts after activation fences rollback without interrupting it, then recorded recovery resumes after settlement', async t => {
  const f = fixture(t); let injected = false;
  f.onHealth = (_service, _unit, paused, required) => {
    if (required && !paused) {
      if (!injected) { f.journal.save({ id: 'new-turn', state: 'observing', execution: { id: 'new-turn', state: 'accepted' } }); injected = true; }
      throw Error('late health failure');
    }
  };
  await assert.rejects(f.apply(), { code: 'upgrade_recovery_required' });
  assert.ok([...f.states.values()].every(s => s.active));
  assert.equal(f.journal.work('new-turn').state, 'observing');
  assert.equal(f.calls.filter(c => c[0] === 'stop').length, 2);
  const operations = join(f.input.directory, 'operations');
  const id = (await import('node:fs')).readdirSync(operations)[0];
  const record = JSON.parse(readFileSync(join(operations, id, 'operation.json')));
  assert.equal(record.phase, 'recovery_required'); assert.equal(record.recoveryAction, 'rollback');
  f.journal.save({ id: 'new-turn', state: 'native_finished', execution: { id: 'new-turn', state: 'completed' }, observation: { state: 'finished', outcome: 'succeeded' } });
  const resumed = await serviceUpgrade({ resume: id, directory: f.input.directory, apply: true }, f.dependencies);
  assert.equal(resumed.state, 'rolled_back'); assert.equal(f.journal.work('new-turn').execution.state, 'completed');
});

test('explicit compatible rollback retains task edits made after upgrade and never restores an old snapshot', async t => {
  const f = fixture(t), result = await f.apply();
  f.store.command(f.owner, { key: 'after-upgrade', action: 'task.create', payload: { id: 'new-work', title: 'Do not erase this' } });
  const rollback = await serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies);
  assert.equal(rollback.state, 'rolled_back'); assert.equal(rollback.databasesRestored, false);
  assert.equal(f.store.get('task', 'new-work').title, 'Do not erase this');
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.previous, 'src/cli.mjs'));
});

test('a turn racing explicit rollback resumes under the unchanged current supervisors instead of remaining frozen', async t => {
  const f = fixture(t), result = await f.apply();
  f.onStop = () => f.journal.save({ id: 'rollback-race', state: 'observing', execution: { id: 'rollback-race', state: 'accepted' } });
  await assert.rejects(serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies), { code: 'upgrade_busy' });
  assert.ok([...f.states.values()].every(s => s.active));
  assert.equal(f.journal.work('rollback-race').state, 'observing');
  assert.equal(existsSync(join(f.node, 'maintenance.json')), false);
  assert.equal(realpathSync(join(f.bin, 'herdr-relay')), join(f.candidate, 'src/cli.mjs'));
});

test('later user configuration edits fence rollback rather than being overwritten', async t => {
  const f = fixture(t), result = await f.apply();
  writeFileSync(f.serverConfig, '// New user edit\n' + readFileSync(f.serverConfig, 'utf8'));
  const calls = f.calls.length;
  await assert.rejects(serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies), { code: 'upgrade_configuration_changed' });
  assert.match(readFileSync(f.serverConfig, 'utf8'), /New user edit/); assert.equal(f.calls.length, calls);
});

test('modified retained release files fence rollback instead of starting changed code', async t => {
  const f = fixture(t), result = await f.apply();
  writeFileSync(join(f.previous, 'src/node-cli.mjs'), '// unexpectedly changed');
  const count = f.calls.length;
  await assert.rejects(serviceUpgrade({ rollback: result.operationId, directory: f.input.directory, apply: true }, f.dependencies), { code: 'release_conflict' });
  assert.equal(f.calls.length, count);
});

test('persisted partial-switch recovery resumes the original operation without reinitialising identities', async t => {
  const f = fixture(t), result = await f.apply();
  const path = join(f.operation(result.operationId), 'operation.json'), record = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ ...record, phase: 'switching' }));
  for (const state of f.states.values()) state.active = false;
  const resumed = await serviceUpgrade({ resume: result.operationId, directory: f.input.directory, apply: true }, f.dependencies);
  assert.equal(resumed.state, 'committed'); assert.equal(f.store.instance, record.services[0].instanceId);
  assert.equal((await serviceUpgrade({ resume: result.operationId, directory: f.input.directory, apply: true }, f.dependencies)).replayed, true);
});

test('incompatible release metadata fails before any service stop and stopped services stay stopped', async t => {
  const f = fixture(t), manifestPath = join(f.candidate, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, relayCompatibility: { ...compatibility, nodeSchema: 2 } }));
  await assert.rejects(f.apply(), { code: 'upgrade_incompatible' }); assert.equal(f.calls.length, 0);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  f.states.get('herdr-relay-node-test-node.service').active = false;
  await f.apply(); assert.equal(f.states.get('herdr-relay-node-test-node.service').active, false);
});
