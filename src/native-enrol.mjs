import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { requireValue, digest } from './protocol.mjs';
import { NativeOpenCodeV2, checkV2Version } from '../packages/opencode-relay/native.mjs';
import { NodeJournal } from './node-journal.mjs';
import { NativeReceivers } from './native-receivers.mjs';
import { canonicalDirectory } from './interactive-contract.mjs';
import { writePrivateJson as writePrivate } from './private-files.mjs';

export const nativeNodeConfig = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-native/node.json');

export function configureInteractiveNode({ configFile = nativeNodeConfig(), policy }) {
  requireValue(policy && typeof policy === 'object' && !Array.isArray(policy) && Object.keys(policy).every(k =>
    ['mode', 'roots', 'herdrSocketPath', 'serviceRegistration', 'allowNewEnrolments', 'allowCreateDirectories', 'allowReplacement', 'profiles', 'maxAgents', 'environment', 'model'].includes(k)),
    'invalid_policy', 'Only explicit interactive node policy fields are supported');
  requireValue(['roots', 'localUser'].includes(policy.mode) && canonicalDirectory(policy.herdrSocketPath) &&
    (policy.mode === 'localUser' ? !policy.roots?.length : Array.isArray(policy.roots) && policy.roots.length > 0 &&
      policy.roots.length <= 32 && policy.roots.every(p => canonicalDirectory(p) && realpathSync(p) === p)),
    'invalid_policy', 'Explicit Herdr socket and canonical directory scope required');
  for (const k of ['allowNewEnrolments', 'allowCreateDirectories', 'allowReplacement']) requireValue(policy[k] === undefined || typeof policy[k] === 'boolean', 'invalid_policy', 'Permissions must be boolean');
  requireValue(Number.isSafeInteger(policy.maxAgents ?? 10) && (policy.maxAgents ?? 10) > 0 && (policy.maxAgents ?? 10) <= 100 &&
    (policy.profiles === undefined || Array.isArray(policy.profiles) && policy.profiles.length > 0 && policy.profiles.every(p => typeof p === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p))),
    'invalid_policy', 'Bounded agent limit and native profiles required');
  if (policy.serviceRegistration) requireValue(canonicalDirectory(policy.serviceRegistration), 'invalid_policy', 'Absolute native service registration required');
  if (policy.model) requireValue(typeof policy.model.providerID === 'string' && typeof policy.model.id === 'string' &&
    Object.keys(policy.model).every(k => ['providerID', 'id', 'variant'].includes(k)) && (!policy.model.variant || typeof policy.model.variant === 'string'),
    'invalid_policy', 'Explicit native model reference required');
  if (policy.environment) requireValue(typeof policy.environment === 'object' && !Array.isArray(policy.environment) &&
    Object.values(policy.environment).every(v => typeof v === 'string'), 'invalid_policy', 'Node-controlled environment must contain only strings');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  requireValue(config.identityVersion === 2, 'configuration_conflict', 'Stable node installation required');
  if (digest(config.interactive ?? null) === digest(policy)) return { state: 'existing', nodeId: config.nodeId, restartRequired: false };
  writePrivate(configFile, { ...config, interactive: policy });
  return { state: 'configured', nodeId: config.nodeId, restartRequired: true, nativePermissionsChanged: false };
}

export async function nativeConnection(input, dependencies = {}) {
  const discover = dependencies.discover ?? (await import('@opencode/client/service')).Service.discover;
  const endpoint = await discover({ ...(input.serviceRegistration ? { file: input.serviceRegistration } : {}), version: version => {
    try { checkV2Version(version); return true; } catch { return false; }
  } });
  requireValue(endpoint?.auth?.type === 'basic' && endpoint.auth.username === 'opencode' && endpoint.auth.password,
    'native_service_unavailable', 'An authenticated existing OpenCode 2.x service is required');
  const origin = new URL(endpoint.url);
  requireValue(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password,
    'invalid_binding', 'Native service must be authenticated loopback HTTP');
  const makeClient = dependencies.makeClient ?? (await import('@opencode/client')).OpenCode.make;
  const client = makeClient({ baseUrl: origin.origin, headers: { authorization:
    `Basic ${Buffer.from(`opencode:${endpoint.auth.password}`).toString('base64')}` },
  fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(15000) }) });
  checkV2Version((await client.server.info()).version);
  return { client, url: origin.origin, password: endpoint.auth.password };
}

