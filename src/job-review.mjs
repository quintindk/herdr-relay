import { canonical, digest, requireValue } from './protocol.mjs';
import { requestReviewDisposition } from './disposition.mjs';

// Changing a job's review workflow withdraws our own pending request, never accepts its result.
export async function useChatReviewForRoutine(store, api, schedule, editId, check) {
  const claims = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine-task:%'").all()
    .map(row => JSON.parse(row.data)).filter(claim => claim.scheduleId === schedule.id);
  for (const claim of claims) {
    const runs = store.runs().filter(run => run.request.companyId === schedule.request.companyId && run.request.taskId === claim.receipt.id);
    const run = runs.find(run => run.result) ?? runs[0];
    if (!run || ['accepted', 'rejected'].includes(run.review?.status) || run.result?.reviewDecision) continue;
    const id = `chat-review-transition:${run.id}`;
    const send = async (...args) => { await check(); const value = await api(...args); await check(); return value; };
    let transition = store.operation(id);
    if (transition?.state === 'recorded') continue;
    if (!run.result || run.nativeState !== 'settled' || run.settlement?.outcome !== 'completed' || run.publication.state !== 'recorded') {
      store.saveOperation({ ...claim, previousReviewPolicy: claim.previousReviewPolicy ?? claim.request.relayReviewPolicy,
        request: { ...claim.request, relayReviewPolicy: 'none' }, reviewPolicyEditId: editId });
      continue;
    }
    const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
    const issue = await send('GET', path);
    requireValue(issue.companyId === run.request.companyId && issue.assigneeAgentId === run.request.agentId && !issue.reviewPolicy,
      'review_policy_locked', 'Only this job without an external approval policy can switch to chat review', 409);
    const interactions = await send('GET', `${path}/interactions`);
    requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected job interactions', 502);
    const owned = interactions.find(item => item.id === run.review?.interactionId);
    const withdrawn = item => item?.status === 'cancelled' && item.result?.outcome === 'withdrawn';
    if (owned) {
      const expected = { type: 'custom', key: 'herdr-relay-candidate', revisionId: run.result.candidate, label: run.id };
      requireValue(owned.kind === 'request_confirmation' && owned.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}` &&
        canonical(owned.payload?.target) === canonical(expected), 'review_scope_changed', 'Review request is not the exact Relay result', 409);
      requireValue(owned.status === 'pending' || withdrawn(owned), 'review_already_decided', 'A decided review cannot be rewritten', 409);
      if (owned.status === 'pending') {
        requireValue(!transition?.withdrawSent, 'operation_uncertain', 'Review withdrawal is unconfirmed; no blind resend', 409);
        transition = store.saveOperation({ id, runId: run.id, state: 'uncertain', editId, candidate: run.result.candidate, withdrawSent: true });
        await send('POST', `${path}/interactions/${encodeURIComponent(owned.id)}/withdraw`, { reason: 'Job review changed to ordinary output review in chat' });
        const fresh = await send('GET', `${path}/interactions`);
        requireValue(Array.isArray(fresh), 'invalid_backend_response', 'Expected job interactions', 502);
        requireValue(withdrawn(fresh.find(item => item.id === owned.id)), 'operation_uncertain', 'Review withdrawal has not been confirmed', 409);
      }
      store.recordReview(run.id, { ...run.review, status: 'withdrawn' });
      const disposition = store.operation(`review-disposition:${run.id}`);
      if (disposition) store.saveOperation({ ...disposition, state: 'withdrawn', reviewPolicyEditId: editId });
      for (const row of store.db.prepare("SELECT data FROM operations WHERE id LIKE 'review-notification:%'").all()) {
        const notification = JSON.parse(row.data);
        if (notification.runId === run.id && ['pending', 'uncertain'].includes(notification.state)) {
          store.saveOperation({ ...notification, state: 'superseded', reviewPolicyEditId: editId });
        }
      }
    }
    store.saveOperation({ ...claim, previousReviewPolicy: claim.previousReviewPolicy ?? claim.request.relayReviewPolicy,
      request: { ...claim.request, relayReviewPolicy: 'none' }, reviewPolicyEditId: editId });
    transition = store.saveOperation({ ...store.operation(id), id, runId: run.id, editId, candidate: run.result.candidate,
      state: 'withdrawn', previousInteractionId: owned?.id ?? null });
    const current = await send('GET', path);
    const duplicateId = current.executionRunId;
    if (duplicateId && duplicateId !== (run.backendRunId ?? run.request.runId)) {
      const duplicatePath = `/api/heartbeat-runs/${encodeURIComponent(duplicateId)}`;
      const duplicate = await send('GET', duplicatePath);
      const taskId = duplicate.contextSnapshot?.taskId ?? duplicate.contextSnapshot?.issueId;
      requireValue(duplicate.companyId === run.request.companyId && duplicate.agentId === run.request.agentId && taskId === run.request.taskId &&
        !store.runs().some(item => item.request.companyId === run.request.companyId &&
          [item.request.runId, item.backendRunId].includes(duplicateId)),
      'disposition_conflict', 'Another admitted execution cannot be cancelled by a review change', 409);
      const duplicateOperationId = `chat-review-duplicate:${duplicateId}`;
      const cancelled = store.operation(duplicateOperationId);
      if (['running', 'queued'].includes(duplicate.status)) {
        requireValue(!cancelled, 'operation_uncertain', 'Duplicate wake cancellation is unconfirmed; no blind resend', 409);
        store.saveOperation({ id: duplicateOperationId, runId: run.id, state: 'uncertain', editId, backendRunId: duplicateId });
        await send('POST', `${duplicatePath}/cancel`, { reason: 'Already-reported routine occurrence; no new native execution was admitted' });
      }
      const terminal = await send('GET', duplicatePath);
      requireValue(['cancelled', 'failed', 'succeeded', 'timed_out', 'interrupted'].includes(terminal.status),
        'operation_uncertain', 'Undispatched duplicate wake has not stopped', 409);
      store.saveOperation({ id: duplicateOperationId, runId: run.id, state: 'recorded', editId, backendRunId: duplicateId });
    }
    const recovery = await send('GET', `${path}/recovery-actions`);
    const blockedIssue = await send('GET', path);
    const recoveryAction = recovery.active ?? (blockedIssue.executionBlocker?.cause === 'legacy_execution_requires_reconciliation'
      ? { id: blockedIssue.executionBlocker.recoveryActionId, evidence: { runId: blockedIssue.executionBlocker.runId } } : null);
    if (recoveryAction) {
      const duplicateId = recoveryAction.evidence?.runId;
      let duplicateOperation = duplicateId && store.operation(`chat-review-duplicate:${duplicateId}`);
      if (duplicateOperation?.runId === run.id && duplicateOperation.state === 'uncertain') {
        const terminal = await send('GET', `/api/heartbeat-runs/${encodeURIComponent(duplicateId)}`);
        requireValue(terminal.companyId === run.request.companyId && terminal.agentId === run.request.agentId &&
          (terminal.contextSnapshot?.taskId ?? terminal.contextSnapshot?.issueId) === run.request.taskId &&
          ['cancelled', 'failed', 'succeeded', 'timed_out', 'interrupted'].includes(terminal.status),
        'operation_uncertain', 'Duplicate wake termination has not been independently confirmed', 409);
        duplicateOperation = store.saveOperation({ ...duplicateOperation, state: 'recorded' });
      }
      requireValue(duplicateOperation?.runId === run.id && duplicateOperation.state === 'recorded' &&
        !store.runs().some(item => item.request.companyId === run.request.companyId &&
          [item.request.runId, item.backendRunId].includes(duplicateId)),
      'disposition_conflict', 'Only the verified undispatched duplicate can reconcile this recovery hold', 409);
      const recoveryId = `chat-review-recovery:${recoveryAction.id}`;
      requireValue(!store.operation(recoveryId), 'operation_uncertain', 'Recovery resolution is unconfirmed; no blind resend', 409);
      store.saveOperation({ id: recoveryId, runId: run.id, state: 'uncertain', editId, backendRunId: duplicateId });
      await send('POST', `${path}/recovery-actions/resolve`, { actionId: recoveryAction.id, outcome: 'restored', sourceIssueStatus: 'todo',
        executionReconciliation: { runId: duplicateId, providerStopped: true, actionOutcome: 'not_performed',
          outcomeEvidence: `Duplicate wake was terminal without any Relay/native admission. Original ${run.id} already published its result; no new work or result acceptance was claimed.` } });
      const resolved = await send('GET', `${path}/recovery-actions`);
      const restored = await send('GET', path);
      requireValue(!resolved.active && restored.executionBlocker?.runId !== duplicateId,
        'operation_uncertain', 'Recovery hold is not confirmed resolved', 409);
      store.saveOperation({ ...store.operation(recoveryId), state: 'recorded' });
    }
    await requestReviewDisposition(store, run.id, undefined, (_, __, ...args) => send(...args));
    store.saveOperation({ ...transition, state: 'recorded' });
  }
}
