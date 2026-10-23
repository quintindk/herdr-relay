import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, lstatSync, symlinkSync, realpathSync, chmodSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, requireValue, RelayError } from './protocol.mjs';
import { serviceLock } from './service-lock.mjs';
import { parseManagedUnit } from './managed-service-unit.mjs';
import { serviceIdentity, identityFingerprint } from './upgrade-safety.mjs';
import { stageRelease, hashBytes } from './release-install.mjs';
import { releaseInfo, releaseVersion } from './release-info.mjs';
import { readPrivateJson, writePrivateJson } from './private-files.mjs';
import { pluginUpgradeFiles } from './upgrade-plugin.mjs';
import { nativeBackendClient } from './backend-client.mjs';
import { defaultNodeConfig } from './native-onboarding.mjs';
import { assertNoOpenCodeDecisions } from './upgrade-native-decisions.mjs';
import { migrateTaskIdentity } from './task-identity-migration.mjs';

const execute = promisify(execFile);
export const upgradeDirectory = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-upgrades');
const configDirectory = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
const complete = ['committed', 'rolled_back'];
const fileHash = path => hashBytes(readFileSync(path));
const atomicWrite = (path, bytes) => {
  const temporary = `${path}.relay-${randomUUID()}`;
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true }); renameSync(temporary, path);
};
const safeName = name => requireValue(typeof name === 'string' && /^[A-Za-z0-9_-]+\.service$/.test(name), 'invalid_service', 'Exact managed service name required');

export function systemdManager() {
  const command = async (...args) => execute('systemctl', ['--user', ...args], { timeout: 60000, maxBuffer: 1024 * 1024 });
  return {
    async inspect(name) {
      safeName(name);
      const output = await command('show', name, '--property=FragmentPath', '--property=ActiveState', '--property=MainPID');
      const values = Object.fromEntries(output.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
      requireValue(values.FragmentPath && ['active', 'inactive', 'failed'].includes(values.ActiveState), 'service_unavailable', 'Managed service must be active or stopped, not transitioning');
      return { name, path: values.FragmentPath, active: values.ActiveState === 'active', pid: Number(values.MainPID) };
    },
    stop: name => command('stop', name), start: name => command('start', name), reload: () => command('daemon-reload'),
  };
}

function serviceNames(roles, nodeConfig) {
  return roles.map(role => {
    if (role === 'backend') return { role, name: 'herdr-relay-backend.service' };
    const config = readPrivateJson(nodeConfig);
    requireValue(typeof config.nodeId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(config.nodeId), 'invalid_config', 'Existing stable node configuration required');
    return { role, name: `herdr-relay-node-${config.nodeId}.service` };
  });
}

export async function installationStatus({ services = ['backend', 'node'], nodeConfig = defaultNodeConfig() } = {}, dependencies = {}) {
  const manager = dependencies.manager ?? systemdManager(), items = [];
  for (const role of services) {
    try {
      const [{ name }] = serviceNames([role], nodeConfig), service = await manager.inspect(name);
      const unit = parseManagedUnit(readFileSync(service.path, 'utf8'), role), identity = serviceIdentity(unit);
      items.push({ role, service: name, active: service.active, pid: service.pid, version: unit.release.version, versionSource: 'managed_unit',
        installation: unit.release.directory, instanceId: identity.instanceId, ...(identity.nodeId ? { nodeId: identity.nodeId } : {}), blockers: identity.blockers });
    } catch (error) { items.push({ role, installed: false, code: error.code ?? 'service_unavailable' }); }
  }
  return { cliVersion: releaseVersion, services: items };
}

async function databaseBackup(source, destination) {
  if (!existsSync(destination)) {
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, destination); chmodSync(destination, 0o600); } finally { db.close(); }
  }
  const db = new DatabaseSync(destination, { readOnly: true });
  try { requireValue(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'upgrade_backup_failed', 'Backup integrity check failed'); } finally { db.close(); }
}

function ownedCliLink(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = realpathSync(path);
    return basename(target) === 'cli.mjs' && readPrivateJson(join(dirname(dirname(target)), 'package.json')).name === 'herdr-relay';
  } catch { return false; }
}

