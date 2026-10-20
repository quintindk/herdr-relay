import { digest, now, requireValue } from './protocol.mjs';
import { queryTasks, readTaskComments } from './task-query.mjs';

export const migrationFormat = 'relay-paperclip-tasks/1';
const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
const taskFields = ['id', 'companyId', 'identifier', 'title', 'description', 'status', 'priority', 'parentId', 'projectId',
  'assigneeAgentId', 'assigneeUserId', 'responsibleUserId', 'createdAt', 'updatedAt', 'completedAt', 'cancelledAt',
  'labels', 'blockedByIssueIds', 'executionRunId', 'checkoutRunId', 'executionLockedAt', 'activeRun', 'activeRecoveryAction',
  'executionBlocker', 'executionState', 'executionPolicy', 'reviewPolicy', 'reviewAttention', 'unblockDescriptor'];
const pick = (row, fields) => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value);
// Empty attention containers are projections, not pending obligations. Unknown
// non-empty structures remain blockers until their semantics are verified.
const hasAttention = value => value !== null && value !== undefined && value !== false && value !== '' && value !== 0 &&
  (Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : true);

// Read-only inventory. Do not use a model/worker credential for this company-wide export.
export async function exportPaperclipTasks(api, { sourceUrl, companyId }) {
  const tasks = [], seen = new Set();
  let cursor;
  do {
    const page = await queryTasks(api, { kind: 'list', companyId, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) {
      requireValue(!seen.has(item.id) && tasks.length < 10000, 'incomplete_export', 'Duplicate or oversized task inventory');
      seen.add(item.id);
      const task = await api('GET', `/api/issues/${encodeURIComponent(item.id)}`);
      requireValue(task.id === item.id && task.companyId === companyId, 'source_changed', 'Task source scope changed');
      const comments = await readTaskComments(api, { companyId, taskId: item.id });
      const interactions = await api('GET', `/api/issues/${encodeURIComponent(item.id)}/interactions`);
      requireValue(Array.isArray(interactions) && interactions.length <= 10000, 'incomplete_export', 'Bounded interaction collection required');
      const dependencies = task.blockedByIssueIds ?? task.blockedBy?.map(row => row.id) ?? [];
      const row = { task: pick(task, taskFields), dependencies,
        comments: comments.map(comment => pick(comment, ['id', 'companyId', 'issueId', 'body', 'authorUserId', 'authorAgentId', 'createdByRunId', 'createdAt', 'updatedAt'])),
        // Keep historical interactions as source evidence, never native answer/review authority.
        interactions: interactions.map(interaction => pick(interaction, ['id', 'companyId', 'issueId', 'kind', 'status', 'title', 'body', 'payload',
          'createdAt', 'updatedAt', 'resolvedAt', 'resolvedByUserId', 'resolvedByAgentId', 'resolvedByRunId', 'result'])) };
      const fresh = await api('GET', `/api/issues/${encodeURIComponent(item.id)}`);
      requireValue(digest(pick(fresh, taskFields)) === digest(row.task), 'source_changed', 'Task changed during export. Retry after source freeze');
      tasks.push(row);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const result = { format: migrationFormat, source: { provider: 'paperclip', url: sourceUrl, companyId }, exportedAt: now(), tasks,
    coverage: { tasks: 'backend_visible_company_issues', comments: 'full_bounded_collection', interactions: 'history_only',
      localRelayState: 'not_exported', schedules: 'not_exported', projects: 'source_ids_only', references: 'local_relay_references_not_exported' } };
  return { ...result, digest: migrationDigest(result) };
}

export function migrationDigest(bundle) { const { digest: ignored, ...content } = bundle; return digest(content); }

export function planPaperclipImport(bundle) {
  requireValue(bundle?.format === migrationFormat && bundle.source?.provider === 'paperclip' && id(bundle.source.companyId) &&
    typeof bundle.source.url === 'string' && Array.isArray(bundle.tasks) && bundle.tasks.length <= 10000 &&
    bundle.digest === migrationDigest(bundle), 'invalid_migration', 'Valid immutable Paperclip export and digest required');
  const source = new URL(bundle.source.url);
  requireValue(['http:', 'https:'].includes(source.protocol) && !source.username && !source.password &&
    source.pathname === '/' && !source.search && !source.hash, 'invalid_migration', 'Source origin must not contain credentials, paths or query parameters');
  const scope = digest([source.origin, bundle.source.companyId]);
  const map = new Map(), blockers = [], warnings = [];
  for (const row of bundle.tasks) {
    const task = row.task;
    requireValue(task && id(task.id) && task.companyId === bundle.source.companyId && !map.has(task.id) &&
      typeof task.title === 'string' && task.title.trim() && task.title.length <= 512 &&
      (task.description == null || typeof task.description === 'string' && task.description.length <= 65536) &&
      statuses.includes(task.status) && ['critical', 'high', 'medium', 'low'].includes(task.priority) &&
      Array.isArray(row.dependencies) && row.dependencies.every(id) && Array.isArray(row.comments) && Array.isArray(row.interactions),
    'invalid_migration', 'Invalid, duplicate or foreign task in export');
    map.set(task.id, `task_pc_${digest([scope, task.id])}`);
    const comments = new Set();
    for (const comment of row.comments) {
      requireValue(id(comment.id) && !comments.has(comment.id) && comment.companyId === bundle.source.companyId &&
        comment.issueId === task.id && typeof comment.body === 'string' && comment.body.length <= 65536,
      'invalid_migration', 'Invalid, duplicate or foreign source comment');
      comments.add(comment.id);
    }
    for (const field of ['executionRunId', 'checkoutRunId', 'executionLockedAt', 'activeRun', 'activeRecoveryAction', 'executionBlocker', 'executionState', 'reviewPolicy', 'reviewAttention']) {
      if (field === 'reviewAttention' ? hasAttention(task[field]) : task[field]) blockers.push({ taskId: task.id, field,
        sourceValue: task[field], sourceTaskDigest: digest(task), reason: 'Resolve source execution/review obligation before migration' });
    }
    if (task.status === 'in_progress' || task.status === 'in_review') blockers.push({ taskId: task.id, field: 'status',
      sourceValue: task.status, sourceTaskDigest: digest(task), reason: 'Settle or explicitly disposition source work before migration' });
    if (task.executionPolicy) blockers.push({ taskId: task.id, field: 'executionPolicy', sourceValue: task.executionPolicy,
      sourceTaskDigest: digest(task), reason: 'Source execution policy needs explicit migration or retirement' });
    if (row.interactions.some(item => !['answered', 'resolved', 'accepted', 'rejected', 'cancelled', 'withdrawn', 'superseded', 'expired'].includes(item.status))) {
      blockers.push({ taskId: task.id, field: 'interactions',
        interactions: row.interactions.filter(item => !['answered', 'resolved', 'accepted', 'rejected', 'cancelled', 'withdrawn', 'superseded', 'expired'].includes(item.status))
          .map(item => ({ id: item.id, kind: item.kind, status: item.status })),
        reason: 'Unresolved or unknown interaction state cannot become historical evidence' });
    }
    if (task.assigneeAgentId) warnings.push({ taskId: task.id, field: 'assigneeAgentId', reason: 'Preserved as source metadata, not an execution assignment' });
  }
  for (const { task, dependencies } of bundle.tasks) for (const link of [task.parentId, ...dependencies].filter(Boolean)) {
    requireValue(map.has(link), 'incomplete_graph', 'Export must include every referenced parent/dependency');
  }
  const byId = new Map(bundle.tasks.map(row => [row.task.id, row]));
  // Parentage and dependency edges are different graphs. A parent depending on
  // its child is valid even though combining the two creates a directed cycle.
  const orderGraph = links => {
    const visiting = new Set(), visited = new Set(), ordered = [];
    const visit = taskId => {
      requireValue(!visiting.has(taskId), 'invalid_graph', 'Source task graph contains a cycle');
      if (visited.has(taskId)) return;
      requireValue(visiting.size < 100, 'invalid_graph', 'Source graph exceeds native depth bound');
      visiting.add(taskId);
      const row = byId.get(taskId);
      for (const link of links(row)) visit(link);
      visiting.delete(taskId); visited.add(taskId); ordered.push(row);
    };
    for (const taskId of map.keys()) visit(taskId);
    return ordered;
  };
  const ordered = orderGraph(row => row.task.parentId ? [row.task.parentId] : []);
  orderGraph(row => row.dependencies);
  return { format: migrationFormat, digest: bundle.digest, sourceScope: scope, ready: blockers.length === 0,
    counts: { tasks: bundle.tasks.length, comments: bundle.tasks.reduce((n, row) => n + row.comments.length, 0),
      interactions: bundle.tasks.reduce((n, row) => n + row.interactions.length, 0) },
    blockers, warnings, mappings: Object.fromEntries(map), ordered };
}

// Offline, owner-authenticated import into an exclusively locked backend. All
// tasks, graph links, source records, comments, mappings and receipt commit together.
export function importPaperclipTasks(store, actor, bundle) {
  store.ownerOnly(actor);
  const plan = planPaperclipImport(bundle);
  requireValue(plan.ready, 'migration_blocked', 'Resolve source obligations listed by the dry-run plan');
  return store.transaction(() => {
    const key = `migration:${plan.sourceScope}`;
    const previous = store.get('migration', key, false);
    if (previous) {
      requireValue(previous.digest === bundle.digest, 'migration_conflict', 'Source scope already imported with another export');
      return previous;
    }
    for (const row of plan.ordered) {
      const source = row.task, taskId = plan.mappings[source.id];
      requireValue(!store.get('task', taskId, false), 'migration_conflict', 'Native task identity already exists');
      let task = store.command(actor, { key: `import:${taskId}`, action: 'task.create', payload: {
        id: taskId, title: source.title, description: source.description ?? '', status: source.status, priority: source.priority,
        parentId: source.parentId ? plan.mappings[source.parentId] : null, dependencies: [],
        // Provider labels need not satisfy native label-ID syntax. Preserve them losslessly in source metadata.
        labels: [], externalReference: { namespace: `paperclip:${plan.sourceScope}`, externalId: source.id },
      } });
      requireValue(task.id === taskId, 'migration_conflict', 'Source reference is already mapped to another native task');
      task = store.save('task', { ...task, source: { provider: 'paperclip', scope: plan.sourceScope, id: source.id,
        metadata: source, interactions: row.interactions }, migrationDigest: bundle.digest });
      store.event('task.imported', task, actor, key);
      const commentIds = new Set();
      for (const comment of row.comments) {
        requireValue(id(comment.id) && !commentIds.has(comment.id) && comment.companyId === bundle.source.companyId &&
          comment.issueId === source.id && typeof comment.body === 'string' && comment.body.length <= 65536,
        'invalid_migration', 'Invalid, duplicate or foreign source comment');
        commentIds.add(comment.id);
        const imported = { id: `comment_pc_${digest([plan.sourceScope, comment.id])}`, taskId, body: comment.body,
          revision: 1, createdAt: now(), updatedAt: now(), importedBy: actor.id,
          author: { type: 'external', provider: 'paperclip', userId: comment.authorUserId ?? null, agentId: comment.authorAgentId ?? null },
          source: comment };
        requireValue(!store.get('comment', imported.id, false), 'migration_conflict', 'Source comment identity already exists');
        store.save('comment', imported); store.event('comment.imported', imported, actor, key);
      }
    }
    // All identities now exist. Apply dependency edges without requiring a joint
    // topological order across parentage and dependencies, within this transaction.
    for (const row of plan.ordered) {
      if (!row.dependencies.length) continue;
      const task = store.get('task', plan.mappings[row.task.id]);
      const updated = { ...task, dependencies: row.dependencies.map(id => plan.mappings[id]), revision: task.revision + 1, updatedAt: now() };
      store.validateTask(updated);
      store.save('task', updated); store.event('task.imported_relationships', updated, actor, key);
    }
    const receipt = { id: key, revision: 1, digest: bundle.digest, source: bundle.source, counts: plan.counts,
      mappings: plan.mappings, importedAt: now(), importedBy: actor.id, executionActivated: false,
      coverage: bundle.coverage };
    store.save('migration', receipt); store.event('migration.imported', receipt, actor, key);
    return receipt;
  });
}
