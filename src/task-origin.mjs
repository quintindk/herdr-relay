import { canonical } from './protocol.mjs';

// Read durable creation evidence, not backend parent links or worker-supplied origins.
// Returned child entries are projections only, never fabricated operator operations.
export function taskOrigins(store) {
  const validText = value => typeof value === 'string' && value.trim().length > 0;
  const validOrigin = origin => origin && validText(origin.bindingId) && validText(origin.conversationId) &&
    Number.isSafeInteger(origin.sessionCreatedAt) && origin.sessionCreatedAt > 0;
  const runs = new Map(store.runs().map(run => [run.id, run]));
  const groups = new Map();
  const key = (companyId, taskId) => canonical([companyId, taskId]);
  for (const row of store.db.prepare('SELECT id, run_id, data FROM operations ORDER BY rowid DESC').all()) {
    const operation = JSON.parse(row.data);
    const { request, receipt } = operation;
    if (operation.id !== row.id || operation.runId !== row.run_id || operation.state !== 'recorded' ||
      !validText(receipt?.id) || !request) continue;
    let companyId, parentRun;
    if (operation.id.startsWith('operator-task:')) {
      companyId = request.companyId;
      if (!validText(companyId) || !validOrigin(request.origin) ||
        (receipt.companyId !== undefined && receipt.companyId !== companyId)) continue;
    } else {
      parentRun = runs.get(operation.runId);
      companyId = parentRun?.request?.companyId;
      if (request.kind !== 'task.create' || request.method !== 'POST' || !validText(companyId) ||
        request.path !== `/api/companies/${encodeURIComponent(companyId)}/issues` ||
        receipt.companyId !== companyId || !validText(request.body?.parentId) ||
        request.body.parentId !== parentRun.request.taskId || receipt.parentId !== request.body.parentId ||
        receipt.id === request.body.parentId) continue;
    }
    // Older operator receipts may omit these fields. Worker lineage requires
    // an explicit matching receipt for every requested assignment and parent.
    if (['parentId', 'assigneeAgentId', 'assigneeUserId'].some(field =>
      (receipt[field] !== undefined || parentRun) &&
      (receipt[field] ?? null) !== (request.body?.[field] ?? null))) continue;
    const taskKey = key(companyId, receipt.id);
    const entries = groups.get(taskKey) ?? [];
    entries.push({ operation, companyId, parentRun });
    groups.set(taskKey, entries);
  }
  const resolving = new Set();
  const resolve = (taskKey, depth = 0) => {
    if (depth >= 64 || resolving.has(taskKey)) return null;
    const entries = groups.get(taskKey);
    if (!entries) return null;
    resolving.add(taskKey);
    let result = null;
    for (const { operation, companyId, parentRun } of entries) {
      let origin = operation.request.origin;
      if (parentRun) {
        const parent = resolve(key(companyId, parentRun.request.taskId), depth + 1);
        if (!parent || parent.receipt.companyId !== companyId || !validText(parentRun.request.agentId) ||
          parent.receipt.assigneeAgentId !== parentRun.request.agentId ||
          parent.request.body?.assigneeAgentId !== parentRun.request.agentId) {
          result = null;
          break;
        }
        origin = parent.request.origin;
      }
      const entry = { ...operation, request: { ...operation.request, companyId, origin } };
      // Conflicting ownership or assignment must not grant either claimant scope.
      if (result && canonical([result.request.origin, ...['parentId', 'assigneeAgentId', 'assigneeUserId']
        .map(field => result.request.body?.[field] ?? null)]) !== canonical([origin,
        ...['parentId', 'assigneeAgentId', 'assigneeUserId'].map(field => entry.request.body?.[field] ?? null)])) {
        result = null;
        break;
      }
      result ??= entry;
    }
    resolving.delete(taskKey);
    return result;
  };
  return [...groups.keys()].map(taskKey => resolve(taskKey)).filter(Boolean);
}
