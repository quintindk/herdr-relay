import { canonical, digest, requireValue, text } from './protocol.mjs';

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
  requireValue(bridge.state === 'armed', 'bridge_unavailable', 'Review relay requires an armed bridge', 409);
  const runs = store.runs(bridge.identity.bindingId);
  const reviews = [];
  for (const run of runs.filter(run => run.nativeState === 'settled' && run.settlement?.outcome === 'completed' &&
    run.publication.state === 'recorded' && run.review)) {
    const latest = store.runs().find(item => item.request.companyId === run.request.companyId && item.request.taskId === run.request.taskId && item.result);
    if (latest?.id !== run.id) continue;
    const path = `/api/issues/${encodeURIComponent(run.request.taskId)}`;
    const issue = await api('GET', path);
    if (issue.id !== run.request.taskId || issue.companyId !== run.request.companyId ||
      issue.assigneeAgentId !== run.request.agentId || ['done', 'cancelled'].includes(issue.status)) continue;
    const item = (await api('GET', `${path}/interactions`)).find(item => item.id === run.review.interactionId &&
      item.kind === 'request_confirmation' && item.idempotencyKey === `relay-review:${run.id}:${digest(run.result)}` &&
      canonical(item.payload?.target) === canonical({ type: 'custom', key: 'herdr-relay-candidate', revisionId: run.result.candidate, label: run.id }));
    if (item) reviews.push({ run, item, issue });
  }
  if (action === 'reviews') return { reviews: reviews.filter(({ item }) => item.status === 'pending').map(({ run, item, issue }) => ({
    taskId: issue.id, identifier: issue.identifier, interactionId: item.id, candidate: run.result.candidate, summary: run.result.summary,
  })) };
  requireValue(['accept', 'reject'].includes(input.decision), 'invalid_review_action', 'Choose accept or reject');
  const interactionId = text(input.interactionId, 'interactionId');
  const selected = reviews.find(({ item }) => item.id === interactionId);
  requireValue(selected, 'review_not_found', 'No current exact candidate review in this conversation', 404);
  const { run, item, issue } = selected;
  const source = input.source;
  requireValue(source && typeof source.text === 'string' && source.text.trim() && source.text.length <= 16000 &&
    Number.isSafeInteger(source.createdAt) && source.createdAt > Date.parse(item.createdAt ?? run.createdAt) &&
    typeof source.id === 'string' && !runs.some(item => item.invocation?.messageId === source.id) && !run.invocation?.priorUserIds.includes(source.id),
  'invalid_answer_source', 'A later native user message, not the worker prompt, is required');
  const reason = input.decision === 'reject' ? text(input.reason, 'reason') : null;
  requireValue(!reason || reason.length <= 4000, 'invalid_request', 'Review reason exceeds 4000 characters');
  const id = `harness-review:${digest([issue.companyId, interactionId])}`;
  const request = { bindingId: bridge.identity.bindingId, conversationId: bridge.identity.conversationId,
    interactionId, candidate: run.result.candidate, sourceMessageId: source.id, sourceDigest: digest(source.text), decision: input.decision, reason };
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'review_conflict', 'Another harness decision was already recorded', 409);
    if (operation.state === 'recorded') return operation.receipt;
  }
  const targetStatus = input.decision === 'accept' ? 'accepted' : 'rejected';
  const receipt = { interactionId, status: targetStatus, attribution: 'Relay operator connector; native source recorded in private harness-review receipt.',
    continuation: 'End this turn. Relay/Paperclip own subsequent completion; do not mark the issue Done yourself.' };
  if (item.status === targetStatus) {
    store.saveOperation({ id, runId: run.id, request, state: 'recorded', receipt }); return receipt;
  }
  requireValue(item.status === 'pending', 'review_conflict', 'Paperclip review already has another decision', 409);
  requireValue(!operation, 'review_uncertain', 'Review was attempted but is not confirmed; no repost is authorised', 409);
  requireValue(!runs.some(item => item.nativeState !== 'settled') && !issue.executionRunId, 'conversation_busy', 'Task or conversation has active work', 409);
  // The accept endpoint has no provenance field. Retain it locally rather than
  // posting a comment that could expire this review or wake another worker.
  operation = store.saveOperation({ id, runId: run.id, request, state: 'uncertain' });
  const path = `/api/issues/${encodeURIComponent(issue.id)}/interactions`;
  await api('POST', `${path}/${encodeURIComponent(item.id)}/${input.decision}`, reason ? { reason } : {});
  const updated = (await api('GET', path)).find(row => row.id === item.id);
  requireValue(updated?.status === targetStatus, 'review_uncertain', 'Backend has not confirmed the decision', 409);
  store.saveOperation({ ...operation, state: 'recorded', receipt });
  return receipt;
}