async function nativeSession(input, dependencies) {
  const directory = realpathSync(input.directory);
  const connection = await nativeConnection(input, dependencies);
  const { client } = connection;
  const session = await client.session.get({ sessionID: input.sessionId });
  requireValue(session.id === input.sessionId && session.location?.directory === directory, 'native_identity_mismatch', 'Exact session must belong to the selected canonical directory');
  const identity = { sessionId: session.id, projectId: session.projectID, directory, createdAt: session.time.created };
  await new NativeOpenCodeV2(client, identity).verify();
  return { ...connection, identity };
}

function openRegistry(config, instanceId) {
  const journal = new NodeJournal(join(config.stateDirectory, 'node.sqlite'), { nodeId: config.nodeId, instanceId });
  return { journal, receivers: new NativeReceivers(journal) };
}

// One machine installation, many durable workspace/role agents. Identity is saved
// BEFORE credential issuance so a lost reply never creates another node or agent.
export async function enrolInteractive(input, dependencies = {}) {
  requireValue(input.reserved === true && input.sessionId && input.directory && input.api && input.backend,
    'invalid_enrolment', 'Explicit standing reservation, owner context and exact native session required');
  const transport = input.transport ?? 'tools';
  requireValue(['tools', 'cli'].includes(transport), 'invalid_worker_transport', 'Choose tools or cli');
  const configFile = resolve(input.configFile ?? nativeNodeConfig());
  if (input.key && existsSync(configFile)) {
    const previousConfig = JSON.parse(readFileSync(configFile, 'utf8'));
    requireValue(previousConfig.identityVersion === 2 && previousConfig.backend.url === input.backend.url,
      'configuration_conflict', 'Stable-node config and matching backend required');
    const previousInfo = await input.api('GET', '/v1/info');
    const { journal, receivers } = openRegistry(previousConfig, previousInfo.instanceId);
    let operation;
    try {
      operation = receivers.get(`attachment:${input.key}`);
      if (operation) {
        const enrolment = receivers.get(`enrolment:${operation.binding.agentId}`);
        requireValue(enrolment?.name === (input.name ?? basename(realpathSync(input.directory))) && enrolment.transport === transport,
          'operation_conflict', 'Enrolment retry must retain its original name and grant');
      }
    } finally { journal.close(); }
    if (operation) {
      const attachment = await attachInteractive({ ...input, configFile, agentId: operation.binding.agentId,
        expectedGeneration: input.expectedGeneration ?? 0 }, dependencies);
      return { ...attachment, state: 'existing', transport, nativeServiceRestarted: false, permissionsChanged: false, nodeStartManagedSeparately: true };
    }
  }
  const native = await nativeSession(input, dependencies);
  const stateDirectory = dirname(configFile);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  let config;
  if (!existsSync(configFile)) {
    config = { identityVersion: 2, nodeId: `node_${randomUUID()}`, stateDirectory, backend: { ...input.backend }, bindings: [] };
    // Exclusive creation lets another enrolling TUI win without losing its identity.
    try { writePrivate(configFile, config, true); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  config = JSON.parse(readFileSync(configFile, 'utf8'));
  requireValue(config.identityVersion === 2 && config.stateDirectory === stateDirectory && config.backend.url === input.backend.url,
    'configuration_conflict', 'Use a clean stable-node config. Session-derived development enrolments are not migrated');
  const info = await input.api('GET', '/v1/info');
  if (!config.backend.token) {
    await input.api('POST', '/v1/commands', { key: `enrol:${config.nodeId}`, action: 'node.enrol', payload: { id: config.nodeId, name: 'Local Relay installation' } });
    const credential = await input.api('POST', '/v1/node-credentials', { nodeId: config.nodeId, key: `credential:${config.nodeId}` });
    config = { ...config, backend: { ...input.backend, token: credential.token } };
    writePrivate(configFile, config);
  }
  const { journal, receivers } = openRegistry(config, info.instanceId);
  let enrolment, existed;
  try {
    const name = input.name ?? basename(native.identity.directory);
    requireValue(typeof name === 'string' && name.trim() && name.length <= 256, 'invalid_enrolment', 'Bounded agent name required');
    existed = receivers.list('enrolment').some(e => e.directory === native.identity.directory && e.name === name);
    enrolment = receivers.enrol({ directory: native.identity.directory, name, transport });
    await input.api('POST', '/v1/commands', { key: `standing:${enrolment.id}`, action: 'agent.enrol',
      payload: { id: enrolment.id, nodeId: config.nodeId, name, directory: native.identity.directory } });
  } finally { journal.close(); }
  const attachment = await attachInteractive({ ...input, configFile, agentId: enrolment.id,
    key: input.key ?? `enrol-${digest([enrolment.id, input.sessionId])}`, expectedGeneration: input.expectedGeneration ?? 0 }, dependencies);
  return { ...attachment, state: existed ? 'existing' : 'enrolled', transport,
    nativeServiceRestarted: false, permissionsChanged: false, nodeStartManagedSeparately: true };
}

export async function listEnrolments({ configFile = nativeNodeConfig(), directory, api }) {
  if (!existsSync(configFile)) return [];
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  requireValue(config.identityVersion === 2, 'configuration_conflict', 'Stable-node enrolment required');
  const info = await api('GET', '/v1/info');
  const { journal, receivers } = openRegistry(config, info.instanceId);
  try {
    return receivers.list('enrolment').filter(e => !directory || e.directory === realpathSync(directory)).map(e => {
      const receiver = receivers.receiver(e.id);
      const binding = receiver && receivers.get(`native-binding:${receiver.bindingId}`);
      const schedules = journal.db.prepare('SELECT data FROM schedules').all().map(row => JSON.parse(row.data))
        .filter(s => s.definition.targetAgentId === e.id);
      const obligations = journal.works().filter(w => w.state !== 'administratively_abandoned' && w.execution.targetAgentId === e.id &&
        !['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state));
      return { ...e, nodeId: config.nodeId, receiver: receiver ? { ...receiver, conversationId: binding?.identity.sessionId } : null,
        installedSchedules: schedules.length, obligations: obligations.map(w => ({ id: w.id, state: w.execution.state,
          conversationId: w.nativeConversationId, recovery: w.recovery ?? null })) };
    });
  } finally { journal.close(); }
}

export async function attachInteractive(input, dependencies = {}) {
  requireValue(input.api && input.sessionId && input.directory && input.agentId && typeof input.key === 'string' && input.key.length > 0 && input.key.length <= 180,
    'invalid_attachment', 'Existing enrolment, exact session and stable operation key required');
  const configFile = resolve(input.configFile ?? nativeNodeConfig());
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  requireValue(config.identityVersion === 2, 'configuration_conflict', 'Stable-node enrolment required');
  if (input.backend) requireValue(config.backend.url === input.backend.url, 'backend_identity_mismatch', 'Owner context belongs to another backend');
  const info = await input.api('GET', '/v1/info');
  const { journal, receivers } = openRegistry(config, info.instanceId);
  try {
    let operation = receivers.get(`attachment:${input.key}`);
    if (operation) {
      // Reconcile original confirmed intent even when its native chat has since
      // been archived or the service endpoint has changed. Never rediscover a
      // replacement and silently mutate the original command under its key.
      requireValue(operation.binding.agentId === input.agentId && operation.binding.identity.sessionId === input.sessionId &&
        operation.binding.identity.directory === realpathSync(input.directory) && operation.expectedGeneration === input.expectedGeneration,
        'operation_conflict', 'Attachment key has a different confirmed scope');
    } else {
      const native = await nativeSession(input, dependencies);
      const authFile = join(config.stateDirectory, `native-auth-${digest([native.url, native.password])}.json`);
      if (!existsSync(authFile)) {
        try { writePrivate(authFile, { password: native.password }, true); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      operation = receivers.prepare({ agentId: input.agentId, identity: native.identity, url: native.url, authFile,
        expectedGeneration: input.expectedGeneration, key: input.key });
    }
    requireValue(operation.state !== 'refused', 'attachment_refused', 'This attachment was definitively refused. Inspect and confirm a new claim', 409);
    if (operation.state === 'pending') {
      let receipt;
      try { receipt = await input.api('POST', '/v1/commands', operation.command); }
      catch (error) {
        if ([400, 403, 404, 409].includes(error.status)) {
          // A native-backend refusal is atomic. Read its current designation
          // before restoring the old receiver, never roll back a lost reply.
          const agent = await input.api('GET', `/v1/agents/${encodeURIComponent(input.agentId)}`);
          receivers.reject(operation, error, agent);
          requireValue(false, 'attachment_refused', `Backend refused attachment (${error.code}). Inspect and confirm a new claim`, 409);
        }
        throw error;
      }
      receivers.confirm(operation, receipt);
    }
    const current = receivers.receiver(input.agentId);
    requireValue(current.state === 'active' && current.bindingId === operation.binding.id,
      'attachment_superseded', 'This attachment was replaced. Do not reclaim it by retrying', 409);
    return { state: operation.state === 'existing' ? 'existing' : 'attached', agentId: input.agentId, nodeId: config.nodeId,
      agentName: receivers.get(`enrolment:${input.agentId}`).name, directory: operation.binding.identity.directory,
      sessionId: operation.binding.identity.sessionId, bindingId: operation.binding.id, generation: current.generation,
      nativeUrl: operation.binding.url, configFile };
  } finally { journal.close(); }
}

// Explicit launch intent, suitable for a Herdr workspace command. It creates a
// fresh root chat and attaches it before opening a TUI. It never chooses a chat
// from recency or discovery. Stable native IDs make lost create replies safe.
export async function launchInteractive(input, dependencies = {}) {
  requireValue(input.api && typeof input.key === 'string' && input.key.length > 0 && input.key.length <= 180,
    'invalid_launch', 'Owner context and stable launch key required');
  const enrolments = await listEnrolments(input);
  const candidates = enrolments.filter(e => (!input.agentId || input.agentId === e.id));
  requireValue(candidates.length === 1, 'enrolment_ambiguous', 'Select one enrolled agent in this workspace. Never infer from names or recency');
  const enrolment = candidates[0];
  const configFile = resolve(input.configFile ?? nativeNodeConfig());
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const info = await input.api('GET', '/v1/info');
  const { journal, receivers } = openRegistry(config, info.instanceId);
  let launch;
  try {
    launch = journal.transaction(() => {
      const key = `native-launch:${input.key}`;
      const previous = receivers.get(key);
      if (previous) {
        requireValue(previous.agentId === enrolment.id, 'operation_conflict', 'Launch key belongs to another agent');
        return previous;
      }
      return receivers.put(key, { agentId: enrolment.id, sessionId: `ses_${digest([config.nodeId, input.key]).slice(0, 26)}`,
        generation: enrolment.receiver?.generation ?? 0 });
    });
  } finally { journal.close(); }
  const { client } = await nativeConnection(input, dependencies);
  let session;
  try { session = await client.session.get({ sessionID: launch.sessionId }); }
  catch (error) { if (error.status !== 404 && !['NotFoundError', 'SessionNotFoundError'].includes(error.name)) throw error; }
  if (!session) session = await client.session.create({ id: launch.sessionId, location: { directory: enrolment.directory },
    title: enrolment.name, metadata: { relayLaunchKey: input.key, relayAgentId: enrolment.id } });
  requireValue(session.id === launch.sessionId && session.metadata?.relayLaunchKey === input.key && session.metadata?.relayAgentId === enrolment.id,
    'native_identity_mismatch', 'Native launch identity does not match original intent');
  return attachInteractive({ ...input, configFile, agentId: enrolment.id, directory: enrolment.directory, sessionId: session.id,
    expectedGeneration: launch.generation, key: `launch-${digest([enrolment.id, input.key])}` }, dependencies);
}
