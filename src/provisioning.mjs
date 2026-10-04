import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { launchRuntime } from './runtimes.mjs';
import { OpenCode } from './opencode.mjs';
import { Hermes } from './hermes.mjs';

export async function provisionAgent(store, directory, api, input) {
  const key = text(input.key, 'key');
  const request = { companyId: text(input.companyId, 'companyId'), bindingId: text(input.bindingId, 'bindingId'),
    harness: text(input.harness, 'harness'), directory: resolve(text(input.directory, 'directory')),
    lifetime: input.lifetime ?? 'persistent', controllerBindingId: input.controllerBindingId ?? null,
    taskId: input.taskId ?? null, worktreeKey: input.worktreeKey ?? null,
    model: input.model ?? null, executable: input.executable ?? input.harness };
  requireValue(['opencode', 'hermes'].includes(request.harness), 'invalid_harness', 'Use OpenCode or Hermes');
  const id = `provision:${key}`;
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Provisioning key configuration changed', 409);
    if (operation.state === 'recorded') return operation;
  } else operation = store.saveOperation({ id, runId: '', request, state: 'intent' });
  const name = `Relay ${request.bindingId} ${digest(id).slice(0, 12)}`;
  if (!operation.agentId) {
    const agents = await api('GET', `/api/companies/${encodeURIComponent(request.companyId)}/agents`);
    const matches = agents.filter(agent => agent.name === name);
    requireValue(matches.length <= 1, 'agent_identity_ambiguous', 'Multiple matching provisioning agents', 409);
    let agent = matches[0];
    if (!agent) {
      requireValue(operation.state !== 'agent_uncertain', 'agent_creation_uncertain', 'Agent creation was attempted. Absence does not authorise another create.', 409);
      operation = store.saveOperation({ ...operation, state: 'agent_uncertain' });
      agent = await api('POST', `/api/companies/${encodeURIComponent(request.companyId)}/agents`, {
        name, adapterType: 'herdr_relay', adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
      });
    }
    requireValue(agent.companyId === request.companyId && agent.adapterType === 'herdr_relay' && !agent.reportsTo,
      'agent_identity_mismatch', 'Provisioning identity does not match expected independent Relay agent', 409);
    operation = store.saveOperation({ ...operation, agentId: agent.id, state: 'agent_created' });
  }
  const runtimeKey = `provision-${digest(id).slice(0, 24)}`;
  const runtime = await launchRuntime(store, directory, { key: runtimeKey, directory: request.directory,
    harness: request.harness, executable: request.executable });
  const hermes = request.harness === 'hermes';
  const nativeConfig = { directory: request.directory, runtimeKey, exclusive: true,
    url: hermes ? `ws://127.0.0.1:${runtime.port}/api/ws` : `http://127.0.0.1:${runtime.port}`,
    authFile: join(runtime.directory, hermes ? 'gateway-token' : 'auth.json'),
    ...(hermes ? { runtimeId: operation.runtimeId ?? 'pending', epoch: operation.epoch ?? 'pending' } : {}) };
  const native = hermes ? new Hermes({ hermes: nativeConfig, conversationId: operation.conversationId ?? 'pending' })
    : new OpenCode({ opencode: nativeConfig, conversationId: operation.conversationId ?? 'pending' });
  if (!operation.conversationId) {
    const title = `Relay provision ${digest(id)}`;
    const sessions = hermes ? (await native.request('session.list', { title })).sessions : await native.request('GET', '/session');
    const matches = sessions.filter(session => session.title === title);
    requireValue(matches.length <= 1, 'session_identity_ambiguous', 'Multiple provisioning conversations', 409);
    let session = matches[0];
    if (!session) {
      requireValue(operation.state !== 'session_uncertain', 'session_creation_uncertain', 'Native session creation was attempted. Inspect before another create.', 409);
      operation = store.saveOperation({ ...operation, state: 'session_uncertain' });
      session = hermes ? await native.request('session.create', { title, cwd: request.directory,
        ...(request.model ? { provider: request.model.providerID, model: request.model.modelID } : {}) })
        : await native.request('POST', '/session', { title });
    } else if (hermes) {
      // Explicit stored identity, never a title-selected replacement.
      session = await native.request('session.resume', { session_id: session.id });
    }
    const conversationId = hermes ? session.stored_session_id ?? session.session_key : session.id;
    requireValue(typeof conversationId === 'string', 'session_identity_unproven', 'Native stored session identity required', 409);
    if (hermes) {
      nativeConfig.runtimeId = session.session_id;
      nativeConfig.epoch = (await native.request('session.events.since', { last_seen: 0 })).epoch;
    }
    operation = store.saveOperation({ ...operation, conversationId, state: 'session_created',
      ...(hermes ? { runtimeId: nativeConfig.runtimeId, epoch: nativeConfig.epoch } : { projectID: session.projectID, sessionCreatedAt: session.time.created }) });
  }
  if (!hermes) Object.assign(nativeConfig, { projectID: operation.projectID, sessionCreatedAt: operation.sessionCreatedAt,
    ...(request.model ? { model: request.model } : {}) });
  native.sessionId = operation.conversationId;
  if (!hermes) native.path = `/session/${encodeURIComponent(operation.conversationId)}`;
  await native.verify();
  const binding = store.register({ id: request.bindingId, companyId: request.companyId, agentId: operation.agentId,
    harness: request.harness, instanceId: runtime.nonce, conversationId: operation.conversationId, delivery: request.harness,
    lifetime: request.lifetime, ...(request.controllerBindingId ? { controllerBindingId: request.controllerBindingId } : {}),
    ...(request.taskId ? { taskId: request.taskId } : {}), ...(request.worktreeKey ? { worktreeKey: request.worktreeKey } : {}),
    [request.harness]: nativeConfig }).binding;
  const operatorFile = join(directory, 'adapter-context.json');
  const context = JSON.stringify({ socketPath: join(directory, 'relay.sock'), token: readFileSync(join(directory, 'admin-token'), 'utf8').trim() });
  if (!existsSync(operatorFile)) writeFileSync(operatorFile, context, { flag: 'wx', mode: 0o600 });
  else requireValue(readFileSync(operatorFile, 'utf8') === context, 'context_conflict', 'Adapter context differs from this service');
  const config = { relayContextFile: operatorFile, bindingId: binding.id, bindingRevision: binding.revision };
  await api('PATCH', `/api/agents/${encodeURIComponent(operation.agentId)}`, { adapterConfig: config });
  // A local shared skill is installed only into this explicitly provisioned workspace.
  const skillDirectory = join(request.directory, hermes ? '.hermes/skills/relay-work' : '.opencode/skills/relay-work');
  mkdirSync(skillDirectory, { recursive: true });
  const skill = readFileSync(fileURLToPath(new URL('../skills/relay-work/SKILL.md', import.meta.url)), 'utf8');
  const skillPath = join(skillDirectory, 'SKILL.md');
  if (existsSync(skillPath)) requireValue(readFileSync(skillPath, 'utf8') === skill, 'skill_conflict', 'Existing Relay skill differs. Resolve it explicitly.', 409);
  else writeFileSync(skillPath, skill, { flag: 'wx' });
  return store.saveOperation({ ...operation, state: 'recorded', bindingId: binding.id, runtimeKey, skillPath });
}
