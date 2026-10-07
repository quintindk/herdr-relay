import { canonical, digest, requireValue, text } from './protocol.mjs';
import { taskOrigins } from './task-origin.mjs';
import { isNotificationSource } from './completion-notifications.mjs';
import { harnessReviewDecision, harnessReviewReceipt } from './harness-review-reconciliation.mjs';

export function parseRelayAnswer(value) {
  const match = typeof value === 'string' && value.match(/^Relay answer ([a-zA-Z0-9-]+):\s*([\s\S]+)$/i);
  requireValue(match && match[2].trim().length && match[2].trim().length <= 4000,
    'explicit_answer_required', 'Use exactly: Relay answer INTERACTION_ID: your answer');
  return { interactionId: match[1], answer: match[2].trim() };
}

export async function harnessQuestion(store, bridge, action, input, api) {
  requireValue(bridge.state === 'armed', 'bridge_unavailable', 'Question relay requires an armed bridge', 409);
  const runs = store.runs(bridge.identity.bindingId);
  const waiting = runs.filter(run => run.nativeState === 'settled' && run.settlement?.outcome === 'waiting' &&
    run.waiting?.state === 'recorded');
  if (action === 'questions') {
    const questions = [];
    for (const run of waiting) {
      const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
      const issue = await api('GET', path);
      if (issue.companyId !== run.request.companyId || ['done', 'cancelled'].includes(issue.status)) continue;
      const interactions = await api('GET', `${path}/interactions`);
      const item = interactions.find(item => item.id === run.waiting.interactionId && item.kind === 'ask_user_questions' && item.status === 'pending');
      if (item) questions.push({ taskId: issue.id, identifier: issue.identifier, runId: run.id,
        interactionId: item.id, question: run.waiting.payload.question });
    }
    return { questions };
  }
  const source = input.source;
  requireValue(source && typeof source.text === 'string' && Number.isSafeInteger(source.createdAt), 'invalid_answer_source', 'Native source message required');
  const sourceId = text(source.id, 'source.id');
  // Old loaded plugins still send the explicit command. New plugins send the
  // permission-confirmed answer separately, retaining the original user source.
  const { interactionId, answer } = input.answer !== undefined
    ? { interactionId: text(input.interactionId, 'interactionId'), answer: text(input.answer, 'answer').trim() }
    : parseRelayAnswer(source.text);
  requireValue(answer.length <= 4000 && source.text.length <= 16000, 'invalid_answer_source', 'Answer or source exceeds allowed length');
  const run = waiting.find(run => run.waiting.interactionId === interactionId);
  requireValue(run, 'question_not_found', 'Question does not belong to a settled waiting turn in this conversation', 404);
  const id = `harness-answer:${digest([run.request.companyId, interactionId])}`;
  const request = { bindingId: bridge.identity.bindingId, conversationId: bridge.identity.conversationId,
    taskId: run.request.taskId, interactionId, sourceMessageId: sourceId, sourceDigest: digest(source.text), answer };
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'answer_conflict', 'A different harness answer was already recorded for this question', 409);
    if (operation.state === 'recorded') return operation.receipt;
  }
  requireValue(!runs.some(item => item.invocation?.messageId === sourceId) &&
    !run.invocation?.priorUserIds.includes(sourceId) && source.createdAt > Date.parse(run.createdAt),
    'invalid_answer_source', 'Answer must originate after the waiting invocation, not from its prompt/history', 409);
  const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
  const issue = await api('GET', path);
  requireValue(issue.id === run.request.taskId && issue.companyId === run.request.companyId &&
    issue.assigneeAgentId === run.request.agentId && !['done', 'cancelled'].includes(issue.status),
  'question_scope_changed', 'Task is no longer assigned to this conversation', 409);
  const interactions = await api('GET', `${path}/interactions`);
  const item = interactions.find(item => item.id === interactionId);
  requireValue(item?.kind === 'ask_user_questions' && item.idempotencyKey === run.waiting.request.idempotencyKey &&
    item.sourceRunId === (run.backendRunId ?? run.request.runId) && item.continuationPolicy === 'wake_assignee',
  'question_conflict', 'Backend question identity or continuation policy changed', 409);
  const questions = item.payload?.questions;
  requireValue(questions?.length === 1 && questions[0].id === 'answer' && questions[0].options?.some(option => option.id === 'text' && option.freeText),
    'unsupported_question', 'Harness replies currently support Relay single free-text questions only', 409);
  const sameAnswer = value => value?.status === 'answered' && value.result?.answers?.length === 1 &&
    value.result.answers[0].questionId === 'answer' && value.result.answers[0].otherText === answer &&
    (value.result.answers[0].optionIds ?? []).every(id => id === 'text');
  const receipt = { answered: true, taskId: run.request.taskId, interactionId,
    continuation: 'Paperclip owns the continuation. End this turn; do not execute the task inline.' };
  if (item.status === 'answered') {
    requireValue(sameAnswer(item), 'answer_conflict', 'Paperclip already holds a different answer', 409);
    store.saveOperation({ id, runId: run.id, request, state: 'recorded', receipt: { ...receipt, existing: true } });
    return { ...receipt, existing: true };
  }
  requireValue(item.status === 'pending', 'question_closed', 'Question is no longer pending', 409);
  requireValue(!operation, 'answer_uncertain', 'An answer was attempted but is not confirmed. Do not repost.', 409);
  requireValue(!runs.some(item => item.nativeState !== 'settled'), 'conversation_busy', 'Another Relay turn is active', 409);
  operation = store.saveOperation({ id, runId: run.id, request, state: 'uncertain' });
  await api('POST', `${path}/interactions/${encodeURIComponent(interactionId)}/respond`, {
    answers: [{ questionId: 'answer', optionIds: ['text'], otherText: answer }],
    summaryMarkdown: `Answer relayed from the reserved OpenCode conversation ${bridge.identity.conversationId}, source message ${sourceId}. ` +
      'Submitted by the Relay operator connector from a permission-checked harness answer tool. This is not a separate authenticated Paperclip human session.',
  });
  const updated = (await api('GET', `${path}/interactions`)).find(item => item.id === interactionId);
  requireValue(sameAnswer(updated), 'answer_uncertain', 'Backend has not confirmed the exact answer', 409);
  store.saveOperation({ ...operation, state: 'recorded', receipt });
  return receipt;
}

