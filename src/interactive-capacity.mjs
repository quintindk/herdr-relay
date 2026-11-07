import { digest } from './protocol.mjs';

// Reservations live on the existing revisioned preparation record. Actual
// enrolments and reservations share the backend's SQLite transaction boundary.
export function nodeEnrolmentUsage(store, nodeId, excludeRequestId) {
  const agents = store.all('agent').filter(a => a.nodeId === nodeId && a.standingGrant);
  const enrolled = new Set(agents.map(a => a.id));
  const reservations = store.all('provision_request').filter(r => r.nodeId === nodeId && r.id !== excludeRequestId &&
    r.admission?.state === 'reserved' && !enrolled.has(r.agentId));
  return { enrolled: agents.length, reserved: reservations.length, used: agents.length + reservations.length,
    reservationCeiling: Math.min(100, ...reservations.map(r => r.admission.capacity.ceiling)),
    version: digest([agents.map(a => a.id).sort(), reservations.map(r => [r.id, r.admission.capacity.ceiling]).sort()]) };
}

export function interactiveCapacity(store, request, grant, nodeCeiling, localCeiling = 100) {
  const usage = nodeEnrolmentUsage(store, request.nodeId, request.id);
  const ceiling = Math.min(nodeCeiling, grant.maxAgents, localCeiling, usage.reservationCeiling);
  const existing = store.get('agent', request.agentId, false);
  return { ...usage, nodeCeiling, grantCeiling: grant.maxAgents, localCeiling, ceiling,
    available: Math.max(0, ceiling - usage.used), existingEnrolment: !!existing?.standingGrant,
    ownReservation: request.admission?.state === 'reserved' };
}
