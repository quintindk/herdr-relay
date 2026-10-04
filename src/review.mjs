import { canonical, digest, requireValue, text } from './protocol.mjs';

export async function review(store, caller, token, api, input) {
  requireValue(['request', 'inspect', 'accept', 'reject'].includes(input.action), 'invalid_review_action', 'Unknown review action');
  const target = store.run(text(input.runId, 'runId'));
  requireValue(target.request.companyId === caller.request.companyId, 'forbidden', 'Result belongs to another company', 403);
  requireValue(target.nativeState === 'settled' && target.settlement.outcome === 'completed' && target.publication.state === 'recorded',
    'result_not_ready', 'Result publication and native completion must settle before review', 409);
  requireValue(target.result.candidate === input.candidate, 'stale_candidate', 'Exact submitted candidate required', 409);
  const latest = store.runs().find(run => run.request.companyId === target.request.companyId && run.request.taskId === target.request.taskId && run.result);
  requireValue(latest?.id === target.id, 'stale_candidate', 'A newer candidate has been submitted', 409);
  const path = `/api/issues/${encodeURIComponent(target.request.taskId)}/interactions`;
  const identity = `relay-review:${target.id}:${digest(target.result)}`;
  const interactions = await api(caller, token, 'GET', path);
  requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected interaction array', 502);
  let interaction = interactions.find(item => item.idempotencyKey === identity);
  const expectedTarget = { type: 'custom', key: 'herdr-relay-candidate', revisionId: target.result.candidate, label: target.id };
  if (input.action === 'request') {
    if (!interaction) interaction = await api(caller, token, 'POST', path, {
      kind: 'request_confirmation', idempotencyKey: identity,
      sourceRunId: caller.backendRunId ?? caller.request.runId, continuationPolicy: 'none',
      ...(input.reviewerAgentId ? { addresseeAgentId: input.reviewerAgentId } : {}),
      ...(input.reviewerUserId ? { addresseeUserId: input.reviewerUserId } : {}),
      payload: { version: 1, prompt: `Accept candidate ${target.result.candidate}?`,
        acceptLabel: 'Accept candidate', rejectLabel: 'Request changes', rejectRequiresReason: true,
        detailsMarkdown: target.result.summary, target: expectedTarget },
    });
  }
  requireValue(interaction && canonical(interaction.payload?.target) === canonical(expectedTarget),
    'review_not_found', 'Matching candidate review is required', 409);
  if (['accept', 'reject'].includes(input.action)) {
    requireValue(caller.request.agentId !== target.request.agentId, 'self_review_forbidden', 'Result author cannot accept or reject its own candidate', 403);
    const status = input.action === 'accept' ? 'accepted' : 'rejected';
    requireValue(interaction.status === status || interaction.status === 'pending', 'review_conflict', 'Review already has another disposition', 409);
    const decisionId = `review-decision:${digest([target.request.companyId, target.request.taskId])}`;
    const decision = store.transaction(() => {
      const latest = store.runs().find(run => run.request.companyId === target.request.companyId && run.request.taskId === target.request.taskId && run.result);
      requireValue(latest?.id === target.id, 'stale_candidate', 'Candidate changed during review verification', 409);
      requireValue(!store.runs().some(run => run.id !== caller.id && run.request.companyId === target.request.companyId &&
        run.request.taskId === target.request.taskId && run.nativeState !== 'settled'),
      'candidate_busy', 'Another task invocation remains unsettled', 409);
      const previous = store.operation(decisionId);
      requireValue(!previous || previous.state === 'recorded' || (previous.targetRunId === target.id && previous.action === input.action),
        'review_decision_uncertain', 'Another review decision requires reconciliation', 409);
      return store.saveOperation({ id: decisionId, runId: caller.id, targetRunId: target.id, companyId: target.request.companyId,
        taskId: target.request.taskId, candidate: target.result.candidate, action: input.action, state: 'uncertain' });
    });
    if (interaction.status !== status) {
      requireValue(interaction.status === 'pending', 'review_conflict', 'Review already has another disposition', 409);
      interaction = await api(caller, token, 'POST', `${path}/${encodeURIComponent(interaction.id)}/${input.action}`,
        input.action === 'reject' ? { reason: text(input.reason, 'reason') } : {});
    }
    requireValue(interaction.status === status, 'review_decision_uncertain', 'Backend did not confirm the requested disposition', 409);
    store.saveOperation({ ...decision, state: 'recorded', interactionId: interaction.id });
  }
  // This is a backend receipt, not an independent acceptance authority.
  return store.recordReview(target.id, { interactionId: interaction.id, candidate: target.result.candidate,
    status: interaction.status, observedAt: new Date().toISOString() });
}
