import { canonical, requireValue } from './protocol.mjs';

export const collaborationSchema = {
  type: 'object', properties: {
    peerAgentIds: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } },
    maxRounds: { type: 'integer', minimum: 1, maximum: 16 },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
  }, required: ['peerAgentIds'], additionalProperties: false,
};

// A round is one peer execution. This is a job budget, not another grant family.
export function collaborationRequest(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['peerAgentIds', 'maxRounds', 'timeoutSeconds'].includes(key)) &&
    Array.isArray(input.peerAgentIds) && input.peerAgentIds.length > 0 && input.peerAgentIds.length <= 16 &&
    input.peerAgentIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\s\x00-\x1f]/.test(id)) &&
    new Set(input.peerAgentIds).size === input.peerAgentIds.length,
  'invalid_collaboration', 'Select exact peer agents and a bounded collaboration budget');
  const maxRounds = input.maxRounds ?? 2, timeoutSeconds = input.timeoutSeconds ?? 600;
  requireValue(Number.isSafeInteger(maxRounds) && maxRounds > 0 && maxRounds <= 16 &&
    Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds <= 3600,
  'invalid_collaboration', 'Collaboration supports 1-16 peer rounds and a 1-3600 second deadline');
  return { peerAgentIds: [...input.peerAgentIds].sort(), maxRounds, timeoutSeconds };
}

export function collaborationReceiptMatches(receipt, request, createdAt) {
  if (!request) return !receipt;
  const expected = collaborationRequest(request), deadline = Date.parse(receipt?.deadline), created = Date.parse(createdAt);
  return receipt && Number.isFinite(deadline) && Number.isFinite(created) && deadline > created &&
    deadline <= created + expected.timeoutSeconds * 1000 && canonical({ peerAgentIds: receipt.peerAgentIds,
      maxRounds: receipt.maxRounds, timeoutSeconds: receipt.timeoutSeconds }) === canonical(expected);
}

export const childTerminal = child => ['completed', 'failed', 'cancelled', 'rejected'].includes(child.state);

export async function peerExecutions(api, parentId, runId) {
  const items = [], cursors = new Set();
  let cursor;
  do {
    const page = await api('GET', `/v1/executions?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
    requireValue(Array.isArray(page.items) && (!page.nextCursor || typeof page.nextCursor === 'string' && !cursors.has(page.nextCursor)),
      'incomplete_collection', 'Peer execution traversal must be complete');
    items.push(...page.items.filter(child => child.parentExecutionId === parentId && (!runId || child.parentRunId === runId)));
    cursor = page.nextCursor;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}
