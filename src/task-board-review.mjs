import { canonical, digest, requireValue, text } from './protocol.mjs';
import { readTaskComments } from './task-query.mjs';
import { harnessReviewDecision, harnessReviewReceipt } from './harness-review-reconciliation.mjs';

const publicTask = task => Object.fromEntries(['id', 'companyId', 'identifier', 'title', 'description', 'status', 'priority',
  'parentId', 'projectId', 'assigneeAgentId', 'assigneeUserId', 'updatedAt', 'originKind', 'originId', 'originRunId']
  .map(key => [key, task[key] ?? null]));

function localReview(store, companyId, taskId, runId, interactionId, candidate) {
  const taskRuns = store.runs().filter(run => run.request.companyId === companyId && run.request.taskId === taskId);
  const run = taskRuns.find(item => item.id === runId);
  const latest = taskRuns.find(item => item.result);
  if (!run || latest?.id !== run.id || taskRuns.some(item => item.nativeState !== 'settled') ||
    run.nativeState !== 'settled' || run.settlement?.outcome !== 'completed' || run.publication?.state !== 'recorded' ||
    run.result?.candidate !== candidate || run.review?.candidate !== candidate || run.review.interactionId !== interactionId) return null;
  return run;
}

function matchingInteraction(run, interactions, interactionId, candidate) {
  const matches = interactions.filter(item => (item.id === interactionId ||
    item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}`) && item.kind === 'request_confirmation' &&
    item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}` &&
    canonical(item.payload?.target) === canonical({ type: 'custom', key: 'herdr-relay-candidate', revisionId: candidate, label: run.id }));
  return matches.length === 1 ? matches[0] : null;
}

async function inspect(store, api, companyId, taskId) {
  const path = `/api/issues/${encodeURIComponent(taskId)}`;
  const task = await api('GET', path);
  requireValue(task?.id === taskId && task.companyId === companyId && typeof task.title === 'string' &&
    typeof task.description === 'string' && task.descriptionTruncated !== true && typeof task.status === 'string',
  'invalid_backend_response', 'Expected a complete company-scoped task', 502);
  const interactions = await api('GET', `${path}/interactions`);
  requireValue(Array.isArray(interactions) && interactions.every(item => item && typeof item.status === 'string' &&
    (item.companyId === undefined || item.companyId === companyId) && (item.issueId === undefined || item.issueId === taskId)),
  'invalid_backend_response', 'Invalid task interactions', 502);
  const taskRuns = store.runs().filter(run => run.request.companyId === companyId && run.request.taskId === taskId);
  const run = taskRuns.find(item => item.result);
  const item = run?.review && matchingInteraction(run, interactions, run.review.interactionId, run.result?.candidate);
  const review = task.status === 'in_review' && run && item?.status === 'pending' &&
    localReview(store, companyId, taskId, run.id, item.id, run.result.candidate)
    ? { runId: run.id, interactionId: item.id, candidate: run.result.candidate, summary: run.result.summary }
    : null;
  const revision = digest([publicTask(task), interactions, taskRuns.map(value => ({ id: value.id, request: value.request,
    nativeState: value.nativeState, result: value.result, review: value.review, publication: value.publication, settlement: value.settlement }))]);
  return { task, interactions, run, item, review, revision };
}

export async function taskBoardDetail(store, api, input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['companyId', 'taskId'].includes(key)), 'invalid_request', 'Unsupported board detail field');
  const companyId = text(input.companyId, 'companyId'), taskId = text(input.taskId, 'taskId');
  const detail = await inspect(store, api, companyId, taskId);
  const comments = await readTaskComments(api, { companyId, taskId });
  return { task: publicTask(detail.task), revision: detail.revision, review: detail.review,
    result: detail.run?.result ? { runId: detail.run.id, summary: detail.run.result.summary,
      candidate: detail.run.result.candidate, deliverables: detail.run.result.deliverables ?? null,
      checks: detail.run.result.checks ?? null } : null,
    comments: comments.slice(-3).map(comment => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt,
      authorAgentId: comment.authorAgentId ?? null, authorUserId: comment.authorUserId ?? null })) };
}

