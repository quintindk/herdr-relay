import { stopRuntime } from './runtimes.mjs';
import { retireWorktree } from './resources.mjs';
import { review } from './review.mjs';
import { digest, requireValue } from './protocol.mjs';

export async function retireAccepted(store, caller, target, token, api) {
  const binding = store.binding(target.request.bindingId);
  requireValue(binding.config.lifetime === 'task', 'persistent_binding', 'Only task-scoped bindings retire on acceptance', 409);
  requireValue(binding.config.controllerBindingId === caller.request.bindingId,
    'lifecycle_forbidden', 'Caller is not this binding lifecycle controller', 403);
  requireValue(target.result, 'result_required', 'A submitted result is required for acceptance-driven retirement');
  const operationId = `retirement:${target.id}`;
  let operation = store.operation(operationId) ?? store.saveOperation({ id: operationId, runId: target.id,
    state: 'pending', candidate: target.result.candidate, controllerRunId: caller.id });
  if (operation.state === 'recorded') return operation;
  const verify = async () => {
    const observed = await review(store, caller, token, api, { runId: target.id, candidate: operation.candidate, action: 'inspect' });
    requireValue(observed.review.status === 'accepted', 'acceptance_required', 'Exact current candidate must be accepted by Paperclip', 409);
  };
  try {
    await verify();
    requireValue(!store.runs(binding.id).some(run => run.nativeState !== 'settled'), 'conversation_busy', 'Unsettled work blocks retirement', 409);
    if (binding.config.worktreeKey) {
      const resource = store.operation(`worktree:${binding.config.worktreeKey}`);
      requireValue(resource && resource.request.bindingId === binding.id, 'resource_conflict', 'Owned worktree does not belong to this binding', 409);
      const finalisation = store.operation(`commit:${digest([resource.id, target.id, target.result.candidate])}`);
      requireValue(finalisation?.state === 'recorded', 'finalisation_required', 'Commit finalisation must precede runtime retirement', 409);
    }
    store.beginRetirement(binding.id);
    const runtimeKey = (binding.config.opencode ?? binding.config.hermes)?.runtimeKey;
    if (runtimeKey) {
      await stopRuntime(store, runtimeKey);
      operation = store.saveOperation({ ...operation, state: 'runtime_stopped' });
    } else requireValue(binding.config.delivery === 'pull', 'runtime_retirement_unsupported', 'Native runtime is not owned by Relay', 409);
    if (binding.config.worktreeKey) await retireWorktree(store, {
      key: binding.config.worktreeKey, runId: target.id, candidate: operation.candidate,
    }, verify);
    store.retireBinding(binding.id);
    return store.saveOperation({ ...operation, state: 'recorded' });
  } catch (error) {
    store.saveOperation({ ...operation, state: 'blocked', reason: error.code ?? 'retirement_unavailable' });
    throw error;
  }
}
