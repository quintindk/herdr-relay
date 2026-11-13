import { digest, now, requireValue } from './protocol.mjs';
import { randomUUID } from 'node:crypto';

export const runResultNotificationsSchema = Object.freeze({ type: 'object', properties: {
  inbox: { type: 'boolean' }, requester: { type: 'boolean' },
}, required: ['inbox', 'requester'], additionalProperties: false });

export function runResultNotifications(value) {
  if (value === undefined) return { inbox: false, requester: false };
  requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['inbox', 'requester'].includes(key)) &&
    typeof value.inbox === 'boolean' && typeof value.requester === 'boolean',
  'invalid_run_result_notifications', 'runResultNotifications requires explicit inbox and requester booleans');
  return { inbox: value.inbox, requester: value.requester };
}

// Recipients come from platform-owned relationships, never from worker text.
export function scheduleRequester(store, schedule) {
  if (schedule.requesterAgentId) return store.get('agent', schedule.requesterAgentId, false);
  const target = typeof schedule.definition.targetAgentId === 'string' ? store.get('agent', schedule.definition.targetAgentId, false) : null;
  const setup = target?.headlessSetupId && store.get('headless_setup', target.headlessSetupId, false);
  return setup ? store.get('agent', setup.requesterAgentId, false) : target?.standingGrant && target.mode === 'interactive' ? target : null;
}

export function runResultReport(occurrence, requesterAgentId) {
  const summary = occurrence.summary ?? occurrence.reason;
  const resultDigest = digest({ state: occurrence.state, candidate: occurrence.candidate ?? null,
    summary, failure: occurrence.failure ?? null });
  return { id: `run-result:${occurrence.id}`, kind: 'run_result', scheduleId: occurrence.scheduleId,
    occurrenceId: occurrence.id, definitionRevision: occurrence.definitionRevision, nodeId: occurrence.nodeId,
    requesterAgentId: requesterAgentId ?? null, intendedAt: occurrence.intendedAt, completedAt: occurrence.updatedAt,
    outcome: occurrence.state, summary, resultDigest, ...(occurrence.failure ? { failure: occurrence.failure } : {}),
    message: `Relay · ${occurrence.scheduleId} · ${occurrence.state}\nScheduled: ${occurrence.intendedAt}\n` +
      `Result recorded: ${occurrence.updatedAt}\nRun: ${occurrence.id}\n\nAgent's recorded report:\n${summary}` };
}

export function onlineRequester(store, recipient, clock = Date.now()) {
  const id = recipient?.agentId ?? recipient?.id;
  const agent = typeof id === 'string' ? store.get('agent', id, false) : null;
  const node = agent && store.get('node', agent.nodeId, false);
  const fresh = time => Number.isFinite(Date.parse(time)) && clock - Date.parse(time) >= 0 && clock - Date.parse(time) < 15000;
  return agent?.mode === 'interactive' && agent.ownerId === store.owner && agent.standingGrant && agent.bindingId &&
    agent.conversationId && ['available', 'busy'].includes(agent.availability) && fresh(agent.lastSeenAt) && fresh(node?.lastSeenAt) &&
    (!recipient.conversationId || recipient.conversationId === agent.conversationId && recipient.bindingId === agent.bindingId &&
      recipient.bindingRevision === agent.bindingRevision) ? agent : null;
}

const deliveryKind = 'run_result_delivery';
const finalDelivery = state => ['delivered', 'failed', 'dropped'].includes(state);
const deliveryOrder = { queued: 0, claimed: 1, waiting: 1, sending: 2, accepted: 3, observed: 4 };
const recipientFor = agent => ({ agentId: agent.id, nodeId: agent.nodeId, bindingId: agent.bindingId,
  conversationId: agent.conversationId, bindingRevision: agent.bindingRevision });

// Persist observations, not a replayable queue. Neither this record nor its
// command receipts may ever be used to reconstruct/send a native prompt.
export function createRunResultDelivery(store, report) {
  const previous = store.get(deliveryKind, report.id, false);
  if (previous) {
    requireValue(previous.resultDigest === report.resultDigest && previous.occurrenceId === report.occurrenceId,
      'run_result_delivery_identity_conflict', 'A retained delivery record cannot be rewritten for another result', 409);
    return previous;
  }
  const agent = onlineRequester(store, { agentId: report.requesterAgentId });
  return store.save(deliveryKind, { id: report.id, occurrenceId: report.occurrenceId, scheduleId: report.scheduleId,
    resultDigest: report.resultDigest, requesterAgentId: report.requesterAgentId,
    recipient: agent ? recipientFor(agent) : null, nativeMessageId: `msg_${digest(report.id)}`,
    state: agent ? 'queued' : 'dropped', reason: agent ? 'awaiting_online_consumer' : 'requester_not_online',
    replayAllowed: false, sendIntentRecorded: false, revision: 1, createdAt: now(), updatedAt: now() });
}

function saveDelivery(store, delivery, patch) {
  return store.transaction(() => {
    const next = store.save(deliveryKind, { ...delivery, ...patch, revision: delivery.revision + 1, updatedAt: now() });
    store.event('run_result.delivery', next, { type: 'system', id: 'relay' }, delivery.occurrenceId);
    return next;
  });
}

export function expireRunResultDeliveries(store) {
  for (const delivery of store.all(deliveryKind)) if (!finalDelivery(delivery.state) && delivery.state !== 'uncertain')
    saveDelivery(store, delivery, delivery.state === 'queued'
      ? { state: 'dropped', reason: 'backend_restarted_before_take' }
      : { state: 'uncertain', reason: 'backend_restarted_after_take' });
}

