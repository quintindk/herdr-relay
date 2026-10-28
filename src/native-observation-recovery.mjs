// Re-observe only the exact persisted invocation. Never resend a prompt or
// promote a model-authored result that the worker connector did not accept.
export async function reconcileObservationConflict(journal, binding, work) {
  if (work.state !== 'conflict' || work.observation?.reason !== 'concurrent_native_input' || !work.invocation) return work;
  if (binding.id !== work.bindingId || (binding.identity?.sessionId ?? binding.conversationId ?? null) !== work.nativeConversationId) return work;
  const observation = binding.observe(await binding.native.snapshot(), work.invocation);
  if (!['observed', 'finished'].includes(observation.state)) return work;
  return journal.save({ ...work, state: 'observing', observation, recovery: {
    state: 'observation_reconciled', previousObservation: work.observation,
    reason: 'Exact native input provenance no longer conflicts. No prompt was replayed.',
  } });
}
