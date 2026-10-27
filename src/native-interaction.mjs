import { digest, now, requireValue } from './protocol.mjs';
import { observeV2 } from '../packages/opencode-relay/native.mjs';

export const interactiveWork = (binding, work) => binding?.interactive === true && !binding.headlessSetupId &&
  work.state !== 'administratively_abandoned' &&
  !work.execution.localOccurrence && !work.execution.monitor && work.execution.state === 'accepted' && work.invocation &&
  work.bindingId === binding.id && work.nativeConversationId === binding.identity?.sessionId;

// Only verified interactive assignments opt into multi-input ownership. The
// original invocation is immutable, including when recovering an RC1 conflict.
export async function reconcileInteractiveWork(journal, binding, work) {
  if (!interactiveWork(binding, work) || work.execution.cancellationRequested) return work;
  if (work.state === 'conflict' && !work.invocation.interactive && !work.interactiveOwnership) return work;
  if (journal.works().some(other => other.id !== work.id && other.state !== 'administratively_abandoned' && other.bindingId === work.bindingId && other.execution.state === 'accepted'))
    return journal.save({ ...work, state: 'conflict', observation: { state: 'conflict', reason: 'ambiguous_execution_ownership' } });
  const observation = observeV2(await binding.native.snapshot(), { ...work.invocation, interactive: true });
  if (!observation.interaction) return journal.save({ ...journal.work(work.id), observation,
    state: observation.state === 'conflict' ? 'conflict' : work.state });
  return journal.transaction(() => {
    const current = journal.work(work.id), previous = current.interaction;
    if (current.execution.state !== 'accepted' || current.execution.cancellationRequested || current.invocation.messageId !== work.invocation.messageId) return current;
    const changed = previous?.revision !== observation.interaction.revision;
    if (changed && observation.interaction.inputIds.length) {
      try { journal.assertReceiver(binding); }
      catch (error) {
        if (error.code !== 'receiver_replaced') throw error;
        return journal.save({ ...current, state: 'conflict', observation: { state: 'conflict', reason: 'receiver_replaced' } });
      }
    }
    const recovered = current.state === 'conflict' && current.observation?.reason === 'concurrent_native_input';
    if (current.state === 'conflict' && !recovered) return current;
    const stale = current.staged && current.staged.inputRevision !== observation.interaction.revision;
    return journal.save({ ...current, observation, interaction: observation.interaction,
      state: observation.state === 'finished' ? 'native_finished' : 'observing',
      ...(stale ? { staged: null, supersededOutcomes: [...(current.supersededOutcomes ?? []), { ...current.staged, supersededAt: now(), reason: 'human_steering' }] } : {}),
      ...(changed ? { inputHistory: [...(current.inputHistory ?? []), { ...observation.interaction, runId: current.execution.runId, at: now() }] } : {}),
      ...(recovered ? { recovery: { state: 'observation_reconciled', previousObservation: current.observation,
        reason: 'Verified interactive human steering adopted without replaying the original invocation.', at: now() } } : {}),
    });
  });
}

export async function previewInteractiveRecovery(journal, binding, work) {
  requireValue(interactiveWork(binding, work) && work.state === 'conflict' && work.observation?.reason === 'concurrent_native_input' &&
    !work.execution.cancellationRequested, 'recovery_ineligible', 'Exact conflicted, uncancelled interactive assignment required');
  requireValue(!journal.works().some(other => other.id !== work.id && other.state !== 'administratively_abandoned' && other.bindingId === work.bindingId && other.execution.state === 'accepted'),
    'recovery_ineligible', 'Multiple accepted assignments on this binding require separate disposition');
  const observation = observeV2(await binding.native.snapshot(), { ...work.invocation, interactive: true });
  requireValue(observation.interaction && ['observed', 'finished'].includes(observation.state), 'recovery_ineligible', 'Native input ownership is still ambiguous or contains a hard boundary');
  requireValue(!journal.db.prepare("SELECT data FROM outbox WHERE state IN ('pending','conflict')").all().some(row => {
    const item = JSON.parse(row.data), p = item.command.payload; return (p.id ?? p.executionId) === work.id;
  }), 'recovery_publication_pending', 'Reconcile existing publications before adopting input ownership');
  const workDigest = digest(work), previewHash = digest({ workDigest, interaction: observation.interaction });
  return { previewHash, workDigest, executionId: work.id, runId: work.execution.runId, bindingId: work.bindingId,
    inputRevision: observation.interaction.revision, inputIds: observation.interaction.inputIds, observation };
}

