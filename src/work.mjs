import { canonical, digest, requireValue, text } from './protocol.mjs';

export function questionPayload(run, input) {
  const question = text(input.question, 'question');
  const key = text(input.key, 'key');
  requireValue(question.length <= 4000, 'invalid_question', 'Question exceeds 4000 characters');
  return { key, question, request: {
    kind: 'ask_user_questions', idempotencyKey: `relay:${run.id}:${digest(key)}`,
    sourceRunId: run.backendRunId ?? run.request.runId,
    continuationPolicy: 'wake_assignee', title: 'Relay clarification',
    ...(input.addresseeAgentId ? { addresseeAgentId: text(input.addresseeAgentId, 'addresseeAgentId') } : {}),
    ...(input.addresseeUserId ? { addresseeUserId: text(input.addresseeUserId, 'addresseeUserId') } : {}),
    payload: { version: 1, questions: [{ id: 'answer', prompt: question, selectionMode: 'single', required: true,
      options: [{ id: 'text', label: 'Answer', freeText: true }] }] },
  } };
}

export async function publishQuestion(store, id, token, api) {
  let run = store.run(id);
  if (!run.waiting || run.waiting.state === 'recorded') return run;
  const path = `/api/issues/${encodeURIComponent(run.request.taskId)}/interactions`;
  if (run.waiting.state === 'uncertain') {
    const interactions = await api(run, token, 'GET', path);
    requireValue(Array.isArray(interactions), 'invalid_backend_response', 'Expected interaction array', 502);
    const receipt = interactions.find(item => item.idempotencyKey === run.waiting.request.idempotencyKey);
    if (receipt) {
      requireValue(receipt.kind === 'ask_user_questions' && canonical(receipt.payload) === canonical(run.waiting.request.payload),
        'question_conflict', 'Backend interaction does not match the recorded question', 409);
      return store.questionReceipt(id, { state: 'recorded', interactionId: receipt.id });
    }
    // This endpoint has a persisted idempotency key. Identical payload replay is
    // permitted here, unlike comment publication which has no such guarantee.
  }
  run = store.questionReceipt(id, { state: 'uncertain' });
  const receipt = await api(run, token, 'POST', path, run.waiting.request);
  requireValue(typeof receipt.id === 'string', 'invalid_backend_response', 'Missing interaction receipt', 502);
  return store.questionReceipt(id, { state: 'recorded', interactionId: receipt.id });
}
