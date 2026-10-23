import { digest, requireValue } from './protocol.mjs';
import { headlessRunAuthority, headlessProbeId } from './headless-setup-contract.mjs';
import { headlessSource } from './headless-capabilities.mjs';

const fields = (p, allowed, required = []) => requireValue(p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(p, k)), 'invalid_headless_request', 'Missing or unsupported headless capability fields');

export function headlessExecutionScope(store, actor, p) {
  const { execution, agent, setup, grant } = headlessRunAuthority(store, actor, p);
  requireValue(grant.capabilities,
    'headless_capability_not_authorised', 'An explicit headless capability grant is required', 403);
  return { execution, agent, setup, grant, profile: grant.capabilities };
}

export function applyHeadlessTask(store, actor, scope, p, { probe = false } = {}) {
  fields(p, ['operation', 'source', 'payload', 'key'], ['operation', 'source', 'payload', 'key']);
  requireValue(scope.profile.taskActions.includes(p.operation) && typeof p.key === 'string' && /^[A-Za-z0-9:_.-]{1,128}$/.test(p.key),
    'headless_operation_forbidden', 'Task action is outside the explicit capability grant', 403);
  const source = headlessSource(scope.profile, p.source);
  requireValue(probe || !source.externalId.startsWith('__relay_probe__'), 'headless_source_forbidden', 'Readiness identities are reserved');
  const ownTask = id => {
    const task = store.get('task', id);
    requireValue(task.responsibleUserId === store.owner, 'headless_task_forbidden', 'Headless task mutations apply only to human-owned tasks', 403);
    return task;
  };
  let payload, before;
  if (p.operation === 'task.create') {
    fields(p.payload, ['title', 'description', 'status', 'priority'], ['title']);
    payload = { ...p.payload, id: `task_headless_${digest([store.owner, source.namespace, source.externalId])}`, externalReference: source };
    const ref = store.get('reference', store.referenceIdentity(source), false);
    if (ref) ownTask(ref.taskId);
  } else if (p.operation === 'task.update') {
    fields(p.payload, ['id', 'expectedRevision', 'changes'], ['id', 'expectedRevision', 'changes']);
    fields(p.payload.changes, ['title', 'description', 'status', 'priority']);
    before = ownTask(p.payload.id);
    requireValue(!store.all('execution').some(e => e.taskId === before.id && !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state)) &&
      !store.all('question').some(q => q.taskId === before.id && q.status === 'open' && q.blocking),
    'headless_task_busy', 'Do not edit tasks with unsettled execution/review/question obligations', 409);
    payload = p.payload;
  } else if (p.operation === 'comment.create') {
    fields(p.payload, ['taskId', 'expectedRevision', 'body'], ['taskId', 'expectedRevision', 'body']);
    before = ownTask(p.payload.taskId); store.revision(before, p.payload.expectedRevision);
    payload = { id: `comment_headless_${digest([scope.setup.id, source.namespace, source.externalId, p.key])}`, taskId: before.id, body: p.payload.body };
  } else {
    fields(p.payload, ['id', 'expectedRevision'], ['id', 'expectedRevision']);
    before = ownTask(p.payload.id); payload = { ...p.payload, reference: source };
  }
  const status = p.operation === 'task.create' ? payload.status : payload.changes?.status;
  requireValue(status === undefined || ['backlog', 'todo', 'blocked', 'done'].includes(status), 'headless_operation_forbidden', 'Task capabilities cannot fabricate execution or cancel work', 403);
  const result = store.apply(actor, p.operation, payload, { headlessTask: true });
  store.event(p.operation === 'task.create' && result.id !== payload.id ? 'task.reference_reused' : p.operation, result, actor, `headless-task:${scope.execution.id}:${p.key}`);
  const task = p.operation === 'comment.create' ? store.get('task', result.taskId) : result;
  requireValue(task.responsibleUserId === store.owner, 'headless_task_forbidden', 'Human responsibility must remain unchanged');
  return { id: `headless_operation_${digest([scope.setup.id, source.namespace, source.externalId, p.operation, p.key])}`, revision: 1,
    state: 'applied', operation: p.operation, source, taskId: task.id, taskReference: task.reference, taskRevision: task.revision,
    executionId: scope.execution.id, runId: scope.execution.runId, result };
}

