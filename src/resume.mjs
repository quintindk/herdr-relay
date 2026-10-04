import { join } from 'node:path';
import { canonical, requireValue, text } from './protocol.mjs';
import { launchRuntime, stoppedRuntime } from './runtimes.mjs';
import { OpenCode } from './opencode.mjs';
import { Hermes } from './hermes.mjs';

export async function resumeRuntime(store, directory, api, input) {
  const id = `resume:${text(input.key, 'key')}`;
  const request = { bindingId: text(input.bindingId, 'bindingId'), revision: input.revision,
    runtimeKey: text(input.runtimeKey, 'runtimeKey') };
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Resume operation changed', 409);
    if (operation.state === 'recorded') return operation;
  }
  let binding = store.binding(request.bindingId);
  requireValue(!binding.lifecycleState && !store.runs(binding.id).some(run => run.nativeState !== 'settled'),
    'runtime_busy', 'Resume requires an active binding without unsettled native work', 409);
  if (!operation) {
    requireValue(binding.revision === request.revision, 'stale_binding', 'Binding revision changed', 409);
    const oldKey = (binding.config.opencode ?? binding.config.hermes)?.runtimeKey;
    requireValue(oldKey && oldKey !== request.runtimeKey, 'invalid_runtime_key', 'Resume requires a new owned runtime key');
    const oldRuntime = stoppedRuntime(store, oldKey);
    operation = store.saveOperation({ id, runId: '', request, state: 'intent', previousConfig: binding.config,
      previousRuntime: oldKey, launchRequest: oldRuntime.request });
  }
  const runtime = await launchRuntime(store, directory, { ...operation.launchRequest, key: request.runtimeKey });
  const previous = operation.previousConfig;
  if (!operation.nativeConfig) {
    const hermes = previous.harness === 'hermes';
    let config;
    if (hermes) {
      config = { ...previous.hermes, url: `ws://127.0.0.1:${runtime.port}/api/ws`,
        authFile: join(runtime.directory, 'gateway-token'), runtimeKey: request.runtimeKey };
      const native = new Hermes({ conversationId: previous.conversationId, hermes: config });
      const session = await native.request('session.resume', { session_id: previous.conversationId, close_on_disconnect: false });
      requireValue((session.stored_session_id ?? session.session_key ?? session.info?.stored_session_id) === previous.conversationId && !session.auto_continue,
        'continuation_unproven', 'Hermes resumed another conversation or scheduled interrupted work', 409);
      config.runtimeId = session.session_id;
      config.epoch = (await native.request('session.events.since', { last_seen: 0 })).epoch;
    } else config = { ...previous.opencode, url: `http://127.0.0.1:${runtime.port}`,
      authFile: join(runtime.directory, 'auth.json'), runtimeKey: request.runtimeKey };
    operation = store.saveOperation({ ...operation, nativeConfig: config, state: 'native_resumed' });
  }
  const native = previous.harness === 'hermes'
    ? new Hermes({ conversationId: previous.conversationId, hermes: operation.nativeConfig })
    : new OpenCode({ conversationId: previous.conversationId, opencode: operation.nativeConfig });
  requireValue((await native.snapshot()).idle, 'native_busy', 'Resumed conversation must be idle', 409);
  if (binding.revision === request.revision) {
    binding = store.rebind(binding.id, { revision: request.revision, harness: previous.harness,
      conversationId: previous.conversationId, instanceId: runtime.nonce, [previous.harness]: operation.nativeConfig }, { managedContinuation: true });
  } else requireValue(binding.revision === request.revision + 1 &&
    canonical(binding.config[previous.harness]) === canonical(operation.nativeConfig), 'stale_binding', 'Binding changed during managed resume', 409);
  const path = `/api/agents/${encodeURIComponent(binding.config.agentId)}`;
  const agent = await api('GET', path);
  requireValue(agent.companyId === binding.config.companyId && agent.adapterType === 'herdr_relay' && agent.adapterConfig?.bindingId === binding.id,
    'recovery_identity_mismatch', 'Backend agent no longer owns this binding', 409);
  await api('PATCH', path, { adapterConfig: { ...agent.adapterConfig, bindingRevision: binding.revision } });
  return store.saveOperation({ ...operation, state: 'recorded', revision: binding.revision, conversationId: binding.config.conversationId });
}