export function runResultDeliveryView(store, entity) {
  if (!entity) return entity;
  const id = entity.kind === 'run_result' ? entity.occurrenceId : entity.id;
  const delivery = store.get(deliveryKind, `run-result:${id}`, false);
  return delivery ? { ...entity, requesterDelivery: delivery } : entity;
}

export function recordRunResultDelivery(store, actor, p) {
  requireValue(p && Object.keys(p).every(key => ['id', 'consumerId', 'resultDigest', 'nativeMessageId', 'state', 'reason', 'nativeTerminalId', 'nativeOutcome'].includes(key)) &&
    ['id', 'consumerId', 'resultDigest', 'nativeMessageId', 'state', 'reason'].every(key => typeof p[key] === 'string' && p[key].length > 0) &&
    /^[A-Za-z0-9_-]{1,100}$/.test(p.consumerId) && /^[a-z][a-z0-9_]{0,95}$/.test(p.reason) &&
    ['waiting', 'sending', 'accepted', 'observed', 'delivered', 'failed', 'uncertain', 'dropped'].includes(p.state),
  'invalid_run_result_delivery', 'Exact delivery identity and a bounded observation are required');
  const delivery = store.get(deliveryKind, p.id);
  store.nodeOnly(actor, delivery.recipient?.nodeId);
  requireValue(delivery.consumerId === p.consumerId && delivery.resultDigest === p.resultDigest && delivery.nativeMessageId === p.nativeMessageId,
    'run_result_delivery_identity_conflict', 'Delivery observation belongs to another original consumer, result or native message', 409);
  if (['delivered', 'failed'].includes(p.state)) requireValue(typeof p.nativeTerminalId === 'string' && p.nativeTerminalId.length > 0 && p.nativeTerminalId.length <= 256 &&
    (p.state === 'delivered' ? p.nativeOutcome === 'succeeded' : ['failed', 'interrupted'].includes(p.nativeOutcome)),
  'invalid_run_result_delivery', 'A correlated native terminal and its actual outcome are required');
  else requireValue(p.nativeTerminalId === undefined && p.nativeOutcome === undefined,
    'invalid_run_result_delivery', 'Only terminal observations may claim a native outcome');
  if (finalDelivery(delivery.state)) return delivery;
  requireValue(p.state !== 'dropped' || !delivery.sendIntentRecorded,
    'invalid_run_result_delivery', 'An admitted native send cannot be relabelled as definitely dropped');
  requireValue(!['accepted', 'observed', 'delivered', 'failed'].includes(p.state) || delivery.sendIntentRecorded,
    'invalid_run_result_delivery', 'A native observation requires its original admitted send intent');
  if (delivery.sendIntentRecorded && ['waiting', 'sending'].includes(p.state) && delivery.state !== 'sending') return delivery;
  if (deliveryOrder[p.state] !== undefined && deliveryOrder[delivery.state] > deliveryOrder[p.state]) return delivery;
  return saveDelivery(store, delivery, { state: p.state, reason: p.reason,
    sendIntentRecorded: delivery.sendIntentRecorded || p.state === 'sending',
    ...(p.nativeTerminalId ? { nativeTerminalId: p.nativeTerminalId, nativeOutcome: p.nativeOutcome } : {}) });
}

// Online-only bounded transport. Durable delivery observations are diagnostic
// evidence, never a backlog or permission to replay after a restart/lost reply.
export class OnlineRunResultMessages {
  constructor({ limit = 100 } = {}) { this.pending = new Map(); this.consumers = new Map(); this.limit = limit; this.epoch = randomUUID(); }
  offer(store, report) {
    const delivery = store.get(deliveryKind, report.id);
    if (delivery.state !== 'queued') return;
    if (!onlineRequester(store, delivery.recipient) || this.pending.size >= this.limit) {
      saveDelivery(store, delivery, { state: 'dropped', reason: this.pending.size >= this.limit ? 'backend_queue_full' : 'requester_changed_or_offline' }); return;
    }
    this.pending.set(report.id, { ...report, recipient: delivery.recipient, deliveryId: delivery.id });
  }
  take(store, actor, { consumerId } = {}) {
    store.nodeOnly(actor, actor.id);
    requireValue(typeof consumerId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(consumerId), 'invalid_request', 'Ephemeral node consumer identity required');
    if (this.consumers.get(actor.id) !== consumerId) {
      const replacing = this.consumers.has(actor.id);
      this.consumers.set(actor.id, consumerId);
      // Initial registration must not discard newly published online results.
      // Only a known consumer replacement represents a node restart.
      for (const [id, report] of this.pending) if (replacing && report.recipient.nodeId === actor.id) {
        saveDelivery(store, store.get(deliveryKind, id), { state: 'dropped', reason: 'node_consumer_changed' });
        this.pending.delete(id);
      }
    }
    const items = [];
    for (const [id, report] of this.pending) {
      if (!onlineRequester(store, report.recipient)) {
        saveDelivery(store, store.get(deliveryKind, id), { state: 'dropped', reason: 'requester_changed_or_offline' });
        this.pending.delete(id); continue;
      }
      if (report.recipient.nodeId === actor.id) {
        saveDelivery(store, store.get(deliveryKind, id), { state: 'claimed', reason: 'taken_by_online_node', consumerId });
        this.pending.delete(id); items.push(report);
      }
    }
    return { items, epoch: this.epoch };
  }
}
