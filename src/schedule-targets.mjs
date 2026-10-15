import { resolve } from 'node:path';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { persistentRoutineScope } from './persistent-routines.mjs';
import { provisionAgent } from './provisioning.mjs';

const single = (value, name, max = 240) => {
  value = text(value, name).trim();
  requireValue(value.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(value), 'invalid_request', `${name} must be bounded single-line text`);
  return value;
};

const receipt = (operation, provision) => ({ operationId: operation.id, state: operation.state,
  targetBindingId: provision?.bindingId ?? operation.targetBindingId ?? null,
  agentId: provision?.agentId ?? operation.agentId ?? null, name: operation.request.name,
  targetType: 'relay_managed', ready: operation.state === 'recorded' });

export async function createScheduleTarget(store, api, config, input, authority, check = () => {},
  { stateDirectory, provision = provisionAgent } = {}) {
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
  const targetKey = `schedule-${digest([request.companyId, owner, request.key]).slice(0, 32)}`;
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request) && canonical(operation.authority) === canonical(owner),
      'operation_conflict', 'Schedule target key has another request or authority', 409);
    if (operation.state === 'recorded') return receipt(operation);
  } else operation = store.transaction(() => store.operation(id) ?? store.saveOperation({ id, runId: '', state: 'intent',
    request, authority: owner, targetBindingId: targetKey }));
  requireValue(typeof stateDirectory === 'string' && stateDirectory, 'schedule_target_unavailable', 'Relay state directory is required');
  await check();
  const [providerID, ...modelParts] = request.model.split('/');
  const result = await provision(store, stateDirectory, api, { key: targetKey, companyId: request.companyId,
    bindingId: targetKey, harness: 'opencode', directory: request.directory, lifetime: 'service', label: request.name,
    model: { providerID, modelID: modelParts.join('/') }, instructions });
  await check();
  const binding = store.binding(result.bindingId, false);
  requireValue(result.state === 'recorded' && binding && binding.id === targetKey && binding.config.delivery === 'opencode' &&
    binding.config.lifetime === 'service' && binding.config.instructions === instructions,
  'schedule_target_identity_mismatch', 'Managed Relay schedule target identity is not confirmed', 409);
  operation = store.saveOperation({ ...store.operation(id), state: 'recorded', targetBindingId: binding.id, agentId: result.agentId });
  return receipt(operation, result);
}
