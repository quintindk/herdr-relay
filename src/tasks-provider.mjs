import { digest, requireValue } from './protocol.mjs';

export const nativeCapabilities = Object.freeze({ tasks: true, comments: true, relationships: true,
  conditionalWrites: 'atomic', idempotency: 'actor_key_payload', activity: 'durable_events',
  collaboration: true, status: 'native', revision: 1 });

export function nativeTasksProvider(api) {
  const command = (action, payload, key) => api('POST', '/v1/commands', { key, action, payload });
  return {
    describeCapabilities: () => nativeCapabilities,
    listTasks: query => api('GET', `/v1/tasks?${new URLSearchParams(query ?? {})}`),
    getTask: id => api('GET', `/v1/tasks/${encodeURIComponent(id)}`),
    resolveTaskIdentity: query => api('GET', `/v1/task-identity?${new URLSearchParams(query)}`),
    createTask: (task, { key }) => command('task.create', { ...task, id: task.id ?? `task_${digest(key)}` }, key),
    updateTask: (id, changes, { key, expectedRevision }) => command('task.update', { id, expectedRevision, changes }, key),
    listComments: (taskId, query = {}) => api('GET', `/v1/comments?${new URLSearchParams({ ...query, taskId })}`),
    addComment: (taskId, body, { key, id = `comment_${digest([taskId, key])}` }) => command('comment.create', { id, taskId, body }, key),
    async listRelations(id) { const task = await api('GET', `/v1/tasks/${encodeURIComponent(id)}`); return { parentId: task.parentId, dependencies: task.dependencies }; },
    changeRelations: (id, changes, context) => {
      requireValue(Object.keys(changes).every(field => ['parentId', 'dependencies'].includes(field)), 'invalid_request', 'Relation fields only');
      return command('task.update', { id, expectedRevision: context.expectedRevision, changes }, context.key);
    },
    readActivity: query => api('GET', `/v1/activity?${new URLSearchParams(query)}`),
    lookupReference: reference => api('GET', `/v1/references?${new URLSearchParams(reference)}`),
    attachReference: (id, reference, context) => command('reference.attach', { id, expectedRevision: context.expectedRevision, reference }, context.key),
  };
}

