import { requireValue } from './protocol.mjs';

export function usesV2WorkerTools(entry) {
  // Existing external chats may explicitly use their already-available shell.
  // This selects instructions only. It never grants shell permission.
  requireValue(entry.workerTransport === undefined || ['tools', 'cli'].includes(entry.workerTransport),
    'invalid_worker_transport', 'Worker transport must be tools or cli');
  requireValue(entry.workerTransport === undefined || entry.harness === 'opencode-v2',
    'invalid_worker_transport', 'Transport override requires an external OpenCode v2 binding');
  return entry.harness.startsWith('opencode-v2') && entry.workerTransport !== 'cli';
}

// Session policy is explicit operator configuration, never an automatic grant.
export async function configureV2WorkerSession(binding, permissions) {
  if (permissions === undefined) return;
  requireValue(Array.isArray(permissions) && permissions.every(rule => rule &&
    Object.keys(rule).every(key => ['action', 'resource', 'effect'].includes(key)) &&
    typeof rule.action === 'string' && rule.action && typeof rule.resource === 'string' &&
    ['allow', 'deny', 'ask'].includes(rule.effect)), 'invalid_permissions', 'Explicit V2 session permission rules required');
  await binding.native.client.session.update({ sessionID: binding.identity.sessionId, permissions });
}

// V2 bindings default to direct scoped tools. Do not also advertise shell commands,
// which can be unavailable under the worker's deliberately restricted policy.
export function v2WorkerInstructions(execution) {
  return `Read relay_work_read for this execution, current input and cancellation state. Perform the authorised goal with the granted business tools without seeking repeated approval. Use Relay function tools for coordination; shell/MCP/file work follows its own granted permissions.
For a conflict or cancellation, stop effects for this execution and inspect the reported cause. This does not restrict unrelated human-authorised work in another context.
For task-bound interactive work, relay_cli supports assigned-task reads, comments and updates using worker scope. Scheduled runs may be taskless.
${execution.collaboration ? `This job permits collaboration with ${execution.collaboration.peerAgentIds.join(', ')} for at most ${execution.collaboration.maxRounds} peer executions, through ${execution.collaboration.deadline}. Use relay_delegate to request peer work, then finish this native turn. Relay waits and resumes you with the peer's result or failure; a separate wait call is unnecessary.\n` : execution.allowDelegation ? 'Delegation is granted. Use relay_delegate and relay_wait_children, then finish the turn.\n' : ''}${execution.childExecutionIds?.length ? 'Use relay_children to inspect peer outcomes and continue this goal. Technical use of a peer result needs no extra approval. Only a formal relay_review_child decision needs its specified review grant.\n' : ''}If a required decision is missing, call relay_work_ask with {key,prompt,humanRequired} and finish after successful staging. Set humanRequired only for a decision needing human authority.
When the goal is complete, call relay_work_submit with {key,candidate,summary} and finish after success. Report actual results, limitations and checks. Follow the execution's review policy; do not invent completion or read credential files.
`;
}