function cliChange(candidate, binDirectory) {
  const path = binDirectory ? join(resolve(binDirectory), 'herdr-relay') : (process.env.PATH ?? '').split(':').map(dir => join(dir, 'herdr-relay')).find(ownedCliLink);
  requireValue(path && ownedCliLink(path), 'cli_activation_required', 'A recognised herdr-relay CLI symlink on PATH is required. Unrelated wrappers are never overwritten');
  return { path, before: realpathSync(path), after: join(candidate.directory, 'src/cli.mjs') };
}

function activateCli(change, forward) {
  const target = forward ? change.after : change.before, expected = forward ? change.before : change.after;
  requireValue(ownedCliLink(change.path) && [expected, target].includes(realpathSync(change.path)), 'upgrade_configuration_changed', 'CLI link changed after upgrade planning');
  if (realpathSync(change.path) === target) return;
  const temporary = `${change.path}.relay-${randomUUID()}`; symlinkSync(target, temporary); renameSync(temporary, change.path);
  // Remove only the old package-owned executable. No other SSH configuration or
  // credentials are touched; the legacy transport is retired, not silently used.
  if (forward) {
    const retired = join(dirname(change.path), 'herdr-relay-remote');
    try {
      if (lstatSync(retired).isSymbolicLink()) {
        const entry = realpathSync(retired);
        if (basename(entry) === 'remote.mjs' && readPrivateJson(join(dirname(dirname(entry)), 'package.json')).name === 'herdr-relay') unlinkSync(retired);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function installCliRelease(input, dependencies = {}) {
  requireValue(input.artifact ? typeof input.artifact === 'string' && typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.sha256) :
    typeof input.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version), 'invalid_request', 'Choose exact version or artifact plus trusted checksum');
  const root = resolve(input.directory ?? upgradeDirectory()); mkdirSync(root, { recursive: true, mode: 0o700 });
  const unlock = serviceLock(root);
  try {
    const operations = join(root, 'operations');
    const unfinished = existsSync(operations) && readdirSync(operations)
      .filter(name => existsSync(join(operations, name, 'operation.json')))
      .some(name => !complete.includes(readPrivateJson(join(operations, name, 'operation.json')).phase));
    requireValue(!unfinished, 'upgrade_in_progress', 'Resolve the unfinished service upgrade before changing the CLI');
    const candidate = await (dependencies.stageRelease ?? stageRelease)({ version: input.version, artifact: input.artifact,
      sha256: input.sha256, directory: input.releasesDirectory });
    const release = releaseInfo(candidate.directory);
    requireValue(candidate.version === release.version && candidate.auditVerified && (!candidate.packageFingerprint || candidate.packageFingerprint === release.fingerprint),
      'invalid_release', 'Verified compatible release and fresh audit required');
    activateCli(cliChange(candidate, input.binDirectory), true);
    return { state: 'cli_activated', version: candidate.version, installation: candidate.directory, servicesChanged: false,
      instruction: 'The CLI now uses the versioned release. Existing services/plugins remain unchanged until an explicit upgrade.' };
  } finally { unlock(); }
}

function identityCheck(service, originalUnit, { allowBusy = false } = {}) {
  requireValue(originalUnit.release.fingerprint === service.previousFingerprint, 'release_conflict', 'The retained previous release changed. Refuse using modified rollback code');
  const identity = serviceIdentity(originalUnit);
  requireValue(identityFingerprint(identity, service.identityFingerprintVersion ?? 1) === service.identityFingerprint, 'upgrade_identity_changed', 'Service identity/credentials/configuration changed. Refuse recreating or substituting them');
  requireValue(allowBusy || identity.blockers.length === 0, 'upgrade_busy', `Unsettled ${service.role} work prevents upgrade/rollback. Inspect status and retry after settlement`);
  return identity;
}

export async function verifyServiceHealth(service, unit, manager, paused, versionRequired) {
  const state = await manager.inspect(service.name);
  if (!service.active) { requireValue(!state.active, 'upgrade_health_failed', 'A previously stopped service was unexpectedly started'); return; }
  requireValue(state.active, 'upgrade_health_failed', 'Relay service is not active');
  if (service.role === 'backend') {
    const portIndex = unit.args.indexOf('--port'), port = portIndex < 0 ? 3210 : Number(unit.args[portIndex + 1]);
    const context = readPrivateJson(join(unit.statePath, 'owner.json'));
    const info = await nativeBackendClient({ ...context, url: `http://127.0.0.1:${port}` })('GET', '/v1/info');
    requireValue(info.instanceId === service.instanceId && info.protocol === 'relay/0.2' &&
      (info.version ? info.version === unit.release.version : !versionRequired), 'upgrade_health_failed', 'Backend identity, protocol or running release differs');
  } else {
    const path = join(service.stateDirectory, 'runtime.json'), runtime = existsSync(path) ? readPrivateJson(path) : null;
    if (runtime?.pid === state.pid) requireValue(runtime.version === unit.release.version && runtime.nodeId === service.nodeId &&
      runtime.instanceId === service.instanceId && runtime.admissionsPaused === paused, 'upgrade_health_failed', 'Node runtime/version/identity does not match its service');
    else requireValue(!versionRequired, 'upgrade_health_failed', 'Node running release cannot be verified');
  }
}

export async function serviceUpgrade(input, dependencies = {}) {
  requireValue(input.migrateTaskReferences === undefined || typeof input.migrateTaskReferences === 'boolean', 'invalid_request', 'Explicit migration option must be boolean');
  if (input.resume || input.rollback) requireValue(typeof (input.resume ?? input.rollback) === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(input.resume ?? input.rollback), 'invalid_request', 'Exact operation ID required');
  else requireValue(input.artifact ? typeof input.sha256 === 'string' && /^[a-f0-9]{64}$/.test(input.sha256) :
    typeof input.version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version), 'invalid_request', 'Choose exact version or artifact plus trusted checksum');
  const root = resolve(input.directory ?? upgradeDirectory());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const unlock = serviceLock(root), manager = dependencies.manager ?? systemdManager();
  const health = dependencies.health ?? verifyServiceHealth;
  const nativeDecisions = dependencies.nativeDecisions ?? assertNoOpenCodeDecisions;
  const operations = join(root, 'operations'); mkdirSync(operations, { recursive: true, mode: 0o700 });
  let record, operationPath;
  const save = patch => { record = { ...record, ...patch, updatedAt: new Date().toISOString() }; writePrivateJson(join(operationPath, 'operation.json'), record); };
  const originals = () => record.services.map(service => ({ service,
    unit: parseManagedUnit(readFileSync(join(operationPath, service.unitBackup), 'utf8'), service.role) }));
  const migrationCommitted = () => record.migrateTaskReferences && originals().some(({ service, unit }) => service.role === 'backend' &&
    unit.release.compatibility.backendSchema === 1 && serviceIdentity(unit).schema === 2);
  const checkFiles = () => {
    for (const file of record.files) requireValue([file.beforeHash, file.afterHash].includes(fileHash(file.path)),
      'upgrade_configuration_changed', 'Configuration changed after planning. Refuse overwriting later edits');
  };
  const writeFiles = forward => {
    checkFiles();
    for (const file of record.files) {
      const expected = forward ? file.afterHash : file.beforeHash;
      if (fileHash(file.path) !== expected) atomicWrite(file.path, readFileSync(join(operationPath, forward ? file.afterFile : file.beforeFile)));
    }
  };
  const maintenance = enable => {
    for (const service of record.services) {
      const path = join(service.stateDirectory, 'maintenance.json');
      if (existsSync(path)) requireValue(readPrivateJson(path).operationId === record.id, 'upgrade_in_progress', 'Another maintenance operation owns this service');
      if (enable) writePrivateJson(path, { operationId: record.id, reason: 'Versioned Relay service upgrade', createdAt: new Date().toISOString() });
      else if (existsSync(path)) unlinkSync(path);
    }
  };
  const stop = async () => { for (const role of ['node', 'backend']) for (const s of record.services.filter(s => s.role === role)) await manager.stop(s.name); };
  const start = async () => { await manager.reload(); for (const role of ['backend', 'node']) for (const s of record.services.filter(s => s.role === role && s.active)) await manager.start(s.name); };
  const checkHealth = async (forward, paused) => {
    for (const service of record.services) {
      const unit = parseManagedUnit(readFileSync(service.unitPath, 'utf8'), service.role);
      requireValue(!forward || unit.release.fingerprint === record.candidateFingerprint, 'release_conflict', 'Candidate package content changed after verification');
      let last;
      for (let attempt = 0; attempt < (dependencies.healthAttempts ?? 40); attempt++) {
        try { await health(service, unit, manager, paused, forward); last = null; break; }
        catch (error) { last = error; await delay(dependencies.healthDelay ?? 250); }
      }
      if (last) throw new RelayError('upgrade_health_failed', `${service.role} health verification failed; original state is retained`, 503);
      const original = originals().find(item => item.service.role === service.role).unit;
      const identity = serviceIdentity(original);
      requireValue(identityFingerprint(identity, service.identityFingerprintVersion ?? 1) === service.identityFingerprint, 'upgrade_identity_changed', 'Upgrade changed identity, credentials or node configuration');
    }
  };
  const rollback = async () => {
    checkFiles();
    const startingPhase = record.phase, unchangedFiles = record.files.map(file => fileHash(file.path));
    const beforeSwitch = (record.phase === 'stopping' || record.phase === 'rolling_back' && record.rollbackBeforeSwitch) &&
      record.files.every(file => fileHash(file.path) === file.beforeHash) && realpathSync(record.cli.path) === record.cli.before;
    for (const { service, unit } of originals()) {
      releaseInfo(unit.release.directory);
      const identity = identityCheck(service, unit, { allowBusy: beforeSwitch });
      requireValue(identity.schema === unit.release.compatibility[service.role === 'backend' ? 'backendSchema' : 'nodeSchema'],
        'upgrade_incompatible', 'Rollback writer does not support the current database schema. No database will be restored');
    }
    const reloadPlugin = record.files.some(file => file.kind === 'plugin' && fileHash(file.path) !== file.beforeHash);
    if (reloadPlugin) await nativeDecisions({ nodeConfig: record.nodeConfig, configDirectory: record.configDirectory });
    save({ phase: 'rolling_back', rollbackBeforeSwitch: beforeSwitch }); maintenance(true); await stop();
    try {
      for (const { service, unit } of originals()) {
        const identity = identityCheck(service, unit, { allowBusy: beforeSwitch });
        requireValue(identity.schema === unit.release.compatibility[service.role === 'backend' ? 'backendSchema' : 'nodeSchema'],
          'upgrade_incompatible', 'Rollback writer is incompatible with the current database schema');
      }
      if (reloadPlugin) await nativeDecisions({ nodeConfig: record.nodeConfig, configDirectory: record.configDirectory });
    } catch (error) {
      if (!beforeSwitch && ['upgrade_busy', 'upgrade_pending_decisions'].includes(error.code)) {
        requireValue(record.files.every((file, i) => fileHash(file.path) === unchangedFiles[i]), 'upgrade_configuration_changed', 'Rollback configuration changed while stopping');
        // Nothing has been reverted yet. Restore the current supervisors so a
        // racing turn/decision can settle, instead of freezing it behind maintenance.
        maintenance(false); await start();
        save({ phase: startingPhase === 'committed' ? 'committed' : 'recovery_required', recoveryAction: 'rollback', rollbackFailureCode: error.code });
        throw new RelayError(error.code, 'Rollback was refused after a racing turn/decision appeared. Current service/configuration pointers were retained and supervisors restarted. Retry after settlement', 409);
      }
      throw error;
    }
    for (const service of record.services) await databaseBackup(service.database, join(operationPath, `${service.role}-before-rollback.sqlite`));
    writeFiles(false); activateCli(record.cli, false);
    // If old code admitted a turn just before stopping, resume that same
    // supervisor rather than leaving live native work unsupervised.
    if (beforeSwitch) maintenance(false);
    await start(); await checkHealth(false, !beforeSwitch);
    maintenance(false); await checkHealth(false, false); save({ phase: 'rolled_back', databasesRestored: false });
  };
  try {
    if (input.resume || input.rollback) {
      const id = input.resume ?? input.rollback;
      requireValue(typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id), 'invalid_request', 'Exact operation ID required');
      operationPath = join(operations, id); record = readPrivateJson(join(operationPath, 'operation.json'));
      requireValue(record.id === id, 'invalid_upgrade_record', 'Operation identity mismatch');
      if (input.rollback) {
        for (const { service, unit } of originals()) requireValue(serviceIdentity(unit).schema === unit.release.compatibility[service.role === 'backend' ? 'backendSchema' : 'nodeSchema'],
          'upgrade_incompatible', 'Rollback writer does not support the current database schema. No database will be restored');
        if (!input.apply) return { state: 'rollback_plan', operationId: id, services: record.services.map(s => ({ role: s.role, version: s.previousVersion })), databaseRestore: false };
        if (record.phase !== 'rolled_back') await rollback();
        return { state: 'rolled_back', operationId: id, databasesRestored: false };
      }
      if (complete.includes(record.phase)) return { state: record.phase, operationId: id, replayed: true };
      requireValue(input.apply, 'invalid_request', 'Resuming a stopped/switched operation requires --apply');
    } else {
      const roles = input.services ?? ['node'];
      requireValue(Array.isArray(roles) && roles.length > 0 && roles.every(r => ['backend', 'node'].includes(r)) && new Set(roles).size === roles.length,
        'invalid_request', 'Choose node, backend or both');
      requireValue(!input.migrateTaskReferences || roles.includes('backend'), 'invalid_request', 'Task-reference migration requires the backend service');
      const nodeConfig = resolve(input.nodeConfig ?? defaultNodeConfig());
      const key = input.key ?? randomUUID();
      requireValue(typeof key === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(key), 'invalid_request', 'Bounded immutable upgrade key required');
      const id = `upgrade_${digest(key).slice(0, 32)}`;
      const requestHash = digest({ roles: [...roles].sort(), version: input.version ?? null, artifact: input.artifact ? resolve(input.artifact) : null,
        sha256: input.sha256 ?? null, nodeConfig, binDirectory: input.binDirectory ? resolve(input.binDirectory) : null,
        configDirectory: resolve(input.configDirectory ?? configDirectory()), releasesDirectory: input.releasesDirectory ? resolve(input.releasesDirectory) : null,
        ...(input.migrateTaskReferences ? { migrateTaskReferences: true } : {}) });
      operationPath = join(operations, id);
      if (existsSync(join(operationPath, 'operation.json'))) {
        record = readPrivateJson(join(operationPath, 'operation.json'));
        requireValue(record.requestHash === requestHash, 'operation_conflict', 'Upgrade key belongs to another request');
        return { state: record.phase, operationId: id, replayed: true, instruction: complete.includes(record.phase) ? 'No change performed' : 'Use upgrade resume OPERATION --apply to reconcile this exact operation' };
      }
      const pending = readdirSync(operations).filter(name => existsSync(join(operations, name, 'operation.json')))
        .map(name => readPrivateJson(join(operations, name, 'operation.json'))).find(item => !complete.includes(item.phase));
      requireValue(!pending, 'upgrade_in_progress', 'An unfinished upgrade requires resume or rollback before starting another');
      const services = [], files = [];
      for (const { role, name } of serviceNames(roles, nodeConfig)) {
        const current = await manager.inspect(name), before = readFileSync(current.path), unit = parseManagedUnit(before.toString(), role), identity = serviceIdentity(unit);
        requireValue(identity.blockers.length === 0, 'upgrade_busy', `Unsettled ${role} work prevents upgrade. Run ${role} status and retry after settlement`);
        const descriptor = { role, name, unitPath: current.path, active: current.active, previousVersion: unit.release.version,
          previousDirectory: unit.release.directory, previousFingerprint: unit.release.fingerprint, database: identity.database, stateDirectory: identity.stateDirectory,
          instanceId: identity.instanceId, schema: identity.schema, nodeId: identity.nodeId ?? null, identityFingerprintVersion: 2, identityFingerprint: identityFingerprint(identity), identityFiles: identity.files };
        await health(descriptor, unit, manager, false, unit.release.version !== '0.2.0-rc.4');
        services.push(descriptor);
        files.push({ path: current.path, before, kind: 'unit', role, unit });
      }
      if (input.version && services.every(service => service.previousVersion === input.version &&
        (!input.migrateTaskReferences || service.role !== 'backend' || service.schema === 2))) return { state: 'unchanged', version: input.version, services: roles };
      const candidate = await (dependencies.stageRelease ?? stageRelease)({ version: input.version, artifact: input.artifact, sha256: input.sha256, directory: input.releasesDirectory });
      const validated = releaseInfo(candidate.directory);
      requireValue(candidate.version === validated.version && candidate.auditVerified, 'invalid_release', 'A verified compatible candidate and production audit are required');
      requireValue(!candidate.packageFingerprint || candidate.packageFingerprint === validated.fingerprint, 'release_conflict', 'Candidate package content differs from its verification receipt');
      for (const file of files) {
        const identity = serviceIdentity(file.unit);
        const explicitMigration = input.migrateTaskReferences === true && file.role === 'backend' && identity.schema === 1 && validated.compatibility.backendSchema === 2;
        requireValue(explicitMigration || identity.schema === validated.compatibility[file.role === 'backend' ? 'backendSchema' : 'nodeSchema'],
          'upgrade_incompatible', 'Service database and candidate schema differ. An explicit offline migration is required, never an automatic restore');
      }
      requireValue(!input.migrateTaskReferences || services.some(service => service.role === 'backend'), 'invalid_request', 'Task-reference migration requires the backend service');
      for (const file of files) file.after = Buffer.from(file.unit.replace(candidate.directory));
      if (roles.includes('node')) files.push(...pluginUpgradeFiles(resolve(input.configDirectory ?? configDirectory()), candidate.directory));
      const decisionCheck = files.some(file => file.kind === 'plugin') ? await nativeDecisions({ nodeConfig, configDirectory: resolve(input.configDirectory ?? configDirectory()) }) : null;
      const cli = cliChange(candidate, input.binDirectory);
      const plan = { state: 'upgrade_plan', operationId: id, key, targetVersion: candidate.version,
        services: services.map(s => ({ role: s.role, from: s.previousVersion, to: candidate.version, restart: s.active })),
        pluginConfigurationReload: files.some(f => f.kind === 'plugin'), pendingDecisionCheck: decisionCheck, preservesIdentityAndState: true, databaseRestore: false,
        taskReferenceMigration: input.migrateTaskReferences === true, rollbackToSchema1AllowedAfterMigration: false,
        instruction: 'Add --apply with the same arguments/key. Release staging is complete; no services or live configuration were changed.' };
      if (!input.apply) return plan;
      mkdirSync(operationPath, { mode: 0o700 });
      const plannedFiles = files.map((file, index) => {
        const beforeFile = `${index}-before`, afterFile = `${index}-after`;
        writeFileSync(join(operationPath, beforeFile), file.before, { flag: 'wx', mode: 0o600, flush: true });
        writeFileSync(join(operationPath, afterFile), file.after, { flag: 'wx', mode: 0o600, flush: true });
        return { path: file.path, kind: file.kind, role: file.role, beforeFile, afterFile, beforeHash: hashBytes(file.before), afterHash: hashBytes(file.after) };
      });
      for (const service of services) service.unitBackup = plannedFiles.find(f => f.path === service.unitPath).beforeFile;
      record = { id, key, requestHash, phase: 'prepared', version: candidate.version, candidateDirectory: candidate.directory, candidateFingerprint: validated.fingerprint,
        migrateTaskReferences: input.migrateTaskReferences === true,
        services, files: plannedFiles, cli, nodeConfig, configDirectory: resolve(input.configDirectory ?? configDirectory()), createdAt: new Date().toISOString() };
      save({});
    }
    if (record.phase === 'rolling_back' || record.phase === 'recovery_required' && record.recoveryAction !== 'resume') {
      await rollback(); return { state: record.phase, operationId: record.id, databasesRestored: false };
    }
    try {
      requireValue(releaseInfo(record.candidateDirectory).fingerprint === record.candidateFingerprint, 'release_conflict', 'Candidate package content changed. Refuse resuming with modified code');
      if (record.phase === 'recovery_required' && record.resumePhase === 'activating') save({ phase: 'activating' });
      if (record.phase !== 'activating') {
        checkFiles(); maintenance(true); save({ phase: 'stopping' }); await stop();
        for (const { service, unit } of originals()) {
          identityCheck(service, unit);
          await databaseBackup(service.database, join(operationPath, `${service.role}-before-upgrade.sqlite`));
          for (const [index, path] of service.identityFiles.entries()) {
            const target = join(operationPath, `${service.role}-identity-${index}`);
            if (!existsSync(target)) writeFileSync(target, readFileSync(path), { flag: 'wx', mode: 0o600, flush: true });
          }
        }
        if (record.files.some(file => file.kind === 'plugin')) await nativeDecisions({ nodeConfig: record.nodeConfig, configDirectory: record.configDirectory });
        if (record.migrateTaskReferences) for (const { service, unit } of originals().filter(({ service }) => service.role === 'backend')) {
          const unlockState = serviceLock(service.stateDirectory);
          try {
            const identity = serviceIdentity(unit);
            if (identity.schema === 1) {
              let index = 0, path;
              do { path = join(operationPath, `backend-task-identity-${++index}.sqlite`); } while (existsSync(path));
              save({ migrationBackup: path });
              const receipt = migrateTaskIdentity(service.database, { backup: path });
              save({ migration: receipt });
            } else if (unit.release.compatibility.backendSchema === 1) {
              const db = new DatabaseSync(service.database, { readOnly: true });
              let receipt;
              try { receipt = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='task-identity-migration'").get()?.value ?? 'null'); } finally { db.close(); }
              requireValue(receipt?.backup === record.migrationBackup && receipt.instanceId === service.instanceId,
                'upgrade_migration_conflict', 'Migrated state must match this exact upgrade and backup');
              requireValue(existsSync(receipt.backup) && hashBytes(readFileSync(receipt.backup)) === receipt.backupSha256,
                'upgrade_migration_conflict', 'Retained migration backup must match its original verified hash');
              save({ migration: receipt });
            }
          } finally { unlockState(); }
        }
        save({ phase: 'switching' }); writeFiles(true); await start(); await checkHealth(true, true);
        activateCli(record.cli, true); save({ phase: 'activating' });
      }
      maintenance(false); await checkHealth(true, false);
      save({ phase: 'committed', databasesRestored: false });
      return { state: 'committed', operationId: record.id, version: record.version,
        services: record.services.map(s => s.role), identitiesPreserved: true, backups: operationPath, databasesRestored: false };
    } catch (error) {
      save({ failureCode: error.code ?? 'upgrade_failed' });
      if (migrationCommitted()) {
        // Old writers cannot consume schema 2. Retain the exact candidate and
        // maintenance record for roll-forward recovery, never database time travel.
        const resumePhase = record.phase === 'activating' ? 'activating' : 'stopping';
        maintenance(true); save({ phase: 'recovery_required', recoveryAction: 'resume', resumePhase });
        throw new RelayError('upgrade_recovery_required', `Upgrade ${record.id} requires roll-forward recovery with upgrade resume --apply. Schema 2 is committed. No database was restored`, 503);
      }
      try { await rollback(); }
      catch (rollbackError) { save({ phase: 'recovery_required', recoveryAction: 'rollback', rollbackFailureCode: rollbackError.code ?? 'rollback_failed' });
        throw new RelayError('upgrade_recovery_required', `Upgrade ${record.id} needs explicit recovery. No database was restored. Inspect upgrade status`, 503); }
      throw new RelayError('upgrade_rolled_back', `Upgrade ${record.id} failed health/safety checks and restored the previous service/configuration. Databases were not restored`, 503);
    }
  } finally { unlock(); }
}
