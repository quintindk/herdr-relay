import { digest } from './protocol.mjs';

// Only known native transactional validation refusals qualify. HTTP status alone
// is not proof: proxies, key collisions and malformed/lost replies stay fenced.
const validation = new Map([
  ['headless.task', new Set(['invalid_headless_request', 'invalid_headless_capabilities', 'invalid_reference', 'invalid_task'])],
  ['interactive.repair_request', new Set(['invalid_interactive_repair', 'invalid_grant_scope', 'grant_scope_outside_node', 'stale_repair_preview', 'repair_not_eligible'])],
  ['execution.delegate', new Set(['invalid_request', 'invalid_delegation', 'delegation_not_authorised', 'review_grant_inactive',
    'collaboration_deadline', 'collaboration_peer_not_allowed', 'collaboration_round_limit'])],
]);
const validationStatuses = action => action === 'execution.delegate' ? [400, 403, 409] : action === 'interactive.repair_request' ? [400, 409] : [400];
const revisions = new Set(['stale_revision', 'stale_binding', 'task_busy', 'headless_task_busy', 'reference_conflict']);
export function publicationOutcome(command, error) {
  if (validationStatuses(command.action).includes(error.status) && validation.get(command.action)?.has(error.code)) return {
    state: 'refused', outcome: 'definitively_rejected', applied: false, effectsUncertain: false,
    refusal: { kind: 'transactional_validation', code: error.code, status: error.status, details: String(error.message).slice(0, 1000) },
  };
  if (error.status === 409 && revisions.has(error.code)) return {
    state: 'conflict', outcome: 'revision_conflict', applied: false, effectsUncertain: false, inspectionRequired: true,
  };
  return { state: [400, 403, 404, 409].includes(error.status) ? 'conflict' : 'pending', outcome: 'uncertain', effectsUncertain: true };
}

export function definitivePublicationRefusal(row) {
  if (!['conflict', 'refused'].includes(row.state)) return null;
  let item;
  try { item = JSON.parse(row.data); } catch { return null; }
  if (item.state !== row.state || item.receipt || item.applied === true || item.command?.key !== row.key || digest(item.command) !== row.hash) return null;
  if (item.outcome === 'uncertain' || item.effectsUncertain === true) return null;
  if (!validation.get(item.command.action)?.has(item.error)) return null;
  // Retained records may lack response proof. Only the exact transactional
  // validation codes above establish non-application without that proof.
  if (item.refusal && (item.refusal.kind !== 'transactional_validation' || !validationStatuses(item.command.action).includes(item.refusal.status) || item.refusal.code !== item.error)) return null;
  return { id: row.key, action: item.command.action, error: item.error, applied: false, kind: 'transactional_validation' };
}