export async function taskBoardReview(store, api, input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['action', 'companyId', 'taskId', 'runId', 'interactionId', 'candidate', 'expectedRevision', 'key', 'reason'].includes(key)),
  'invalid_request', 'Unsupported board review field');
  const action = text(input.action, 'action');
  requireValue(['accept', 'reject'].includes(action), 'invalid_review_action', 'Choose accept or reject');
  const companyId = text(input.companyId, 'companyId'), taskId = text(input.taskId, 'taskId');
  const runId = text(input.runId, 'runId'), interactionId = text(input.interactionId, 'interactionId');
  const candidate = text(input.candidate, 'candidate'), expectedRevision = text(input.expectedRevision, 'expectedRevision');
  const key = text(input.key, 'key');
  const reason = action === 'reject' ? text(input.reason, 'reason').trim() : null;
  requireValue(action !== 'reject' || reason && reason.length <= 4000, 'invalid_request', 'Rejection feedback is required and limited to 4000 characters');
  const id = `harness-review:${digest([companyId, interactionId])}`;
  const request = { bindingId: 'operator-board', conversationId: 'operator-board', companyId, taskId, interactionId, candidate,
    sourceMessageId: key, sourceDigest: digest([key, expectedRevision]), decision: action, reason };
  let operation = store.operation(id);
  if (operation) requireValue(operation.runId === runId && operation.resultDigest === digest(store.run(runId).result) &&
    canonical(operation.request) === canonical(request), 'review_conflict', 'Another review decision already owns this candidate', 409);
  const current = await inspect(store, api, companyId, taskId);
  const run = localReview(store, companyId, taskId, runId, interactionId, candidate);
  requireValue(run && current.run?.id === runId && current.item?.id === interactionId,
    'stale_candidate', 'The selected candidate is no longer current', 409);
  const targetStatus = action === 'accept' ? 'accepted' : 'rejected';
  const receipt = harnessReviewReceipt(request);
  if (operation?.state === 'recorded') {
    requireValue(current.item.status === targetStatus && harnessReviewDecision(run, request, current.item),
      'review_uncertain', 'Backend no longer confirms the recorded decision', 409);
    return { receipt, state: 'recorded' };
  }
  if (current.item.status === targetStatus) {
    requireValue(operation && harnessReviewDecision(run, request, current.item),
      'review_uncertain', 'Backend decision lacks the exact Relay intent', 409);
    store.recordReview(run.id, { interactionId, candidate, status: targetStatus, observedAt: new Date().toISOString() });
    store.saveOperation({ ...operation, state: 'recorded', receipt });
    return { receipt, state: 'recorded', reconciled: true };
  }
  requireValue(current.revision === expectedRevision && current.task.status === 'in_review' && current.item.status === 'pending',
    'stale_candidate', 'Task or candidate changed after the detail preview', 409);
  requireValue(!operation, 'review_uncertain', 'Review was attempted but is not confirmed; no repost is authorised', 409);
  const coordinator = store.operation(`review-decision:${digest([companyId, taskId])}`);
  requireValue(!coordinator || coordinator.state === 'recorded' && coordinator.targetRunId !== run.id && coordinator.candidate !== candidate,
    'review_conflict', 'A coordinator review intent already owns this task or candidate', 409);
  operation = store.saveOperation({ id, runId, request, resultDigest: digest(run.result), state: 'uncertain' });
  const path = `/api/issues/${encodeURIComponent(taskId)}/interactions/${encodeURIComponent(interactionId)}/${action}`;
  await api('POST', path, reason ? { reason } : {});
  const updated = await inspect(store, api, companyId, taskId);
  const latestRun = localReview(store, companyId, taskId, runId, interactionId, candidate);
  requireValue(latestRun && updated.item && harnessReviewDecision(latestRun, request, updated.item),
    'review_uncertain', 'Backend has not confirmed the exact human decision', 409);
  store.recordReview(run.id, { interactionId, candidate, status: targetStatus, observedAt: new Date().toISOString() });
  store.saveOperation({ ...operation, state: 'recorded', receipt });
  return { receipt, state: 'recorded' };
}
