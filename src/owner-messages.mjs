import { now, requireValue } from './protocol.mjs';
import { headlessRunAuthority, headlessProbeId } from './headless-setup-contract.mjs';

const fields = (value, allowed, required) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
  'invalid_owner_message', 'Missing or unsupported owner message fields');

export function validateOwnerMessage(input) {
  fields(input, ['key', 'subject', 'body'], ['key', 'body']);
  requireValue(typeof input.key === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(input.key),
    'invalid_owner_message', 'A bounded immutable message key is required');
  requireValue(typeof input.body === 'string' && input.body.trim() && input.body.length <= 16000,
    'invalid_owner_message', 'Message body must contain 1..16000 characters');
  if (input.subject !== undefined) requireValue(typeof input.subject === 'string' && input.subject.trim() && input.subject.length <= 256 &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(input.subject), 'invalid_owner_message', 'Subject must be one line of 1..256 characters');
}

// Owner messages are durable human correspondence, not questions, notifications,
// execution results or peer prompts. The owner and sender are never caller choices.
export function applyOwnerMessage(store, actor, action, p, { created, changed }) {
  if (action === 'owner_message.send') {
    fields(p, ['id', 'senderAgentId', 'sourceConversationId', 'sourceBindingRevision', 'executionId', 'runId', 'subject', 'body'],
      ['id', 'senderAgentId', 'sourceConversationId', 'body']);
    requireValue(typeof p.id === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(p.id), 'invalid_owner_message', 'Exact message identity required');
    validateOwnerMessage({ key: 'backend-validation', ...(p.subject !== undefined ? { subject: p.subject } : {}), body: p.body });
    const sender = store.get('agent', p.senderAgentId);
    store.nodeOnly(actor, sender.nodeId);
    requireValue(sender.ownerId === store.owner && sender.conversationId === p.sourceConversationId,
      'stale_binding', 'Only the exact sending conversation may message its owner', 409);
    let execution;
    if (sender.headlessSetupId) {
      const authority = headlessRunAuthority(store, actor, p);
      requireValue(authority.agent.id === sender.id && authority.execution.id !== headlessProbeId(authority.setup),
        'headless_probe_forbidden', 'Readiness cannot send real owner messages', 403);
      execution = authority.execution;
    } else requireValue(sender.standingGrant && sender.mode === 'interactive' && sender.bindingId &&
      sender.bindingRevision === p.sourceBindingRevision && p.executionId === undefined && p.runId === undefined,
    'stale_binding', 'Current interactive enrolment or exact accepted headless run required', 409);
    return created('owner_message', { id: p.id, userId: store.owner, subject: p.subject ?? 'Agent update', body: p.body,
      state: 'unread', authority: 'information_only',
      sender: { agentId: sender.id, nodeId: sender.nodeId, name: sender.name, conversationId: sender.conversationId,
        bindingRevision: sender.bindingRevision ?? null },
      ...(execution ? { executionId: execution.id, runId: execution.runId } : {}) });
  }
  requireValue(action === 'owner_message.read', 'unsupported_operation', 'Unknown owner message operation');
  store.ownerOnly(actor); fields(p, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
  const message = store.get('owner_message', p.id);
  requireValue(message.userId === actor.id, 'forbidden', 'Only the message owner may mark it read', 403);
  store.revision(message, p.expectedRevision);
  requireValue(message.state === 'unread', 'owner_message_read', 'Message is already read', 409);
  return changed('owner_message', message, { state: 'read', readAt: now() });
}
