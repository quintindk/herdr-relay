import { digest, requireValue } from './protocol.mjs';

const fields = (p, allowed, required = allowed) => requireValue(p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(p, k)), 'invalid_request', 'Missing or unsupported message fields');
const text = (value, max) => requireValue(typeof value === 'string' && value.trim() && value.length <= max,
  'invalid_request', 'Bounded non-empty message text required');

// Agent messages carry information, never execution, delegation or human authority.
export function applyMessage(store, actor, action, p, { created, changed }) {
  if (action === 'message.send') {
    fields(p, ['id', 'senderAgentId', 'sourceConversationId', 'sourceBindingRevision', 'recipientAgentId', 'kind', 'subject', 'body', 'replyPolicy', 'replyToMessageId'],
      ['id', 'senderAgentId', 'sourceConversationId', 'sourceBindingRevision', 'recipientAgentId', 'body']);
    const sender = store.get('agent', p.senderAgentId), recipient = store.get('agent', p.recipientAgentId);
    store.nodeOnly(actor, sender.nodeId);
    requireValue(sender.standingGrant && sender.mode === 'interactive' && sender.conversationId === p.sourceConversationId &&
      sender.bindingRevision === p.sourceBindingRevision && sender.bindingId, 'stale_binding', 'Only the designated sending chat may send a message', 409);
    requireValue(recipient.id !== sender.id && recipient.standingGrant && recipient.mode === 'interactive' &&
      recipient.ownerId === sender.ownerId && recipient.bindingId, 'invalid_recipient', 'A different enrolled receiving agent with the same owner is required');
    requireValue(['message', 'status'].includes(p.kind ?? 'message'), 'invalid_request', 'Use message or status, not a task or instruction');
    text(p.body, 8000);
    if (p.subject !== undefined) text(p.subject, 256);
    requireValue(['none', 'once'].includes(p.replyPolicy ?? 'none'), 'invalid_request', 'Reply policy must be none or once');
    let parent;
    if (p.replyToMessageId !== undefined) {
      text(p.replyToMessageId, 256); parent = store.get('message', p.replyToMessageId);
      requireValue(parent.replyPolicy === 'once' && !parent.replyToMessageId && !parent.replyMessageId &&
        parent.recipient.agentId === sender.id && parent.sender.agentId === recipient.id &&
        ['delivering', 'delivered'].includes(parent.state) && parent.delivery?.conversationId === sender.conversationId && parent.delivery?.bindingRevision === sender.bindingRevision &&
        (p.replyPolicy ?? 'none') === 'none', 'message_reply_not_authorised', 'Only one reply to the original sender from its exact receiving chat is permitted', 403);
    }
    requireValue(store.all('message').filter(m => m.recipient.agentId === recipient.id && ['queued', 'delivering', 'uncertain'].includes(m.state)).length < 100,
      'message_queue_full', 'Recipient already has 100 outstanding messages', 409);
    const message = created('message', { id: p.id, kind: p.kind ?? 'message', subject: p.subject ?? '', body: p.body,
      sender: { agentId: sender.id, nodeId: sender.nodeId, name: sender.name, conversationId: sender.conversationId, bindingRevision: sender.bindingRevision },
      recipient: { agentId: recipient.id, nodeId: recipient.nodeId, name: recipient.name }, state: 'queued', authority: 'context_only',
      replyPolicy: parent ? 'none' : p.replyPolicy ?? 'none', ...(parent ? { replyToMessageId: parent.id } : {}) });
    if (parent) { const updated = changed('message', parent, { replyMessageId: message.id }); store.event('message.replied', updated, actor, message.id); }
    return message;
  }
  const message = store.get('message', p.id);
  store.nodeOnly(actor, message.recipient.nodeId);
  if (action === 'message.admit') {
    fields(p, ['id', 'expectedRevision', 'bindingId', 'conversationId', 'bindingRevision', 'nativeMessageId']);
    store.revision(message, p.expectedRevision);
    const recipient = store.get('agent', message.recipient.agentId);
    requireValue(message.state === 'queued' && recipient.bindingId === p.bindingId && recipient.conversationId === p.conversationId &&
      recipient.bindingRevision === p.bindingRevision, 'stale_binding', 'Message admission requires the current receiving chat', 409);
    text(p.nativeMessageId, 256);
    return changed('message', message, { state: 'delivering', delivery: { bindingId: p.bindingId, conversationId: p.conversationId,
      bindingRevision: p.bindingRevision, nativeMessageId: p.nativeMessageId } });
  }
  requireValue(action === 'message.progress', 'unsupported_operation', 'Unknown message operation');
  fields(p, ['id', 'expectedRevision', 'nativeMessageId', 'state', 'evidence'], ['id', 'expectedRevision', 'nativeMessageId', 'state', 'evidence']);
  text(p.nativeMessageId, 256);
  store.revision(message, p.expectedRevision);
  requireValue((['delivering', 'uncertain'].includes(message.state) && message.delivery?.nativeMessageId === p.nativeMessageId ||
    message.state === 'queued' && p.state === 'blocked') && ['uncertain', 'blocked', 'delivered'].includes(p.state),
    'message_delivery_ineligible', 'Exact admitted message delivery required; only blocking is allowed before admission', 409);
  text(p.evidence, 2000);
  return changed('message', message, { state: p.state, delivery: { ...message.delivery, nativeMessageId: p.nativeMessageId, evidence: p.evidence } });
}

export function messageParticipant(store, actor, message) {
  if (actor.type === 'user') store.ownerOnly(actor);
  else requireValue(actor.type === 'node' && [message.sender.nodeId, message.recipient.nodeId].includes(actor.id),
    'forbidden', 'Only message participants may inspect it', 403);
  return message;
}

export function queryMessages(store, actor, { agentId, direction = 'inbox', limit = 100, cursor } = {}) {
  requireValue(typeof agentId === 'string' && agentId && ['inbox', 'sent'].includes(direction) &&
    Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'invalid_query', 'Exact agent, inbox/sent direction and bounded limit required');
  store.agent(actor, agentId);
  const scope = digest({ agentId, direction, limit });
  let after = '';
  if (cursor) {
    let value;
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
    requireValue(value?.instance === store.instance && value.scope === scope && typeof value.after === 'string', 'invalid_cursor', 'Message cursor scope changed');
    after = value.after;
  }
  const side = direction === 'inbox' ? 'recipient' : 'sender';
  const rows = store.db.prepare(`SELECT data FROM entities WHERE kind='message' AND id>? AND json_extract(data,?)=? ORDER BY id LIMIT ?`)
    .all(after, `$.${side}.agentId`, agentId, limit + 1).map(row => JSON.parse(row.data));
  const items = rows.slice(0, limit), nextCursor = rows.length > limit ? Buffer.from(JSON.stringify({ instance: store.instance, scope, after: items.at(-1).id })).toString('base64url') : null;
  return { items, nextCursor, complete: !nextCursor, scope: { agentId, direction }, authority: 'context_only' };
}
