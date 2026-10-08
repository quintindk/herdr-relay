import { canonical, digest, requireValue, text } from './protocol.mjs';
import { humanTask } from './human-tasks.mjs';

const referenceFields = ['companyId', 'namespace', 'externalId', 'url'];
const summaryFields = ['id', 'companyId', 'identifier', 'title', 'status', 'priority', 'assigneeUserId', 'assigneeAgentId'];
const object = (value, fields) => requireValue(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(field => fields.includes(field) && value[field] !== undefined),
'invalid_request', 'Unsupported or missing reference fields');
const referenceId = value => `task-reference:${digest([value.companyId, value.namespace, value.externalId])}`;

function referenceInput(input, withUrl = true) {
  object(input, withUrl ? referenceFields : referenceFields.filter(field => field !== 'url'));
  const reference = {};
  for (const field of ['companyId', 'namespace', 'externalId']) reference[field] = text(input[field], field);
  if (input.url !== undefined) {
    const value = text(input.url, 'url');
    let url;
    try { url = new URL(value); } catch { /* Invalid URLs are rejected below. */ }
    requireValue(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && value === value.trim(),
      'invalid_request', 'Reference URL must be an absolute HTTP(S) URL without credentials');
    reference.url = value;
  }
  return reference;
}

// Validate create metadata without reserving or writing. Company scope is supplied
// by the caller, never accepted from the nested public externalReference object.
export function validateTaskReference(input) {
  return referenceInput(input);
}

function publicReference(operation) {
  const { companyId, namespace, externalId, url } = operation.request;
  return { companyId, namespace, externalId, taskId: operation.taskId ?? null, ...(url === undefined ? {} : { url }) };
}

function sameReference(operation, reference) {
  requireValue(!operation || canonical(operation.request) === canonical(reference),
    'task_reference_conflict', 'External reference has different metadata', 409);
}

function taskSummary(task, companyId, taskId) {
  requireValue(task?.id === taskId && task.companyId === companyId,
    'forbidden', 'Referenced task must belong to the requested company', 403);
  requireValue(summaryFields.every(field => task[field] == null || typeof task[field] === 'string'),
    'invalid_backend_response', 'Expected scalar public task fields', 502);
  return Object.fromEntries(summaryFields.map(field => [field, task[field] ?? null]));
}

// Pure, stable-order public projections for task inspection/revision hashing.
// Each entry is { companyId, namespace, externalId, taskId, url? }. Reservations,
// journal keys, authority/source evidence and internal timestamps are never exposed.
export function taskReferences(store, companyId, taskId) {
  text(companyId, 'companyId');
  text(taskId, 'taskId');
  return store.db.prepare("SELECT data FROM operations WHERE id LIKE 'task-reference:%' ORDER BY id").all()
    .map(row => JSON.parse(row.data))
    .filter(operation => operation.state === 'attached' && operation.request.companyId === companyId && operation.taskId === taskId)
    .map(publicReference);
}

// Returns null, { state: 'reserved', reference }, or
// { state: 'attached', reference, task }. An attached identity is always checked
// against a fresh backend GET before returning a scalar-only public task summary.
export async function lookupTaskReference(store, api, input) {
  const reference = referenceInput(input, false);
  const operation = store.operation(referenceId(reference));
  if (!operation) return null;
  const result = { state: operation.state, reference: publicReference(operation) };
  if (operation.state === 'attached') result.task = taskSummary(
    await api('GET', `/api/issues/${encodeURIComponent(operation.taskId)}`), reference.companyId, operation.taskId);
  return result;
}

// Synchronous create reservation, committed before any backend create request.
// ownerKey must be the caller's durable, company/authority-scoped creation journal
// identity, reused with the same backend idempotency key/body after uncertainty.
// Returns { state: 'reserved'|'attached', ...publicReference }. An attached result
// (even from another owner) means reuse that identity, never create/reopen a task.
// URL is immutable, including absent versus present. There is no automatic release.
export function reserveTaskReference(store, input, ownerKey) {
  const reference = referenceInput(input);
  text(ownerKey, 'ownerKey');
  return store.transaction(() => {
    const id = referenceId(reference);
    let operation = store.operation(id);
    sameReference(operation, reference);
    if (operation) {
      requireValue(operation.state === 'attached' || operation.ownerKey === ownerKey,
        'task_reference_reserved', 'External reference is reserved by another creation', 409);
    } else operation = store.saveOperation({ id, runId: '', request: reference, ownerKey, state: 'reserved', taskId: null });
    return { state: operation.state, ...publicReference(operation) };
  });
}

