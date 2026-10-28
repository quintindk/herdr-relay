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
