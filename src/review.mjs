import { canonical, digest, requireValue, text } from './protocol.mjs';

export async function review(store, caller, token, api, input) {
  const target = store.run(text(input.runId, 'runId'));
  requireValue(target.request.companyId === caller.request.companyId, 'forbidden', 'Result belongs to another company', 403);
  requireValue(target.nativeState === 'settled' && target.settlement.outcome === 'completed' && target.publication.state === 'recorded',
    'result_not_ready', 'Result publication and native completion must settle before review', 409);
  requireValue(target.result.candidate === input.candidate, 'stale_candidate', 'Exact submitted candidate required', 409);
  const latest = store.runs().find(run => run.request.taskId === target.request.taskId && run.result);
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
    if (interaction.status !== status) {
      requireValue(interaction.status === 'pending', 'review_conflict', 'Review already has another disposition', 409);
      interaction = await api(caller, token, 'POST', `${path}/${encodeURIComponent(interaction.id)}/${input.action}`,
        input.action === 'reject' ? { reason: text(input.reason, 'reason') } : {});
    }
  }
  requireValue(['request', 'inspect', 'accept', 'reject'].includes(input.action), 'invalid_review_action', 'Unknown review action');
  // This is a backend receipt, not an independent acceptance authority.
  return store.recordReview(target.id, { interactionId: interaction.id, candidate: target.result.candidate,
    status: interaction.status, observedAt: new Date().toISOString() });
}
