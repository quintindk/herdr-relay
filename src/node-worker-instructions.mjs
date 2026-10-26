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
  return `Use the actual Relay function tools, not shell commands or printed tool-call markup.
Call relay_work_read to inspect your exact execution and cancellation state.
If it reports a local conflict, inspect the returned reason and stop effects. Attachment is not proof the run is usable.
For an interactive execution with a task ID, relay_cli supports ordinary reads and comments/updates on that exact assigned task using worker scope, not human operator credentials. Scheduled runs can be taskless: use their result/question tools instead of inventing a task or borrowing operator authority.
${execution.allowDelegation ? 'Bounded delegation is granted: use relay_delegate and relay_wait_children, then finish the turn.\n' : ''}${execution.childExecutionIds?.length ? 'Use relay_children to refresh direct child results. Only relay_review_child grants permit child review. Final root review remains human.\n' : ''}To ask asynchronously, call relay_work_ask with {key,prompt,humanRequired}, then finish the turn.
Otherwise call relay_work_submit with {key,candidate,summary}. Derive a unique key and candidate from the current execution ID. After successful submission, finish the turn immediately.
Do not claim a submission succeeded unless the tool returned success. Do not read credentials.
`;
}