export function applyInteractiveRecovery(journal, work, preview, sourceMessageId) {
  requireValue(preview.inputIds.at(-1) === sourceMessageId && preview.workDigest === digest(journal.work(work.id)),
    'stale_recovery_preview', 'Exact unchanged preview and current native human source required');
  return journal.save({ ...work, interactiveOwnership: true, state: preview.observation.state === 'finished' ? 'native_finished' : 'observing',
    interaction: preview.observation.interaction, observation: preview.observation,
    inputHistory: [...(work.inputHistory ?? []), { ...preview.observation.interaction, runId: work.execution.runId, at: now() }],
    ...(work.staged ? { staged: null, supersededOutcomes: [...(work.supersededOutcomes ?? []), { ...work.staged, supersededAt: now(), reason: 'inspected_input_recovery' }] } : {}),
    recovery: { state: 'observation_reconciled', previousObservation: work.observation, previewHash: preview.previewHash,
      sourceMessageId, at: now(), reason: 'Human authorised exact interactive-input recovery. Original invocation and conflict retained; no prompt replayed.' } });
}

export function installInteractionPublicationGuard(journal, resolveBinding, api) {
  journal.beforePublish = async item => {
    if (!item.inputRevision) return true;
    const work = journal.work(item.command.payload.executionId ?? item.command.payload.id);
    if (!work) return false;
    const binding = await resolveBinding(work.execution.targetAgentId, work);
    if (!binding) return false;
    const current = await reconcileInteractiveWork(journal, binding, work);
    if (current.interaction?.revision === item.inputRevision && current.state !== 'conflict') return true;
    if (item.attemptedAt) {
      if (api) {
        let proof;
        try { proof = await api('GET', `/v1/command-receipts/${encodeURIComponent(item.command.key)}?executionId=${encodeURIComponent(work.id)}`); }
        catch { /* Older/offline backends cannot prove receipt state. Keep fenced. */ }
        if (proof?.state === 'recorded') {
          requireValue(proof.hash === digest({ action: item.command.action, payload: item.command.payload }), 'operation_conflict', 'Backend receipt differs from original publication');
          journal.save({ ...current, execution: proof.execution, state: proof.execution.state === 'waiting' ? 'settled_waiting' : 'native_finished',
            recovery: { state: 'publication_reconciled', reason: 'publication_confirmed_for_previous_input', key: item.command.key,
              submittedInputRevision: item.inputRevision, laterInputRevision: current.interaction?.revision, at: now() } });
          return { recordedReceipt: proof.receipt };
        }
        if (proof?.state === 'absent' && proof.execution.id === work.id && Number.isSafeInteger(item.command.payload.expectedRevision) &&
          proof.execution.revision !== item.command.payload.expectedRevision) {
          journal.save({ ...current, execution: proof.execution, state: current.observation?.state === 'finished' ? 'native_finished' : 'observing',
            recovery: { state: 'publication_reconciled', reason: 'absent_receipt_and_execution_revision_fenced', key: item.command.key, at: now() } });
          return { refused: true, reason: 'stale_execution_revision', executionRevision: proof.execution.revision };
        }
      }
      journal.save({ ...current, state: 'conflict', recovery: { state: 'blocked', reason: 'publication_input_race', key: item.command.key, at: now() } });
      return false; // An uncertain effect needs explicit reconciliation, not replay.
    }
    return 'supersede'; // No transport attempt exists, so this cannot erase effects.
  };
}
