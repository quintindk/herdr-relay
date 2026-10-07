import { canonical, digest } from './protocol.mjs';

export function harnessReviewDecision(run, request, item) {
  const status = request.decision === 'accept' ? 'accepted' : 'rejected';
  return ['accept', 'reject'].includes(request.decision) && item?.id === request.interactionId &&
    item.kind === 'request_confirmation' && item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}` &&
    (item.companyId === undefined || item.companyId === run.request.companyId) &&
    (item.issueId === undefined || item.issueId === run.request.taskId) &&
    canonical(item.payload?.target) === canonical({ type: 'custom', key: 'herdr-relay-candidate',
      revisionId: request.candidate, label: run.id }) && item.status === status &&
    item.result?.version === 1 && item.result.outcome === status &&
    (request.decision !== 'reject' || (typeof request.reason === 'string' && request.reason.trim() && item.result.reason === request.reason)) &&
    typeof item.resolvedByUserId === 'string' && item.resolvedByUserId.trim() &&
    item.resolvedByAgentId == null && item.resolvedByRunId == null;
}

export function harnessReviewReceipt(request) {
  return { interactionId: request.interactionId, status: request.decision === 'accept' ? 'accepted' : 'rejected',
    attribution: 'Relay operator connector; native source recorded in private harness-review receipt.',
    continuation: 'End this turn. Relay/Paperclip own subsequent completion; do not mark the issue Done yourself.' };
}

export async function reconcileHarnessReviews(store, api, locks = new Map()) {
  const rows = store.db.prepare("SELECT id, run_id, data FROM operations WHERE id LIKE 'harness-review:%'").all();
  for (const row of rows) {
    const operation = JSON.parse(row.data);
    const request = operation.request;
    if (operation.state !== 'uncertain' || operation.id !== row.id || operation.runId !== row.run_id ||
      !request || !['bindingId', 'conversationId', 'interactionId', 'candidate', 'sourceMessageId', 'sourceDigest']
        .every(field => typeof request[field] === 'string' && request[field].trim()) ||
      !['accept', 'reject'].includes(request.decision)) continue;
    const lock = `harness-answer:${request.bindingId}`;
    if (locks.has(lock)) continue;
    const pending = Promise.resolve().then(async () => {
      try {
        const run = store.run(operation.runId);
        const valid = () => {
          const current = store.run(run.id);
          return canonical(store.operation(operation.id)) === canonical(operation) &&
            canonical([current.request, current.result, current.conversationId]) === canonical([run.request, run.result, run.conversationId]) &&
            current.nativeState === 'settled' && current.settlement?.outcome === 'completed' && current.publication?.state === 'recorded' &&
            current.result?.candidate === request.candidate && current.review?.candidate === request.candidate &&
            current.review.interactionId === request.interactionId &&
            (operation.resultDigest === undefined || operation.resultDigest === digest(current.result)) &&
            (request.companyId === undefined || request.companyId === current.request.companyId) &&
            (request.taskId === undefined || request.taskId === current.request.taskId) &&
            operation.id === `harness-review:${digest([current.request.companyId, request.interactionId])}`;
        };
        if (!valid()) return;
        const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
        const issue = await api('GET', path);
        if (!valid() || issue?.id !== run.request.taskId || issue.companyId !== run.request.companyId ||
          issue.assigneeAgentId !== run.request.agentId) return;
        const interactions = await api('GET', `${path}/interactions`);
        if (!valid() || !Array.isArray(interactions)) return;
        const matches = interactions.filter(item => item?.id === request.interactionId ||
          item?.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}`);
        if (matches.length !== 1 || !harnessReviewDecision(run, request, matches[0])) return;
        const receipt = harnessReviewReceipt(request);
        store.recordReview(run.id, { interactionId: request.interactionId, candidate: request.candidate,
          status: receipt.status, observedAt: new Date().toISOString() });
        store.saveOperation({ ...operation, state: 'recorded', receipt });
      } catch {
        // Missing runs and unavailable or conflicting receipts leave the intent untouched.
      }
    });
    locks.set(lock, pending);
    try { await pending; } finally { if (locks.get(lock) === pending) locks.delete(lock); }
  }
}
