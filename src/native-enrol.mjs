import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonical, digest, requireValue } from './protocol.mjs';
import { nativeBackendClient } from './backend-client.mjs';
import { NativeOpenCodeV2, checkV2Version } from '../packages/opencode-relay/native.mjs';

// Operator-only configuration. Never starts/restarts OpenCode, changes session
// permissions, adopts a different conversation or exposes a node credential.
export async function enrolInteractive(input, dependencies = {}) {
  requireValue(input.reserved === true && input.configFile && input.sessionId && input.directory,
    'invalid_enrolment', 'Explicit --reserved, config file, exact session and directory are required');
  requireValue(['tools', 'cli'].includes(input.transport ?? 'tools'), 'invalid_worker_transport', 'Choose tools or cli');
  const directory = realpathSync(input.directory);
  const configFile = resolve(input.configFile);
  const discover = dependencies.discover ?? (await import('../packages/opencode-relay/node_modules/@opencode/client/dist/promise/service.js')).Service.discover;
  const endpoint = await discover({ ...(input.serviceRegistration ? { file: input.serviceRegistration } : {}), version: version => {
    try { checkV2Version(version); return true; } catch { return false; }
  } });
  requireValue(endpoint?.auth?.type === 'basic' && endpoint.auth.password, 'native_service_unavailable', 'An authenticated existing OpenCode 2.x service is required');
  const origin = new URL(endpoint.url);
  requireValue(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password,
    'invalid_binding', 'Native service must be authenticated loopback HTTP');
  const makeClient = dependencies.makeClient ?? (await import('../packages/opencode-relay/node_modules/@opencode/client/dist/promise/index.js')).OpenCode.make;
  const client = makeClient({ baseUrl: origin.origin, headers: { authorization:
    `Basic ${Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`).toString('base64')}` },
  fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(15000) }) });
  checkV2Version((await client.server.info()).version);
  const session = await client.session.get({ sessionID: input.sessionId });
  requireValue(session.id === input.sessionId && session.location?.directory === directory, 'native_identity_mismatch', 'Exact session must belong to the selected canonical directory');
  const identity = { sessionId: session.id, projectId: session.projectID, directory, createdAt: session.time.created };
  await new NativeOpenCodeV2(client, identity).verify();
  const suffix = digest(session.id).slice(0, 12);
  const nodeId = `interactive-${suffix}`, agentId = `here-${suffix}`;
  const stateDirectory = dirname(configFile);
  const transport = input.transport ?? 'tools';
  const binding = { id: agentId, agentId, name: 'Interactive Relay chat', mode: 'interactive', harness: 'opencode-v2',
    reserved: true, workerTransport: transport, url: origin.origin, authFile: join(stateDirectory, 'native-auth.json'), identity };
  const existing = existsSync(configFile);
  let config;
  if (existing) {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
    const entry = config.bindings?.find(b => b.agentId === agentId);
    requireValue(config.nodeId === nodeId && config.stateDirectory === stateDirectory && config.backend?.url === input.backend.url &&
      entry?.harness === 'opencode-v2' && entry.id === agentId && entry.reserved === true && entry.mode === 'interactive' &&
      (entry.workerTransport ?? 'tools') === transport && entry.url === origin.origin &&
      canonical(entry.identity) === canonical(identity), 'configuration_conflict', 'Existing node configuration does not match this exact reserved conversation and transport');
    requireValue(JSON.parse(readFileSync(entry.authFile, 'utf8')).password === endpoint.auth.password,
      'native_auth_changed', 'Stored native authentication changed. Explicit reconciliation is required');
  } else {
    const api = input.api;
    await api('POST', '/v1/commands', { key: `enrol:${nodeId}`, action: 'node.enrol', payload: { id: nodeId, name: 'Interactive Relay chat' } });
    const credential = await api('POST', '/v1/node-credentials', { nodeId, key: `credential:${nodeId}` });
    config = { nodeId, stateDirectory, backend: { ...input.backend, token: credential.token }, bindings: [binding] };
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    if (existsSync(binding.authFile)) requireValue(JSON.parse(readFileSync(binding.authFile, 'utf8')).password === endpoint.auth.password,
      'native_auth_changed', 'Refuse replacing an existing native credential');
    else writeFileSync(binding.authFile, JSON.stringify({ password: endpoint.auth.password }), { flag: 'wx', mode: 0o600 });
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  const nodeApi = nativeBackendClient(config.backend);
  let agent;
  try { agent = await nodeApi('GET', `/v1/agents/${encodeURIComponent(agentId)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!agent) agent = await nodeApi('POST', '/v1/commands', { key: `agent-register:${digest([nodeId, agentId])}`, action: 'agent.register',
    payload: { id: agentId, nodeId, name: config.bindings.find(b => b.agentId === agentId).name ?? agentId,
      capabilities: [], mode: 'interactive', directory } });
  requireValue(agent.nodeId === nodeId && agent.mode === 'interactive' && agent.directory === directory &&
    (!agent.conversationId || agent.conversationId === session.id), 'agent_identity_changed', 'Enrolled agent belongs to another scope');
  return { state: existing ? 'existing' : 'enrolled', nodeId, agentId, sessionId: session.id, configFile,
    transport, nativeServiceRestarted: false, permissionsChanged: false, nodeStartManagedSeparately: true,
    advertisedConversationId: agent.conversationId ?? null };
}
