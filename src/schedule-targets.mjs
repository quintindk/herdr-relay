import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { persistentRoutineScope } from './persistent-routines.mjs';

const single = (value, name, max = 240) => {
  value = text(value, name).trim();
  requireValue(value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value), 'invalid_request', `${name} must be bounded single-line text`);
  return value;
};

const receipt = operation => ({ operationId: operation.id, state: operation.state,
  agentId: operation.agentId ?? null, name: operation.request.name, adapterType: 'opencode_local',
  status: operation.receipt?.status ?? null, ready: operation.state === 'recorded' });

export async function createScheduleTarget(store, api, config, input, authority, check = () => {}) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['key', 'name', 'directory', 'model', 'instructions'].includes(key)),
  'invalid_request', 'Unsupported schedule target field');
  const directory = resolve(text(input.directory, 'directory'));
  persistentRoutineScope(store, config, config.companyId, directory);
  const model = single(input.model, 'model');
  requireValue(/^[^/\s]+\/.+$/.test(model), 'invalid_request', 'model must use provider/model form');
  const instructions = text(input.instructions, 'instructions');
  requireValue(instructions.length <= 65536, 'invalid_request', 'instructions are too large');
  const request = { companyId: config.companyId, key: single(input.key, 'key'), name: single(input.name, 'name', 120),
    directory, model, instructionsDigest: digest(instructions) };
  const owner = authority.kind === 'native'
    ? { kind: 'native', bindingId: authority.bindingId, conversationId: authority.conversationId, sessionCreatedAt: authority.sessionCreatedAt }
    : { kind: 'operator' };
  const id = `schedule-target:${digest([request.companyId, owner, request.key])}`;
  await check();
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request) && canonical(operation.authority) === canonical(owner),
      'operation_conflict', 'Schedule target key has another request or authority', 409);
    if (operation.state === 'recorded') return receipt(operation);
  } else operation = store.transaction(() => store.operation(id) ?? store.saveOperation({ id, runId: '', state: 'intent',
    request, authority: owner, marker: randomBytes(32).toString('hex'), instructions }));

  const agents = await api('GET', `/api/companies/${encodeURIComponent(request.companyId)}/agents`);
  await check();
  requireValue(Array.isArray(agents), 'invalid_backend_response', 'Expected Paperclip agents array', 502);
  const matches = agents.filter(agent => agent.metadata?.herdrRelayScheduleTargetMarker === operation.marker);
  requireValue(matches.length <= 1, 'schedule_target_marker_conflict', 'Schedule target marker is ambiguous', 409);
  let agent = matches[0];
  if (!agent) {
    requireValue(operation.state === 'intent', 'operation_uncertain', 'Agent creation was attempted; absence does not authorise another POST', 409);
    operation = store.saveOperation({ ...operation, state: 'uncertain', sent: true });
    await check();
    agent = await api('POST', `/api/companies/${encodeURIComponent(request.companyId)}/agents`, {
      name: request.name, role: 'general', adapterType: 'opencode_local',
      adapterConfig: { cwd: request.directory, model: request.model, dangerouslySkipPermissions: true, timeoutSec: 0 },
      instructionsBundle: { entryFile: 'AGENTS.md', files: { 'AGENTS.md': operation.instructions } },
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } },
      permissions: { canCreateAgents: false, canCreateSkills: false },
      metadata: { herdrRelayScheduleTargetMarker: operation.marker },
    });
  }
  await check();
  requireValue(agent?.id && agent.companyId === request.companyId && agent.adapterType === 'opencode_local' &&
    agent.metadata?.herdrRelayScheduleTargetMarker === operation.marker && agent.status === 'idle',
  'schedule_target_identity_mismatch', 'Created Paperclip agent does not match the schedule target intent', 409);
  operation = store.saveOperation({ ...store.operation(id), state: 'recorded', agentId: agent.id,
    receipt: { status: agent.status, adapterType: agent.adapterType } });
  return receipt(operation);
}
