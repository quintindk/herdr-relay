import { canonical, digest, requireValue, text } from './protocol.mjs';
import { review } from './review.mjs';

export async function checkReviewWake(store, input, api) {
  const request = {};
  for (const field of ['bindingId', 'companyId', 'agentId', 'runId', 'taskId']) request[field] = text(input[field], field);
  request.bindingRevision = input.bindingRevision;
  const binding = store.binding(request.bindingId);
  requireValue(binding.revision === request.bindingRevision && binding.config.companyId === request.companyId &&
    binding.config.agentId === request.agentId, 'identity_mismatch', 'Wake does not match binding', 409);
  const id = `review-wake:${digest([request.companyId, request.runId])}`;
  const previous = store.operation(id);
  if (previous) {
    requireValue(canonical(previous.request) === canonical(request), 'dispatch_conflict', 'Wake retry changed identity', 409);
    return previous.receipt;
  }
  const runs = store.runs().filter(run => run.request.companyId === request.companyId && run.request.taskId === request.taskId);
  // Never turn a previously admitted/attempted invocation into a no-op on retry.
  if (runs.some(run => (run.backendRunId ?? run.request.runId) === request.runId || run.nativeState !== 'settled')) return { skip: false };
  const latest = runs.find(run => run.result);
  if (!latest || latest.request.bindingId !== binding.id || latest.nativeState !== 'settled' ||
    latest.settlement?.outcome !== 'completed' || latest.publication.state !== 'recorded' || !latest.review) return { skip: false };
  const caller = { request, backendRunId: request.runId };
  const token = text(input.token, 'token');
  const backend = await api(caller, token, 'GET', `/api/heartbeat-runs/${encodeURIComponent(request.runId)}`);
  requireValue(backend.id === request.runId && backend.companyId === request.companyId && backend.agentId === request.agentId,
    'identity_mismatch', 'Backend wake identity changed', 409);
  if (backend.status !== 'running' || backend.invocationSource !== 'automation' ||
    backend.contextSnapshot?.wakeReason !== 'issue_children_completed' ||
    (backend.contextSnapshot.taskId ?? backend.contextSnapshot.issueId) !== request.taskId) return { skip: false };
  const path = `/api/issues/${encodeURIComponent(request.taskId)}`;
  const issue = await api(caller, token, 'GET', path);
  if (issue.id !== request.taskId || issue.companyId !== request.companyId || issue.status !== 'in_review' ||
    issue.assigneeAgentId !== request.agentId || (issue.executionRunId && issue.executionRunId !== request.runId)) return { skip: false };
  const interactions = await api(caller, token, 'GET', `${path}/interactions`);
  requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected review interactions', 502);
  const expected = { type: 'custom', key: 'herdr-relay-candidate', revisionId: latest.result.candidate, label: latest.id };
  const pending = interactions.find(item => item.id === latest.review.interactionId && item.status === 'pending' &&
    item.kind === 'request_confirmation' && item.idempotencyKey === `relay-review:${latest.id}:${digest(latest.result)}` &&
    canonical(item.payload?.target) === canonical(expected));
  if (!pending) return { skip: false };
  const currentRuns = store.runs().filter(run => run.request.companyId === request.companyId && run.request.taskId === request.taskId);
  if (currentRuns.some(run => run.nativeState !== 'settled' || (run.backendRunId ?? run.request.runId) === request.runId) ||
    currentRuns.find(run => run.result)?.id !== latest.id) return { skip: false };
  const receipt = { skip: true, reason: 'candidate_review_pending', relayRunId: latest.id,
    interactionId: pending.id, conversationId: binding.config.conversationId };
  store.saveOperation({ id, runId: latest.id, request, state: 'recorded', receipt });
  return receipt;
}

export async function requestReviewDisposition(store, id, token, api) {
  const run = store.run(id);
  requireValue(run.nativeState === 'settled' && run.settlement?.outcome === 'completed' && run.publication.state === 'recorded',
    'result_not_ready', 'A settled, published result is required for review disposition', 409);
  const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
  const issue = await api(run, token, 'GET', path);
  requireValue(issue.companyId === run.request.companyId, 'identity_mismatch', 'Issue company changed', 409);
  // Never reopen a task or overwrite a disposition that changed after our run.
  if (['done', 'cancelled'].includes(issue.status)) return { status: issue.status };
  requireValue(issue.assigneeAgentId === run.request.agentId &&
    (!issue.executionRunId || issue.executionRunId === (run.backendRunId ?? run.request.runId)),
  'disposition_conflict', 'Issue belongs to another assignee or execution', 409);
  const operationId = `review-disposition:${id}`;
  let disposition = store.operation(operationId) ?? store.saveOperation({ id: operationId, runId: id,
    candidate: run.result.candidate, state: 'waiting' });
  const reviewed = await review(store, run, token, api, { runId: id, candidate: run.result.candidate,
    action: 'request', ...(issue.responsibleUserId ? { reviewerUserId: issue.responsibleUserId } : {}) });
  requireValue(['pending', 'accepted', 'rejected'].includes(reviewed.review.status), 'review_already_decided', 'Review is no longer actionable', 409);
  disposition = store.saveOperation({ ...disposition, interactionId: reviewed.review.interactionId });
  if (issue.status !== 'in_review') {
    await api(run, token, 'PATCH', path, { status: 'in_review', reviewInteractionId: reviewed.review.interactionId });
  }
  const observed = await api(run, token, 'GET', path);
  requireValue(observed.companyId === run.request.companyId && observed.status === 'in_review',
    'disposition_uncertain', 'Paperclip has not confirmed review disposition', 409);
  return { status: observed.status, interactionId: reviewed.review.interactionId };
}

