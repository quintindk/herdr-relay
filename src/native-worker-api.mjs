import { call, callUploadStream, callDownloadStream } from './client.mjs';
import { requireValue, validKey } from './protocol.mjs';
import { nativeCliCollections } from './native-cli-surface.mjs';
import { validateAttachmentSize, validateSha256 } from './task-attachments.mjs';
import { decodeAttachmentReceiptKey } from './attachment-transport.mjs';

// This route is handled only by the exact-execution proxy, never nativeReadApi.
export function executionAttachmentReceiptKey(target, request) {
  const match = /^\/v1\/task-attachment-receipts\/([^/]+)$/.exec(target.pathname);
  if (!match) return undefined;
  requireValue(target.searchParams.size === 0 && request.body === undefined, 'invalid_query', 'Attachment receipt lookup takes no filters or body');
  const key = decodeAttachmentReceiptKey(match[1]);
  requireValue(validKey(key), 'invalid_key', 'Bounded idempotency key required');
  return key;
}

export async function nativeReadApi(api, request, worker, { taskId } = {}) {
  requireValue(request && Object.keys(request).every(key => ['method', 'path', 'body'].includes(key)) && request.method === 'GET' &&
    typeof request.path === 'string' && request.path.startsWith('/v1/') && request.body === undefined && !request.path.includes('\\'),
  'agent_cli_read_only', 'Read-only CLI requires an ordinary native GET request', 403);
  const target = new URL(request.path, 'http://relay'), parts = target.pathname.split('/'), collection = parts[2];
  requireValue(target.origin === 'http://relay' && !target.hash && parts.length <= 4 &&
    ['info', 'task-identity', ...Object.entries(nativeCliCollections).filter(([name]) => name !== 'task-reference').map(([, path]) => path)].includes(collection),
  'forbidden', 'Read-only CLI cannot access credential, grant-decision or administrative routes', 403);
  if (collection === 'task_attachments') {
    const keys = [...target.searchParams.keys()];
    requireValue(parts.length === 4 ? parts[3] && !keys.length :
      new Set(keys).size === keys.length && keys.every(key => ['taskId', 'status', 'limit', 'cursor'].includes(key)),
    'invalid_query', 'Invalid task attachment query');
    if (taskId !== undefined && parts.length === 3) requireValue(taskId && target.searchParams.get('taskId') === taskId,
      'execution_cli_scope', 'Execution CLI may only list attachments on its assigned task', 403);
  }
  const result = await api('GET', request.path);
  if (collection === 'task_attachments' && taskId !== undefined && parts.length === 4) requireValue(taskId && result.taskId === taskId,
    'execution_cli_scope', 'Execution CLI may only inspect attachments on its assigned task', 403);
  if (collection === 'provision_requests') {
    if (parts[3]) requireValue(result.requesterAgentId === worker.agentId, 'forbidden', 'Preparation belongs to another initiating agent', 403);
    else return { ...result, items: result.items.filter(item => item.requesterAgentId === worker.agentId) };
  }
  return result;
}

// The ordinary CLI parser/commands, using enrolled read-only or exact execution
// scope instead of borrowing the joined node's human operator credential.
export function nativeWorkerApi(connection, scope) {
  const exactScope = () => requireValue(scope.executionId && scope.runId && scope.sourceMessageId,
    'execution_context_required', 'Exact CLI execution provenance required');
  if (!scope.readOnly) exactScope();
  const provenance = { executionId: scope.executionId, runId: scope.runId, sourceMessageId: scope.sourceMessageId,
    ...(scope.inputRevision ? { inputRevision: scope.inputRevision } : {}) };
  const api = (method, path, body) => call(connection, 'POST', scope.readOnly ? '/agent/native-api' : '/work/native-api', {
    ...(!scope.readOnly ? provenance : {}), request: { method, path, ...(body ? { body } : {}) },
  });
  api.uploadBlob = async (sha256, readable, { size, taskId, signal } = {}) => {
    requireValue(!scope.readOnly, 'agent_cli_read_only', 'Read-only CLI cannot upload attachments', 403);
    exactScope();
    requireValue(taskId, 'execution_context_required', 'Exact CLI task identity required');
    validateSha256(sha256);
    validateAttachmentSize(size);
    return callUploadStream(connection, '/work/blob', readable, { headers: {
      'Content-Length': String(size), 'X-Relay-Sha256': sha256, 'X-Relay-Execution-Id': scope.executionId,
      'X-Relay-Run-Id': scope.runId, 'X-Relay-Source-Message-Id': scope.sourceMessageId, 'X-Relay-Task-Id': taskId,
      ...(scope.inputRevision ? { 'X-Relay-Input-Revision': scope.inputRevision } : {}),
    }, signal });
  };
  api.downloadAttachment = async (taskId, attachmentId, { signal } = {}) => {
    requireValue(!scope.readOnly, 'agent_cli_read_only', 'Read-only CLI cannot download attachments', 403);
    exactScope();
    return callDownloadStream(connection, `/work/task-attachment-content?${new URLSearchParams({ ...provenance, taskId, id: attachmentId })}`, { signal });
  };
  return api;
}