// Finishes only the exact reservation owner and metadata. The caller must first
// validate the backend receipt's company and task identity. Repeating the same
// finish is read-only. A different taskId or owner can never reassign a reference.
export function finishTaskReference(store, input, ownerKey, taskId) {
  const reference = referenceInput(input);
  text(ownerKey, 'ownerKey');
  text(taskId, 'taskId');
  return store.transaction(() => {
    let operation = store.operation(referenceId(reference));
    requireValue(operation, 'task_reference_not_reserved', 'Reserve the external reference before finishing', 409);
    sameReference(operation, reference);
    requireValue(operation.ownerKey === ownerKey, 'task_reference_reserved', 'Only the reservation owner may finish creation', 409);
    requireValue(operation.state === 'reserved' || operation.taskId === taskId,
      'task_reference_conflict', 'External reference already identifies another task', 409);
    if (operation.state === 'reserved') operation = store.saveOperation({ ...operation, state: 'attached', taskId });
    return { state: operation.state, ...publicReference(operation) };
  });
}

// Explicit attachment to an existing backend task, never a backend PATCH.
// Returns { state: 'attached', reference, task }. New references and their exact
// request/authority journal commit atomically. Keys are scoped to durable owner,
// excluding transient source evidence from the ID but retaining it in the request.
// Exact duplicates (also under another key/owner) perform no writes and do not
// consume a new journal key. Existing keys must always match the original request.
// check is synchronous server-authority validation, called around every API await
// and inside the transaction. expectedRevision uses humanTask's inspect contract.
// Public route wrappers must require expectedRevision before calling this utility,
// and supply validated source authority/check. humanTask inspection includes refs.
export async function attachTaskReference(store, api, input, { check = () => {}, authority = { kind: 'operator' } } = {}) {
  object(input, [...referenceFields, 'taskId', 'key', 'expectedRevision']);
  input = structuredClone(input);
  authority = structuredClone(authority);
  requireValue(authority && typeof authority === 'object' && !Array.isArray(authority), 'invalid_authority', 'Server authority required');
  text(authority.kind, 'authority.kind');
  const { taskId, key, expectedRevision, ...fields } = input;
  const reference = referenceInput(fields);
  text(taskId, 'taskId');
  text(key, 'key');
  if (expectedRevision !== undefined) text(expectedRevision, 'expectedRevision');
  const owner = Object.fromEntries(Object.entries(authority).filter(([field]) =>
    !['sourceMessageId', 'sourceCreatedAt', 'sourceDigest', 'source', 'epoch', 'bindingRevision', 'bindingConfig'].includes(field)));
  const id = `task-reference-attach:${digest([reference.companyId, owner, key])}`;
  const request = { ...input, authority };
  const previous = () => {
    const operation = store.operation(id);
    requireValue(!operation || canonical(operation.request) === canonical(request),
      'operation_conflict', 'Reference attachment key has a different request or authority source', 409);
    return operation;
  };
  const existing = () => {
    const operation = store.operation(referenceId(reference));
    sameReference(operation, reference);
    requireValue(!operation || operation.state === 'attached', 'task_reference_reserved', 'External reference has an unresolved creation', 409);
    requireValue(!operation || operation.taskId === taskId,
      'task_reference_conflict', 'External reference already identifies another task', 409);
    return operation;
  };
  check();
  previous();
  existing();
  const references = expectedRevision === undefined ? null : taskReferences(store, reference.companyId, taskId);
  const send = async (...args) => {
    check();
    try { return await api(...args); }
    finally { check(); }
  };
  const snapshot = expectedRevision === undefined ? null : await humanTask(store, send,
    { action: 'inspect', companyId: reference.companyId, taskId }, { check, authority });
  const task = taskSummary(snapshot?.task ?? await send('GET', `/api/issues/${encodeURIComponent(taskId)}`), reference.companyId, taskId);
  return store.transaction(() => {
    check();
    previous();
    let operation = existing();
    if (!operation) {
      requireValue(expectedRevision === undefined || snapshot.revision === expectedRevision,
        'stale_revision', 'Inspect the task again before attaching a reference', 409);
      requireValue(references === null || canonical(references) === canonical(taskReferences(store, reference.companyId, taskId)),
        'stale_revision', 'Task references changed during inspection', 409);
      operation = store.saveOperation({ id: referenceId(reference), runId: '', request: reference, ownerKey: id, state: 'attached', taskId });
      store.saveOperation({ id, runId: '', request, owner, state: 'recorded', taskId, referenceId: operation.id });
    }
    return { state: 'attached', reference: publicReference(operation), task };
  });
}
