import { requireValue } from './protocol.mjs';

const terminal = new Set(['completed', 'cancelled', 'failed', 'rejected']);
const references = (value, id) => value && typeof value === 'object' && Object.entries(value).some(([key, item]) =>
  ['agentId', 'targetAgentId', 'originAgentId', 'requesterAgentId', 'reviewerAgentId', 'requestingAgentId'].includes(key) && item === id ||
  key === 'peerAgentIds' && Array.isArray(item) && item.includes(id) || references(item, id));

// Rechecked inside the deletion transaction. Presence is only one of the guards.
export function agentDeletionPreview(store, agent, clock = Date.now()) {
  const blockers = [];
  const add = (kind, items) => { if (items.length) blockers.push({ kind, ids: items.map(item => item.id) }); };
  if (agent.deletedAt) blockers.push({ kind: 'already_deleted', ids: [agent.id] });
  if (['available', 'busy'].includes(agent.availability) && Number.isFinite(Date.parse(agent.lastSeenAt)) && clock - Date.parse(agent.lastSeenAt) < 15000)
    blockers.push({ kind: 'agent_online', ids: [agent.id] });
  add('outstanding_work', store.all('execution').filter(item => references(item, agent.id) && !terminal.has(item.state)));
  add('open_questions', store.all('question').filter(item => item.status === 'open' &&
    (references(item, agent.id) || item.addressedTo?.type === 'agent' && item.addressedTo.id === agent.id)));
  const schedules = store.all('schedule').filter(item => references(item, agent.id) ||
    item.definition.targetFolder && item.definition.nodeId === agent.nodeId && item.definition.targetFolder === agent.directory);
  add('schedules', schedules.filter(item => !item.cancelled));
  add('pending_schedule_cancellations', schedules.filter(item => item.cancelled && item.appliedRevision !== item.revision));
  for (const kind of ['provision_grant', 'headless_grant', 'review_grant']) add(kind, store.all(kind).filter(item =>
    item.state === 'active' && (!item.expiresAt || Date.parse(item.expiresAt) > clock) && references(item, agent.id)));
  add('pending_preparations', store.all('provision_request').filter(item => references(item, agent.id) &&
    (item.admission?.state === 'reserved' || !['ready', 'blocked', 'cancelled'].includes(item.state))));
  add('pending_permissions', store.all('grant_request').filter(item => item.state === 'awaiting_approval' && references(item, agent.id)));
  add('pending_messages', store.all('message').filter(item => ['queued', 'delivering', 'uncertain'].includes(item.state) && references(item, agent.id)));
  add('worker_setup', store.all('headless_setup').filter(item => references(item, agent.id) &&
    store.get('headless_grant', item.grantId, false)?.state === 'active'));
  return { agentId: agent.id, name: agent.name, nodeId: agent.nodeId, directory: agent.directory,
    expectedRevision: agent.revision, eligible: blockers.length === 0, blockers };
}

export function requireDeletableAgent(store, agent) {
  const preview = agentDeletionPreview(store, agent);
  requireValue(preview.eligible, 'agent_in_use', `Cannot delete agent: ${preview.blockers.map(item => `${item.kind} (${item.ids.join(', ')})`).join('; ')}`, 409);
  return preview;
}
