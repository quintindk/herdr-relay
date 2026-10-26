import { call } from './client.mjs';
import { requireValue } from './protocol.mjs';

// The ordinary native CLI parser/commands, using an execution-scoped connector
// instead of borrowing the joined node's human operator credential.
export function nativeWorkerApi(connection, scope) {
  requireValue(scope.executionId && scope.runId && scope.sourceMessageId, 'execution_context_required', 'Exact CLI execution provenance required');
  return (method, path, body) => call(connection, 'POST', '/work/native-api', { ...scope, request: { method, path, ...(body ? { body } : {}) } });
}