export async function harnessReview(store, bridge, action, input, api) {
  const caller = store.binding(bridge.identity.bindingId);
  const checkCaller = (readingDecision = false) => {
    const current = store.operation(bridge.id);
    requireValue(current?.state === 'armed', 'bridge_unavailable', 'Review relay requires an armed bridge', 409);
    requireValue(canonical(current.identity) === canonical(bridge.identity) && current.tokenHash === bridge.tokenHash &&
      current.epoch === bridge.epoch && current.sessionCreatedAt === bridge.sessionCreatedAt &&
      current.controlRevision === bridge.controlRevision && canonical(store.binding(caller.id)) === canonical(caller) &&
      Number.isSafeInteger(bridge.sessionCreatedAt) && bridge.sessionCreatedAt > 0 &&
      !caller.lifecycleState && caller.config.conversationId === bridge.identity.conversationId,
    'bridge_identity_mismatch', 'Review caller identity or session changed', 409);
    requireValue(readingDecision || store.runs(caller.id).every(run => run.nativeState === 'settled'),
      'conversation_busy', 'Another Relay turn is active in this conversation', 409);
  };
  const scope = run => {
    if (run.request.companyId !== caller.config.companyId) return null;
    if (run.request.bindingId === caller.id && run.conversationId === bridge.identity.conversationId) return 'local';
    const tasks = taskOrigins(store);
    return tasks.some(task => task.state === 'recorded' && task.request?.companyId === caller.config.companyId &&
      task.receipt?.companyId === caller.config.companyId && task.receipt.id === run.request.taskId &&
      task.request.body?.assigneeAgentId === run.request.agentId && task.request.origin?.bindingId === caller.id &&
      task.request.origin.conversationId === bridge.identity.conversationId &&
      task.request.origin.sessionCreatedAt === bridge.sessionCreatedAt) ? 'delegated' : null;
  };
  const currentScope = run => {
    const operation = reviewOperation(run);
    checkCaller(true);
    if (!operation && listing && store.runs(caller.id).some(item => item.nativeState !== 'settled')) return null;
    checkCaller(Boolean(operation));
    const taskRuns = store.runs().filter(item => item.request.companyId === run.request.companyId && item.request.taskId === run.request.taskId);
    const latest = operation ? taskRuns.find(item => item.id === run.id) : taskRuns.find(item => item.result);
    if ((!operation && taskRuns.some(item => item.nativeState !== 'settled')) || latest?.id !== run.id || latest.nativeState !== 'settled' ||
      latest.settlement?.outcome !== 'completed' || latest.publication?.state !== 'recorded' ||
      !latest.review || latest.review.candidate !== latest.result.candidate ||
      latest.review.interactionId !== run.review?.interactionId || canonical(latest.result) !== canonical(run.result) ||
      canonical(latest.request) !== canonical(run.request)) return null;
    return scope(latest);
  };
  const listing = action === 'reviews';
  if (!listing) requireValue(['accept', 'reject'].includes(input.decision), 'invalid_review_action', 'Choose accept or reject');
  const interactionId = listing ? null : text(input.interactionId, 'interactionId');
  const reviewOperation = run => {
    const operation = store.operation(`harness-review:${digest([run.request.companyId, run.review.interactionId])}`);
    return ['uncertain', 'recorded'].includes(operation?.state) && operation.runId === run.id && operation.request?.candidate === run.result.candidate &&
      (operation.resultDigest === undefined || operation.resultDigest === digest(run.result)) &&
      operation.request.interactionId === run.review.interactionId &&
      (operation.request.companyId === undefined || operation.request.companyId === run.request.companyId) &&
      (operation.request.taskId === undefined || operation.request.taskId === run.request.taskId) ? operation : null;
  };
  checkCaller(store.runs().some(run => run.result && run.review && (listing || run.review.interactionId === interactionId) &&
    reviewOperation(run)?.request.bindingId === caller.id));
  const reviews = [];
  for (const run of store.runs().filter(run => run.result && run.review && (listing || run.review.interactionId === interactionId))) {
    const operation = reviewOperation(run);
    const reviewScope = currentScope(run);
    if (!reviewScope) continue;
    if (!listing) requireValue(input.candidate === undefined || input.candidate === run.result.candidate,
      'stale_candidate', 'The permission-selected candidate is no longer current', 409);
    const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
    const issue = await api('GET', path);
    if (currentScope(run) !== reviewScope) continue;
    if (issue.id !== run.request.taskId || issue.companyId !== run.request.companyId ||
      issue.assigneeAgentId !== run.request.agentId || (!operation && (issue.executionRunId || ['done', 'cancelled'].includes(issue.status)))) continue;
    const interactions = await api('GET', `${path}/interactions`);
    if (currentScope(run) !== reviewScope) continue;
    const item = interactions.find(item => item.id === run.review.interactionId &&
      item.kind === 'request_confirmation' && item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}` &&
      canonical(item.payload?.target) === canonical({ type: 'custom', key: 'herdr-relay-candidate', revisionId: run.result.candidate, label: run.id }));
    if (item && (!['done', 'cancelled'].includes(issue.status) || (operation && harnessReviewDecision(run, operation.request, item))))
      reviews.push({ run, item, issue, operation, scope: reviewScope });
  }
  if (listing) {
    const decisions = store.runs().filter(run => run.result && run.review && currentScope(run)).flatMap(run => {
      const operation = reviewOperation(run);
      const request = operation?.request;
      if (!request || request.bindingId !== caller.id || request.conversationId !== bridge.identity.conversationId ||
        (request.sessionCreatedAt !== undefined && request.sessionCreatedAt !== bridge.sessionCreatedAt) ||
        !['accept', 'reject'].includes(request.decision) || !['uncertain', 'recorded'].includes(operation.state)) return [];
      const { interactionId, candidate, decision, sourceMessageId, sourceDigest } = request;
      const receipt = operation.receipt;
      return [{ interactionId, candidate, decision, sourceMessageId, sourceDigest, state: operation.state,
        ...(operation.state === 'recorded' && receipt?.interactionId === interactionId &&
          receipt.status === (decision === 'accept' ? 'accepted' : 'rejected') ? { receipt: {
            interactionId, status: receipt.status, attribution: receipt.attribution, continuation: receipt.continuation,
          } } : {}) }];
    });
    return { reviews: reviews.filter(({ run, item, issue, operation, scope }) => !operation && !issue.executionRunId && item.status === 'pending' && currentScope(run) === scope).map(({ run, item, issue, scope }) => ({
      scope, runId: run.id, taskId: issue.id, identifier: typeof issue.identifier === 'string' ? issue.identifier.slice(0, 128) : null,
      title: typeof issue.title === 'string' ? issue.title.slice(0, 512) : null,
      interactionId: item.id, candidate: run.result.candidate, summary: run.result.summary,
    })), ...(decisions.length ? { decisions } : {}) };
  }
  const selected = reviews.find(({ item }) => item.id === interactionId);
  requireValue(selected, 'review_not_found', 'No current exact candidate review in this conversation', 404);
  const { run, item, issue } = selected;
  let expectedOperation = selected.operation;
  const source = input.source;
  const check = () => {
    requireValue(currentScope(run) === selected.scope, 'stale_candidate', 'Candidate or review scope changed', 409);
    requireValue(!expectedOperation || canonical(store.operation(`harness-review:${digest([run.request.companyId, interactionId])}`)) === canonical(expectedOperation),
      'review_conflict', 'Persisted review intent changed', 409);
    requireValue(source && typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
      Number.isSafeInteger(source.createdAt) && source.createdAt > Date.parse(item.createdAt ?? run.createdAt) &&
      source.createdAt >= bridge.sessionCreatedAt && source.createdAt <= Date.now() &&
      typeof source.id === 'string' && source.id.trim() && source.id.length <= 65536 &&
      source.synthetic !== true && source.ignored !== true && (source.role === undefined || source.role === 'user') &&
      !isNotificationSource(store, bridge, source.id) &&
      !store.runs().some(item => item.invocation?.messageId === source.id) &&
      !store.run(run.id).invocation?.priorUserIds?.includes(source.id),
    'invalid_answer_source', 'A later native human message, not a notification or worker prompt, is required');
  };
  check();
  const reason = input.decision === 'reject' ? text(input.reason, 'reason').trim() : null;
  requireValue(!reason || reason.length <= 4000, 'invalid_request', 'Review reason exceeds 4000 characters');
  const checkIssue = (value, readingDecision = false) => requireValue(value.id === run.request.taskId && value.companyId === run.request.companyId &&
    value.assigneeAgentId === run.request.agentId && ((readingDecision && operation) ||
      (!value.executionRunId && !['done', 'cancelled'].includes(value.status))),
  'review_scope_changed', 'Task is no longer available for this exact candidate review', 409);
  const freshIssue = await api('GET', `/api/issues/${encodeURIComponent(run.request.taskId)}`);
  check();
  const id = `harness-review:${digest([issue.companyId, interactionId])}`;
  const request = { bindingId: bridge.identity.bindingId, conversationId: bridge.identity.conversationId,
    companyId: run.request.companyId, taskId: run.request.taskId, sessionCreatedAt: bridge.sessionCreatedAt,
    interactionId, candidate: run.result.candidate, sourceMessageId: source.id, sourceDigest: digest(source.text), decision: input.decision, reason };
  // No await between the shared company/interaction intent check and persistence:
  // origin and worker chats must not race through separate binding-level locks.
  let operation = store.operation(id);
  const coordinator = store.operation(`review-decision:${digest([run.request.companyId, run.request.taskId])}`);
  requireValue(operation || !coordinator || (coordinator.state === 'recorded' && coordinator.targetRunId !== run.id &&
    coordinator.candidate !== run.result.candidate),
  'review_conflict', 'A coordinator review intent already owns this task or candidate', 409);
  if (operation) {
    requireValue(operation.runId === run.id && (operation.resultDigest === undefined || operation.resultDigest === digest(run.result)) &&
      canonical({ companyId: run.request.companyId, taskId: run.request.taskId,
      sessionCreatedAt: bridge.sessionCreatedAt, ...operation.request }) === canonical(request),
    'review_conflict', 'Another harness decision was already recorded', 409);
  }
  checkIssue(freshIssue, Boolean(operation));
  const targetStatus = input.decision === 'accept' ? 'accepted' : 'rejected';
  const receipt = harnessReviewReceipt(request);
  if (operation?.state === 'recorded') {
    requireValue(operation.receipt?.interactionId === interactionId && operation.receipt.status === targetStatus,
      'review_conflict', 'Recorded receipt does not match this decision', 409);
    requireValue(harnessReviewDecision(run, request, item), 'review_uncertain', 'Backend has not confirmed the exact human decision', 409);
    if (item.status === targetStatus) store.recordReview(run.id, { interactionId, candidate: run.result.candidate,
      status: targetStatus, observedAt: new Date().toISOString() });
    return operation.receipt;
  }
  if (item.status === targetStatus) {
    requireValue(harnessReviewDecision(run, request, item), 'review_uncertain', 'Backend has not confirmed the exact human decision', 409);
    store.recordReview(run.id, { interactionId, candidate: run.result.candidate, status: targetStatus, observedAt: new Date().toISOString() });
    store.saveOperation({ ...(operation ?? { id, runId: run.id, request, resultDigest: digest(run.result) }), state: 'recorded', receipt }); return receipt;
  }
  requireValue(item.status === 'pending', 'review_conflict', 'Paperclip review already has another decision', 409);
  requireValue(!operation, 'review_uncertain', 'Review was attempted but is not confirmed; no repost is authorised', 409);
  // The accept endpoint has no provenance field. Retain it locally rather than
  // posting a comment that could expire this review or wake another worker.
  operation = store.saveOperation({ id, runId: run.id, request, resultDigest: digest(run.result), state: 'uncertain' });
  expectedOperation = operation;
  const path = `/api/issues/${encodeURIComponent(issue.id)}/interactions`;
  await api('POST', `${path}/${encodeURIComponent(item.id)}/${input.decision}`, reason ? { reason } : {});
  check();
  const updatedIssue = await api('GET', `/api/issues/${encodeURIComponent(run.request.taskId)}`);
  check();
  // Continuation or closure may race a committed decision. This is readback only.
  checkIssue(updatedIssue, true);
  const interactions = await api('GET', path);
  check();
  const matches = interactions.filter(row => row.id === item.id || row.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}`);
  requireValue(matches.length === 1 && harnessReviewDecision(run, request, matches[0]),
  'review_uncertain', 'Backend has not confirmed the exact candidate decision', 409);
  store.recordReview(run.id, { interactionId, candidate: run.result.candidate, status: targetStatus, observedAt: new Date().toISOString() });
  store.saveOperation({ ...operation, state: 'recorded', receipt });
  return receipt;
}
