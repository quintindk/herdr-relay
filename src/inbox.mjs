import { canonical, digest, requireValue, text } from './protocol.mjs';

export function recordEvent(store, bindingId, input) {
  const source = text(input.source, 'source');
  const eventId = text(input.eventId, 'eventId');
  const cursor = text(input.cursor, 'cursor');
  const request = { bindingId, source, eventId, cursor, recipient: text(input.recipient, 'recipient'),
    summary: text(input.summary, 'summary'), reference: text(input.reference, 'reference') };
  const sender = store.binding(bindingId);
  const recipient = store.binding(request.recipient);
  requireValue(sender.config.companyId === recipient.config.companyId, 'forbidden', 'Inbox recipient belongs to another company', 403);
  const id = `event:${digest([bindingId, source, eventId])}`;
  return store.transaction(() => {
    const existing = store.operation(id);
    if (existing) {
      requireValue(canonical(existing.request) === canonical(request), 'event_conflict', 'Source event changed under the same identity', 409);
      return existing;
    }
    const checkpointId = `checkpoint:${digest([bindingId, source])}`;
    const checkpoint = store.operation(checkpointId);
    requireValue((checkpoint?.cursor ?? null) === (input.expectedCursor ?? null), 'stale_cursor', 'Source checkpoint changed', 409);
    const event = store.saveOperation({ id, runId: '', request, state: 'unread', createdAt: new Date().toISOString() });
    store.saveOperation({ id: checkpointId, runId: '', bindingId, source, cursor, state: 'recorded' });
    return event;
  });
}

export function inbox(store, bindingId) {
  return store.db.prepare("SELECT data FROM operations WHERE id LIKE 'event:%' ORDER BY rowid DESC").all()
    .map(row => JSON.parse(row.data)).filter(event => !bindingId || event.request.recipient === bindingId);
}

export function acknowledgeEvent(store, bindingId, id) {
  const event = store.operation(text(id, 'eventId'));
  requireValue(event?.request?.recipient === bindingId, 'forbidden', 'Event belongs to another recipient', 403);
  return event.state === 'read' ? event : store.saveOperation({ ...event, state: 'read', readAt: new Date().toISOString() });
}