export function headlessTaskCommand(store, actor, key, p) {
  fields(p, ['executionId', 'runId', 'operation', 'source', 'payload', 'key'], ['executionId', 'runId', 'operation', 'source', 'payload', 'key']);
  const scope = headlessExecutionScope(store, actor, p);
  requireValue(scope.execution.id !== headlessProbeId(scope.setup), 'headless_probe_forbidden', 'Readiness must use rolled-back task canaries, not real job mutations');
  const { executionId, runId, ...semantic } = p;
  const logicalKey = `headless-operation:${digest([scope.setup.id, p.source?.namespace, p.source?.externalId, p.operation, p.key])}`;
  return store.mutate(actor, key, 'headless.task', p, () => store.mutate(actor, logicalKey, 'headless.task', semantic, () => applyHeadlessTask(store, actor, scope, semantic)));
}

export function headlessReferenceLookup(store, actor, p) {
  fields(p, ['executionId', 'runId', 'reference', 'aliases'], ['executionId', 'runId', 'reference']);
  const scope = headlessExecutionScope(store, actor, p); headlessSource(scope.profile, p.reference);
  requireValue(p.aliases === undefined || Array.isArray(p.aliases) && p.aliases.length <= 16, 'invalid_headless_request', 'Bounded explicit aliases required');
  const references = [p.reference, ...(p.aliases ?? [])];
  const matches = [];
  for (const ref of references) {
    const native = store.get('reference', store.referenceIdentity(ref), false);
    if (native && !matches.some(m => m.task.id === native.taskId)) matches.push({ task: store.get('task', native.taskId), matchedReference: ref });
  }
  return { matches, complete: true, coverage: 'Exact native reference index and explicitly supplied imported aliases only; unexported legacy references are not inferred' };
}

export function headlessTaskProbe(store, actor, p) {
  fields(p, ['executionId', 'runId'], ['executionId', 'runId']);
  const scope = headlessExecutionScope(store, actor, p);
  requireValue(scope.execution.id === headlessProbeId(scope.setup), 'headless_probe_forbidden', 'Capability probing is confined to the current readiness execution');
  const source = { namespace: scope.profile.sourceNamespaces[0], externalId: `__relay_probe__${digest(scope.execution.id)}` };
  let proof;
  store.db.exec('SAVEPOINT headless_capability_probe');
  try {
    if (scope.profile.taskActions.length) {
      // Test only granted actions. Create is internal fixture scaffolding,
      // rolled back even when create is not granted to the worker.
      const probeScope = { ...scope, profile: { ...scope.profile, taskActions: [...new Set(['task.create', ...scope.profile.taskActions])] } };
      const create = applyHeadlessTask(store, actor, probeScope, { key: 'create', operation: 'task.create', source, payload: { title: 'Scoped headless readiness canary' } }, { probe: true });
      let current = create;
      if (scope.profile.taskActions.includes('task.update')) current = applyHeadlessTask(store, actor, scope, { key: 'update', operation: 'task.update', source, payload: { id: create.taskId, expectedRevision: current.taskRevision, changes: { description: 'Readiness round trip' } } }, { probe: true });
      if (scope.profile.taskActions.includes('comment.create')) applyHeadlessTask(store, actor, scope, { key: 'comment', operation: 'comment.create', source, payload: { taskId: current.taskId, expectedRevision: current.taskRevision, body: 'Readiness comment' } }, { probe: true });
      const alias = { ...source, externalId: `${source.externalId}-alias` };
      if (scope.profile.taskActions.includes('reference.attach')) {
        applyHeadlessTask(store, actor, scope, { key: 'reference', operation: 'reference.attach', source: alias, payload: { id: current.taskId, expectedRevision: current.taskRevision } }, { probe: true });
        requireValue(store.get('reference', store.referenceIdentity(alias)).taskId === create.taskId, 'headless_probe_failed', 'Reference canary readback failed');
      }
    }
    proof = { taskActions: scope.profile.taskActions, rolledBack: true };
  } finally { store.db.exec('ROLLBACK TO headless_capability_probe; RELEASE headless_capability_probe'); }
  const value = { ...scope.setup, revision: scope.setup.revision + 1, capabilityProbe: { executionId: scope.execution.id, runId: p.runId, ...proof, digest: digest(proof) } };
  store.save('headless_setup', value);
  return value;
}