// Explicitly task-only: native Collaboration remains required. Human users are
// GitHub users. Relay agents and executions are never fabricated as GitHub users.
export function githubTasksProvider(request, { owner, repo, labels = {}, journal }) {
  requireValue(typeof owner === 'string' && /^[A-Za-z0-9_.-]+$/.test(owner) && typeof repo === 'string' && /^[A-Za-z0-9_.-]+$/.test(repo),
    'invalid_provider', 'Explicit repository required');
  const base = `/repos/${owner}/${repo}`;
  const statuses = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];
  const statusLabel = status => labels[status] ?? `relay:status:${status}`;
  const priorityLabel = priority => `relay:priority:${priority}`;
  const project = issue => ({ id: String(issue.number), nativeId: String(issue.id), url: issue.html_url, title: issue.title,
    description: issue.body ?? '', status: issue.state === 'closed' ? (issue.state_reason === 'not_planned' ? 'cancelled' : 'done') :
      statuses.find(status => issue.labels?.some(label => (label.name ?? label) === statusLabel(status))) ?? 'todo',
    priority: ['critical', 'high', 'medium', 'low'].find(p => issue.labels?.some(label => (label.name ?? label) === priorityLabel(p))) ?? 'medium',
    revision: issue.updated_at, assignees: (issue.assignees ?? []).map(user => user.login),
    revisionStrength: 'best_effort_read_check', warnings: ['GitHub writes have no atomic Relay revision guard.'] });
  const path = id => { requireValue(/^\d+$/.test(String(id)), 'invalid_id', 'Repository issue number required'); return `${base}/issues/${id}`; };
  const pageQuery = ({ cursor = '1', limit = 50 } = {}) => {
    requireValue(typeof cursor === 'string' && /^[1-9]\d*$/.test(cursor) && Number.isSafeInteger(Number(cursor)) &&
      Number.isInteger(limit) && limit > 0 && limit <= 100, 'invalid_query', 'Invalid GitHub page');
    return { cursor, limit };
  };
  const related = issue => {
    requireValue(issue && Number.isSafeInteger(issue.number) && issue.number > 0 &&
      typeof issue.repository_url === 'string' && /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/i.test(issue.repository_url),
    'invalid_backend_response', 'Repository-qualified related issue required');
    const repository = issue.repository_url.slice('https://api.github.com/repos/'.length);
    return { id: repository.toLowerCase() === `${owner}/${repo}`.toLowerCase() ? String(issue.number) : null,
      nativeId: String(issue.id), repository, number: issue.number, url: issue.html_url,
      status: issue.state === 'closed' ? (issue.state_reason === 'not_planned' ? 'cancelled' : 'done') : 'todo' };
  };
  const relationRows = async route => {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await request('GET', `${route}?per_page=100&page=${page}`);
      requireValue(Array.isArray(rows), 'invalid_backend_response', 'Related issue collection required');
      items.push(...rows.map(related));
      if (rows.length < 100) return items;
    }
    requireValue(false, 'incomplete_query', 'Relationship traversal exceeded its bound');
  };
  return {
    describeCapabilities: () => ({ tasks: true, comments: true, relationships: 'read_only_children_dependencies', collaboration: false,
      conditionalWrites: 'best_effort', idempotency: journal ? 'durable_no_resend_journal' : 'external_journal_required',
      publication: Boolean(journal), activity: 'unsupported', status: 'mapped_labels', revision: 1 }),
    async listTasks(query) {
      const { cursor, limit } = pageQuery(query);
      const rows = await request('GET', `${base}/issues?state=all&sort=created&direction=asc&per_page=${limit}&page=${cursor}`);
      requireValue(Array.isArray(rows), 'invalid_backend_response', 'GitHub issues array required');
      return { items: rows.filter(issue => !issue.pull_request).map(project), nextCursor: rows.length === limit ? String(Number(cursor) + 1) : null,
        complete: rows.length < limit, fetchedAt: new Date().toISOString(), warnings: ['Page traversal is not a snapshot. Pull requests are excluded after pagination.'] };
    },
    async getTask(id) { return project(await request('GET', path(id))); },
    async listComments(id, query) {
      const { cursor, limit } = pageQuery(query);
      const rows = await request('GET', `${path(id)}/comments?per_page=${limit}&page=${cursor}`);
      requireValue(Array.isArray(rows), 'invalid_backend_response', 'GitHub comments array required');
      return { items: rows.map(row => ({ id: String(row.id), taskId: String(id), body: row.body ?? '',
        author: { type: 'user', id: row.user?.login }, createdAt: row.created_at, updatedAt: row.updated_at, url: row.html_url })),
      complete: rows.length < limit, nextCursor: rows.length === limit ? String(Number(cursor) + 1) : null,
      fetchedAt: new Date().toISOString(), warnings: ['Page traversal is not a snapshot.'] };
    },
    async listRelations(id) {
      // Keep cross-repository references qualified. An issue number alone would
      // silently point at a different task in this provider's configured repository.
      await request('GET', path(id));
      const children = await relationRows(`${path(id)}/sub_issues`);
      const blockedBy = await relationRows(`${path(id)}/dependencies/blocked_by`);
      const external = [...children, ...blockedBy].some(item => item.id === null);
      return { children, blockedBy, dependencies: blockedBy.filter(item => item.id !== null).map(item => item.id),
        complete: !external, fetchedAt: new Date().toISOString(),
        warnings: [...(external ? ['Cross-repository relationships cannot be resolved as local task IDs.'] : []),
          'Parent lookup is unsupported. Relationship traversal is not a snapshot.'] };
    },
    async updateTask(id, changes, { expectedRevision, key }) {
      requireValue(Object.keys(changes).every(field => ['title', 'description', 'status', 'priority'].includes(field)), 'unsupported_operation', 'Unsupported GitHub field');
      requireValue(journal, 'unsupported_operation', 'GitHub updates require a durable publication journal');
      const receipt = await journal.perform({ key, kind: 'github.task.update', payload: { id, changes, expectedRevision },
        send: async () => {
          const before = await request('GET', path(id));
          requireValue(before.updated_at === expectedRevision, 'stale_revision', 'GitHub issue changed');
          const body = {};
          if (changes.title !== undefined) body.title = changes.title;
          if (changes.description !== undefined) body.body = changes.description;
          if (changes.status !== undefined) {
            requireValue([...statuses, 'done', 'cancelled'].includes(changes.status), 'invalid_request', 'Unknown status');
            body.state = ['done', 'cancelled'].includes(changes.status) ? 'closed' : 'open';
            body.state_reason = changes.status === 'cancelled' ? 'not_planned' : changes.status === 'done' ? 'completed' : 'reopened';
          }
          if (changes.status !== undefined || changes.priority !== undefined) {
            if (changes.priority !== undefined) requireValue(['critical', 'high', 'medium', 'low'].includes(changes.priority), 'invalid_request', 'Unknown priority');
            const retained = (before.labels ?? []).map(label => label.name ?? label).filter(label =>
              !(changes.status !== undefined && statuses.some(s => statusLabel(s) === label)) &&
              !(changes.priority !== undefined && label.startsWith('relay:priority:')));
            body.labels = [...retained, ...(statuses.includes(changes.status) ? [statusLabel(changes.status)] : []),
              ...(changes.priority ? [priorityLabel(changes.priority)] : [])];
          }
          return request('PATCH', path(id), body);
        },
        reconcile: async () => {
          const current = await request('GET', path(id));
          const projected = project(current);
          const matches = Object.entries(changes).every(([field, value]) => projected[field] === value);
          return matches ? current : null;
        } });
      return project(receipt);
    },
    async createTask(task, { key } = {}) {
      requireValue(journal, 'unsupported_operation', 'GitHub create requires a durable publication journal');
      requireValue(task && Object.keys(task).every(field => ['title', 'description', 'priority', 'status'].includes(field)) &&
        typeof task.title === 'string' && task.title.trim() && (!task.status || statuses.includes(task.status)) &&
        (!task.priority || ['critical', 'high', 'medium', 'low'].includes(task.priority)) &&
        (task.description === undefined || typeof task.description === 'string'), 'invalid_request', 'Supported nonterminal task fields required');
      const receipt = await journal.perform({ key, kind: 'github.task.create', payload: task,
        send: operation => request('POST', `${base}/issues`, { title: task.title,
          body: `${task.description ?? ''}\n\n<!-- ${operation.marker} -->`,
          labels: [statusLabel(task.status ?? 'todo'), priorityLabel(task.priority ?? 'medium')] }),
        reconcile: async operation => {
          const matches = [];
          for (let page = 1; page <= 100; page++) {
            const issues = await request('GET', `${base}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`);
            requireValue(Array.isArray(issues), 'invalid_backend_response', 'Issue collection required');
            matches.push(...issues.filter(issue => !issue.pull_request && issue.body?.endsWith(`<!-- ${operation.marker} -->`) && issue.title === task.title));
            if (issues.length < 100) {
              requireValue(matches.length <= 1, 'ambiguous_receipt', 'Multiple issues match the operation');
              return matches[0];
            }
          }
          requireValue(false, 'incomplete_query', 'Issue receipt reconciliation exceeded its bound');
        },
      });
      return project(receipt);
    },
    async addComment(id, body, { key } = {}) {
      requireValue(journal, 'unsupported_operation', 'GitHub comment requires a durable publication journal');
      requireValue(typeof body === 'string' && body.trim(), 'invalid_request', 'Comment body required');
      return journal.perform({ key, kind: 'github.comment.create', payload: { id, body },
        send: operation => request('POST', `${path(id)}/comments`, { body: `${body}\n\n<!-- ${operation.marker} -->` }),
        reconcile: async operation => {
          const matches = [];
          for (let page = 1; page <= 100; page++) {
            const comments = await request('GET', `${path(id)}/comments?per_page=100&page=${page}`);
            requireValue(Array.isArray(comments), 'invalid_backend_response', 'Comments collection required');
            matches.push(...comments.filter(comment => comment.body === `${body}\n\n<!-- ${operation.marker} -->`));
            if (comments.length < 100) {
              requireValue(matches.length <= 1, 'ambiguous_receipt', 'Multiple comments match operation');
              return matches[0];
            }
          }
          requireValue(false, 'incomplete_query', 'Comment reconciliation exceeded its bound');
        },
      });
    },
  };
}
