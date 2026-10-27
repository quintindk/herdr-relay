import { call } from './client.mjs';
import { requireValue } from './protocol.mjs';
import { nativeCliCollections } from './native-cli-surface.mjs';

export async function nativeReadApi(api, request, worker) {
  requireValue(request && Object.keys(request).every(key => ['method', 'path', 'body'].includes(key)) && request.method === 'GET' &&
    typeof request.path === 'string' && request.path.startsWith('/v1/') && request.body === undefined && !request.path.includes('\\'),
  'agent_cli_read_only', 'Read-only CLI requires an ordinary native GET request', 403);
  const target = new URL(request.path, 'http://relay'), parts = target.pathname.split('/'), collection = parts[2];
  requireValue(target.origin === 'http://relay' && !target.hash && parts.length <= 4 &&
    ['info', 'task-identity', ...Object.entries(nativeCliCollections).filter(([name]) => name !== 'task-reference').map(([, path]) => path)].includes(collection),
  'forbidden', 'Read-only CLI cannot access credential, grant-decision or administrative routes', 403);
  const result = await api('GET', request.path);
  if (collection === 'provision_requests') {
    if (parts[3]) requireValue(result.requesterAgentId === worker.agentId, 'forbidden', 'Preparation belongs to another initiating agent', 403);
    else return { ...result, items: result.items.filter(item => item.requesterAgentId === worker.agentId) };
  }
  return result;
}

// The ordinary CLI parser/commands, using enrolled read-only or exact execution
// scope instead of borrowing the joined node's human operator credential.
export function nativeWorkerApi(connection, scope) {
  if (scope.readOnly) return (method, path, body) => call(connection, 'POST', '/agent/native-api', { request: { method, path, ...(body ? { body } : {}) } });
  requireValue(scope.executionId && scope.runId && scope.sourceMessageId, 'execution_context_required', 'Exact CLI execution provenance required');
  return (method, path, body) => call(connection, 'POST', '/work/native-api', { executionId: scope.executionId, runId: scope.runId,
    sourceMessageId: scope.sourceMessageId, request: { method, path, ...(body ? { body } : {}) } });
}
