import { digest, requireValue, canonical } from './protocol.mjs';

// Task-only compatibility. Paperclip heartbeats/agents are not part of this port.
export function paperclipTasksProvider(api, { companyId, journal }) {
  requireValue(typeof companyId === 'string' && companyId, 'invalid_provider', 'Explicit Paperclip company required');
  const path = id => `/api/issues/${encodeURIComponent(id)}`;
  const project = issue => {
    requireValue(issue.companyId === companyId, 'forbidden', 'Task belongs to another Paperclip company', 403);
    return { id: issue.id, nativeId: issue.identifier, title: issue.title, description: issue.description ?? '',
      status: issue.status, priority: issue.priority, parentId: issue.parentId ?? null,
      dependencies: issue.blockedByIssueIds ?? (issue.blockedBy ?? []).map(item => item.id), revision: digest(issue),
      revisionStrength: 'best_effort_read_check', warnings: ['Paperclip PATCH does not provide atomic Relay compare-and-swap.'] };
  };
  return {
    describeCapabilities: () => ({ tasks: true, comments: true, relationships: true, collaboration: false,
      conditionalWrites: 'best_effort', idempotency: 'task_create_native_other_writes_external_journal', activity: 'unsupported', status: 'native', revision: 1 }),
    async getTask(id) { return project(await api('GET', path(id))); },
    async listRelations(id) { const task = project(await api('GET', path(id))); return { parentId: task.parentId, dependencies: task.dependencies }; },
    async listComments(id, { cursor = '0', limit = 50 } = {}) {
      project(await api('GET', path(id)));
      requireValue(/^\d+$/.test(cursor) && Number.isInteger(limit) && limit > 0 && limit <= 500, 'invalid_query', 'Invalid comment page');
      const rows = await api('GET', `${path(id)}/comments?order=asc`);
      requireValue(Array.isArray(rows) && rows.length <= 10000, 'incomplete_query', 'Full bounded comment collection required');
      const offset = Number(cursor);
      const items = rows.slice(offset, offset + limit).map(row => ({ id: row.id, taskId: id, body: row.body,
        author: row.authorUserId ? { type: 'user', id: row.authorUserId } : { type: 'agent', id: row.authorAgentId },
        createdAt: row.createdAt, updatedAt: row.updatedAt }));
      const complete = offset + limit >= rows.length;
      return { items, complete, nextCursor: complete ? null : String(offset + limit), fetchedAt: new Date().toISOString(),
        warnings: ['Offset traversal can shift under external comment deletion. Restart to reconcile.'] };
    },
    async listTasks({ cursor, limit = 50 } = {}) {
      requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 999, 'invalid_query', 'Paperclip page limit must be 1..999');
      const params = new URLSearchParams({ limit: String(limit + 1), sortField: 'id', sortDir: 'asc', includePluginOperations: 'true' });
      if (cursor) params.set('afterId', cursor);
      const rows = await api('GET', `/api/companies/${encodeURIComponent(companyId)}/issues?${params}`);
      requireValue(Array.isArray(rows), 'invalid_backend_response', 'Paperclip issue array required');
      const complete = rows.length <= limit;
      if (complete) {
        const proof = await api('GET', `/api/companies/${encodeURIComponent(companyId)}/audit/agent-actions?actorScope=all&entityType=issue&limit=1`);
        requireValue(proof.accessTier === 'full', 'incomplete_query', 'Full company visibility required to prove traversal exhaustion', 403);
      }
      return { items: rows.slice(0, limit).map(project), nextCursor: complete ? null : rows[limit - 1].id, complete,
        fetchedAt: new Date().toISOString(), warnings: ['Traversal covers backend-visible issues, not a snapshot.'] };
    },
    async createTask(task, { key }) {
      requireValue(task && typeof task.title === 'string' && typeof key === 'string' && key, 'invalid_request', 'Task and stable key required');
      const allowed = ['title', 'description', 'status', 'priority', 'parentId', 'dependencies'];
      requireValue(Object.keys(task).every(field => allowed.includes(field)), 'unsupported_operation', 'Unsupported Paperclip field');
      const { dependencies, ...body } = task;
      return project(await api('POST', `/api/companies/${encodeURIComponent(companyId)}/issues`, {
        ...body, ...(dependencies ? { blockedByIssueIds: dependencies } : {}), idempotencyKey: `relay-native:${digest([companyId, key])}`,
      }));
    },
    async updateTask(id, changes, { expectedRevision, key }) {
      requireValue(Object.keys(changes).every(field => ['title', 'description', 'status', 'priority', 'parentId', 'dependencies'].includes(field)),
        'unsupported_operation', 'Unsupported Paperclip field');
      const { dependencies, ...body } = changes;
      const fields = { ...body, ...(dependencies ? { blockedByIssueIds: dependencies } : {}) };
      requireValue(journal, 'unsupported_operation', 'Paperclip writes require a durable publication journal');
      const receipt = await journal.perform({ key, kind: 'paperclip.task.update', payload: { id, changes, expectedRevision },
        send: async () => {
          const before = await api('GET', path(id)); project(before);
          requireValue(digest(before) === expectedRevision, 'stale_revision', 'Paperclip task changed');
          return api('PATCH', path(id), fields);
        },
        reconcile: async () => {
          const current = await api('GET', path(id)); project(current);
          return Object.entries(fields).every(([key, value]) => canonical(current[key]) === canonical(value)) ? current : null;
        } });
      return project(receipt);
    },
    addComment: async () => { requireValue(false, 'unsupported_operation', 'Paperclip comment writes require durable publication reconciliation'); },
  };
}