export async function reconcileCompletions(store, operatorApi, locks = new Map()) {
  const operations = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'review-disposition:%'").all().map(row => JSON.parse(row.data));
  for (const disposition of operations) {
    const id = `completion:${disposition.runId}`;
    let completion = store.operation(id);
    if (['recorded', 'skipped'].includes(completion?.state)) continue;
    const lock = `review:${disposition.runId}`;
    if (locks.has(lock)) continue;
    const pending = (async () => {
      try {
        const run = store.run(disposition.runId);
        requireValue(run.result?.candidate === disposition.candidate, 'stale_candidate', 'Disposition candidate changed', 409);
        const api = (_, __, method, path, body) => operatorApi(method, path, body);
        const observed = await review(store, run, undefined, api, { action: 'inspect', runId: run.id, candidate: disposition.candidate });
        if (observed.review.status !== 'accepted') return;
        requireValue(!disposition.interactionId || observed.review.interactionId === disposition.interactionId,
          'review_conflict', 'Disposition interaction changed', 409);
        const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
        const issue = await operatorApi('GET', path);
        requireValue(issue.id === run.request.taskId && issue.companyId === run.request.companyId,
          'identity_mismatch', 'Issue identity changed', 409);
        if (['done', 'cancelled'].includes(issue.status)) {
          store.saveOperation({ id, runId: run.id, state: issue.status === 'done' ? 'recorded' : 'skipped',
            candidate: disposition.candidate, interactionId: observed.review.interactionId, status: issue.status });
          return;
        }
        requireValue(completion?.state !== 'uncertain', 'completion_uncertain', 'Completion was attempted; a nonterminal read does not authorise replay', 409);
        let acceptedTodo = false;
        if (issue.status === 'todo') {
          // Paperclip confirmations can return in_review tasks to todo even with
          // continuationPolicy=none. Only the exact acceptance audit authorises it.
          const activity = await operatorApi('GET', `${path}/activity`);
          requireValue(Array.isArray(activity), 'invalid_backend_response', 'Expected issue activity array', 502);
          const updates = activity.filter(item => item.entityId === issue.id && item.companyId === issue.companyId && item.action === 'issue.updated')
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          const last = updates[0];
          acceptedTodo = last?.details?.source === 'request_confirmation_accept' &&
            last.details.interactionId === observed.review.interactionId && last.details.status === 'todo' &&
            last.details._previous?.status === 'in_review' && last.details.assigneeAgentId === run.request.agentId &&
            !last.details.assigneeUserId && Number.isFinite(Date.parse(last.createdAt)) &&
            Date.parse(last.createdAt) >= Date.parse(issue.updatedAt) &&
            (!updates[1] || Date.parse(updates[1].createdAt) < Date.parse(last.createdAt));
        }
        requireValue((issue.status === 'in_review' || acceptedTodo) && issue.assigneeAgentId === run.request.agentId &&
          !issue.executionRunId && !issue.checkoutRunId && !issue.activeRecoveryAction && !issue.executionBlocker,
          'completion_conflict', 'Issue is not available for accepted-result completion', 409);
        const backend = await operatorApi('GET', `/api/heartbeat-runs/${encodeURIComponent(run.backendRunId ?? run.request.runId)}`);
        requireValue(backend.id === (run.backendRunId ?? run.request.runId) && backend.companyId === run.request.companyId &&
          backend.agentId === run.request.agentId && backend.status === 'succeeded',
          'backend_run_not_succeeded', 'Wait for the exact successful Paperclip run', 409);
        const fresh = await operatorApi('GET', path);
        requireValue(fresh.id === issue.id && fresh.companyId === issue.companyId && fresh.status === issue.status &&
          fresh.updatedAt === issue.updatedAt && fresh.assigneeAgentId === issue.assigneeAgentId &&
          !fresh.executionRunId && !fresh.checkoutRunId && !fresh.activeRecoveryAction && !fresh.executionBlocker,
          'completion_conflict', 'Issue changed during completion verification', 409);
        const latest = store.runs().find(item => item.request.companyId === run.request.companyId && item.request.taskId === run.request.taskId && item.result);
        requireValue(latest?.id === run.id && !store.runs().some(item => item.request.companyId === run.request.companyId &&
          item.request.taskId === run.request.taskId && item.nativeState !== 'settled'), 'candidate_busy', 'Newer or unsettled task work prevents completion', 409);
        completion = store.saveOperation({ id, runId: run.id, state: 'uncertain', candidate: disposition.candidate,
          interactionId: observed.review.interactionId, taskId: run.request.taskId, companyId: run.request.companyId });
        // The backend PATCH has no conditional-write contract. Record intent first
        // and never repeat it after uncertainty; readback can confirm a lost reply.
        await operatorApi('PATCH', path, { status: 'done' });
        const receipt = await operatorApi('GET', path);
        requireValue(receipt.id === issue.id && receipt.companyId === issue.companyId && receipt.status === 'done',
          'completion_uncertain', 'Backend did not confirm completion', 409);
        store.saveOperation({ ...completion, state: 'recorded', status: 'done' });
      } catch (error) {
        if (completion) store.saveOperation({ ...completion, reason: error.code ?? 'backend_unavailable' });
        store.saveOperation({ ...disposition, reason: error.code ?? 'backend_unavailable' });
      }
    })();
    locks.set(lock, pending);
    try { await pending; } finally { locks.delete(lock); }
  }
}
