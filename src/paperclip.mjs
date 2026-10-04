import { resultBody, requireValue } from './protocol.mjs';

export function paperclipClient(base) {
  const url = new URL(base);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'invalid_backend', 'Paperclip URL must be HTTP(S), without embedded credentials');
  return async (run, token, method, path, body) => {
    const response = await fetch(new URL(path, url), {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Paperclip-Run-Id': run.backendRunId ?? run.request.runId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    requireValue(response.ok, 'paperclip_error', `Paperclip returned HTTP ${response.status}`, 502);
    return response.json();
  };
}

// No replay after an uncertain POST. Reading a receipt is safe, absence is not
// evidence that the original request cannot still commit.
export async function publish(store, id, token, api) {
  let run = store.run(id);
  if (!run.result || run.publication.state === 'recorded') return run;
  const body = resultBody(run);
  const path = `/api/issues/${encodeURIComponent(run.request.taskId)}/comments`;
  if (run.publication.state === 'uncertain') {
    const comments = await api(run, token, 'GET', path);
    requireValue(Array.isArray(comments), 'invalid_backend_response', 'Expected comments array', 502);
    const receipt = comments.find(comment => comment.body === body &&
      comment.authorAgentId === run.request.agentId && comment.createdByRunId === (run.publication.backendRunId ?? run.request.runId));
    return receipt ? store.publication(id, { ...run.publication, state: 'recorded', commentId: receipt.id }) : run;
  }
  // Commit before sending. A crash at either side of POST leaves uncertainty.
  run = store.publication(id, { state: 'uncertain', backendRunId: run.backendRunId ?? run.request.runId });
  const receipt = await api(run, token, 'POST', path, { body });
  requireValue(typeof receipt.id === 'string', 'invalid_backend_response', 'Missing comment receipt', 502);
  return store.publication(id, { ...run.publication, state: 'recorded', commentId: receipt.id });
}

export async function verifyRecovery(run, request, token, api) {
  const oldId = run.backendRunId ?? run.request.runId;
  const replacement = { ...run, backendRunId: request.runId };
  const previous = await api(replacement, token, 'GET', `/api/heartbeat-runs/${encodeURIComponent(oldId)}`);
  const current = await api(replacement, token, 'GET', `/api/heartbeat-runs/${encodeURIComponent(request.runId)}`);
  requireValue(previous.id === oldId && previous.companyId === run.request.companyId && previous.agentId === run.request.agentId &&
    ['failed', 'cancelled', 'timed_out', 'interrupted'].includes(previous.status),
  'recovery_not_authorised', 'Previous backend run must be terminal and belong to this agent', 409);
  const taskId = current.contextSnapshot?.taskId ?? current.contextSnapshot?.issueId;
  requireValue(current.id === request.runId && current.companyId === run.request.companyId && current.agentId === run.request.agentId &&
    current.status === 'running' && taskId === run.request.taskId,
  'recovery_not_authorised', 'Replacement backend run must be running for the same task and agent', 409);
}
