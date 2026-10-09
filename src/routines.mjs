import { randomBytes } from 'node:crypto';
import { canonical, digest, requireValue, text } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';
import { persistentRoutineScope, ensureRoutineRouter, resolveRoutineFolder } from './persistent-routines.mjs';
import { useChatReviewForRoutine } from './job-review.mjs';

const fail = (condition, code, message) => requireValue(condition, code, message, 409);
const records = store => store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine:%' ORDER BY rowid")
  .all().map(row => JSON.parse(row.data));
const fresh = (value, limit) => Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) < limit;
const locks = new WeakMap();
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const runView = value => pick(value, ['id', 'routineId', 'companyId', 'status', 'source', 'linkedIssueId', 'triggeredAt', 'completedAt']);

function projection(record) {
  return { scheduleId: record.id, routineId: record.routineId ?? null, state: record.state,
    ...pick(record.request, ['companyId', 'title', 'description', 'targetBindingId', 'targetDirectory', 'cron', 'timezone', 'projectId', 'parentTaskId', 'relayReviewPolicy']),
    ...(record.persistentScope ? { persistentScope: pick(record.persistentScope, ['companyId', 'directory', 'machineId', 'session', 'socketPath']),
      routerAgentId: record.router?.agentId ?? null } : {}),
    target: record.target, origin: pick(record.authority, ['kind', 'bindingId', 'conversationId', 'sessionCreatedAt']), triggerId: record.triggerId ?? null,
    latestRevisionId: record.latestRevisionId ?? null, nextRunAt: record.nextRunAt ?? null,
    created: record.created === true, cancellationRequested: record.cancellationRequested === true,
    pauseStopsRunningWork: false };
}

export function routineRecords(store) { return records(store).map(projection); }

// A configured/armed bridge is the existing explicit conversation reservation.
// Its absence must never turn an arbitrary registered agent into a cron target.
export function routineTargetAdmission(store, binding, task, { allowBusyBridge = false } = {}) {
  const blocked = blocker => ({ ready: false, blocker, target: null });
  if (!binding || binding.lifecycleState || !['persistent', 'service'].includes(binding.config.lifetime ?? 'persistent') ||
    binding.config.harness !== 'opencode' || binding.config.delivery !== 'pull') return blocked('routine_target_ineligible');
  const bridge = store.operation(`opencode-bridge:${binding.id}`), identity = bridge?.identity;
  if (!(allowBusyBridge && !task ? ['configured', 'armed'].includes(bridge?.state)
    : bridge?.state === 'armed' && bridge.ready === true) || !fresh(bridge?.lastSeen, 10000) ||
    typeof bridge.epoch !== 'string' || !bridge.epoch || !Number.isSafeInteger(bridge.sessionCreatedAt) || bridge.sessionCreatedAt <= 0 ||
    identity?.bindingId !== binding.id || identity.conversationId !== binding.config.conversationId ||
    !identity.directory || !identity.terminalId) return blocked('routine_bridge_unavailable');
  const observed = store.operation(identity.observedId);
  if (observed?.availability !== 'present' || observed.error || !fresh(observed.updatedAt, 15000) ||
    observed.identity?.harness !== 'opencode' || observed.identity.sessionKind !== 'id' ||
    observed.identity.companyId !== binding.config.companyId || observed.agentId !== binding.config.agentId ||
    observed.identity.conversationId !== identity.conversationId ||
    binding.config.instanceId !== digest([observed.identity.machineId, observed.identity.session]) ||
    observed.placement?.directory !== identity.directory || observed.placement.terminalId !== identity.terminalId ||
    typeof observed.marker !== 'string' || !observed.marker) return blocked('routine_observation_mismatch');
  try { store.assertWorkerAdmission(binding.id); } catch { return blocked('worker_grant_inactive'); }
  const target = { bindingId: binding.id, bindingRevision: binding.revision, bindingCreatedAt: binding.createdAt,
    bindingConfig: digest(binding.config), companyId: binding.config.companyId, agentId: binding.config.agentId,
    conversationId: binding.config.conversationId, sessionCreatedAt: bridge.sessionCreatedAt,
    observedId: identity.observedId, observationIdentity: digest(observed.identity), observationMarker: observed.marker,
    directory: identity.directory, terminalId: identity.terminalId };
  if (task) {
    const matches = records(store).filter(record => record.routineId === task.originId && record.request.companyId === task.companyId);
    const record = matches[0];
    if (task.originKind !== 'routine_execution' || !task.originRunId || matches.length !== 1 || !record.created ||
      record.cancellationRequested || record.state === 'cancelled' || task.assigneeAgentId !== target.agentId || task.assigneeUserId ||
      canonical(record.target) !== canonical(target)) return blocked('routine_execution_mismatch');
  }
  if (store.runs(binding.id).some(run => run.nativeState !== 'settled')) return blocked('conversation_busy');
  return { ready: true, blocker: null, target };
}

function verifyRoutine(record, value, strict = true) {
  fail(value && typeof value.id === 'string' && value.id && (!record.routineId || value.id === record.routineId) &&
    value.companyId === record.request.companyId && (!strict || value.description === record.body.description),
  'routine_identity_mismatch', 'Backend routine does not match the durable Relay intent');
  fail(typeof value.latestRevisionId === 'string' && value.latestRevisionId && ['paused', 'active', 'archived'].includes(value.status),
    'invalid_backend_response', 'Routine status and latest revision are required');
  if (strict) fail(Object.entries(record.body).filter(([key]) => key !== 'status').every(([key, expected]) =>
    canonical(value[key]) === canonical(expected)), 'routine_scope_changed', 'Backend routine configuration changed');
  return value;
}

function verifyTrigger(record, value) {
  fail(value && typeof value.id === 'string' && value.id && (!record.triggerId || record.triggerId === value.id) &&
    value.routineId === record.routineId && value.companyId === record.request.companyId && value.archived !== true &&
    typeof value.enabled === 'boolean' && Object.entries(record.triggerBody).filter(([key]) => key !== 'enabled')
      .every(([key, expected]) => value[key] === expected), 'routine_trigger_mismatch', 'Backend trigger does not match the exact routine intent');
  return value;
}

// companyId and authority are supplied by the authenticated server, never by a timer.
// check revalidates native human permission/source before and after every backend call.
export async function manageRoutine(store, api, input, { check = () => {}, authority = { kind: 'operator' }, observationConfig, routingContextFile } = {}) {
  input = structuredClone(input);
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'invalid_request', 'Routine input is required');
  const action = text(input.action, 'action'), companyId = text(input.companyId, 'companyId');
  requireValue(['create', 'list', 'inspect', 'pause', 'resume', 'cancel', 'run', 'edit'].includes(action), 'invalid_request', 'Unknown routine action');
  const allowed = ['action', 'companyId', ...(action === 'create' ? ['key', 'title', 'description', 'targetBindingId', 'targetDirectory', 'cron', 'timezone',
    'projectId', 'parentTaskId', 'relayReviewPolicy', 'enabled'] : action === 'list' ? [] : ['scheduleId',
    ...(['pause', 'resume', 'cancel', 'run', 'edit'].includes(action) ? ['key'] : []), ...(['run', 'edit'].includes(action) ? ['payload'] : [])])];
  requireValue(Object.keys(input).every(key => allowed.includes(key)), 'invalid_request', 'Unsupported routine field');
  requireValue(authority && ['operator', 'native'].includes(authority.kind), 'forbidden', 'Routine management requires human authority', 403);
  authority = authority.kind === 'operator' ? { kind: 'operator' } : { kind: 'native',
    ...Object.fromEntries(['bindingId', 'conversationId', ...(['list', 'inspect'].includes(action) ? [] : ['sourceMessageId', 'sourceDigest'])].map(key => [key, text(authority[key], `authority.${key}`)])),
    sessionCreatedAt: authority.sessionCreatedAt };
  requireValue(authority.kind !== 'native' || Number.isSafeInteger(authority.sessionCreatedAt) && authority.sessionCreatedAt > 0,
    'invalid_origin', 'Native authority requires an exact session');
  const owner = value => pick(value, ['kind', 'bindingId', 'conversationId', 'sessionCreatedAt']);
  const guard = async () => fail(await check() !== false, 'routine_authority_changed', 'Routine permission or human source changed');
  await guard();
  const folderOwner = record => {
    if (!record.persistentScope || authority.kind !== 'native') return false;
    const bridge = store.operation(`opencode-bridge:${authority.bindingId}`), binding = store.binding(authority.bindingId, false);
    if (bridge?.identity?.directory !== record.persistentScope.directory || bridge.identity.conversationId !== authority.conversationId ||
      bridge.sessionCreatedAt !== authority.sessionCreatedAt || binding?.config.companyId !== companyId ||
      binding.config.instanceId !== digest([record.persistentScope.machineId, record.persistentScope.session])) return false;
    try {
      return canonical(record.persistentScope) === canonical(persistentRoutineScope(store, observationConfig, companyId, bridge.identity.directory));
    } catch { return false; }
  };
  const visible = record => record.request.companyId === companyId && (authority.kind === 'operator' ||
    canonical(owner(record.authority)) === canonical(owner(authority)) || folderOwner(record));
  if (action === 'list') return { routines: records(store).filter(visible).map(projection) };

  let request, scheduleId, persistentScope;
  if (action === 'create') {
    const preview = previewCron(text(input.cron, 'cron'), input.timezone ?? 'Africa/Johannesburg');
    requireValue(input.enabled === undefined || typeof input.enabled === 'boolean', 'invalid_request', 'enabled must be boolean');
    const title = text(input.title, 'title').trim(), description = text(input.description, 'description');
    requireValue(title.length <= 200 && !title.includes('{{') && !description.includes('{{'),
      'invalid_request', 'Routine title is limited to 200 characters and templates are not supported');
    const relayReviewPolicy = input.relayReviewPolicy ?? 'none';
    requireValue(['human', 'none'].includes(relayReviewPolicy), 'invalid_review_policy', 'Routine review must be human or explicitly none');
    requireValue(input.targetDirectory === undefined || input.targetBindingId === undefined,
      'invalid_request', 'targetDirectory and targetBindingId are mutually exclusive');
    if (input.targetDirectory !== undefined) persistentScope = persistentRoutineScope(store, observationConfig, companyId, input.targetDirectory);
    request = { companyId, key: text(input.key, 'key'), title, description,
      ...(persistentScope ? { targetDirectory: persistentScope.directory } : { targetBindingId: text(input.targetBindingId, 'targetBindingId') }),
      cron: preview.cron, timezone: preview.timezone, enabled: input.enabled === true, relayReviewPolicy,
      ...(input.projectId === undefined ? {} : { projectId: text(input.projectId, 'projectId') }),
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: text(input.parentTaskId, 'parentTaskId') }) };
    scheduleId = `routine:${digest([companyId, persistentScope ?? owner(authority), request.key])}`;
  } else scheduleId = text(input.scheduleId, 'scheduleId');

  // Serialise local callers. Durable intents below also refuse duplicate POSTs
  // from another Store connection or after a process restart.
  let queue = locks.get(store);
  if (!queue) { queue = new Map(); locks.set(store, queue); }
  const prior = queue.get(scheduleId) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = prior.catch(() => {}).then(() => gate);
  queue.set(scheduleId, pending);
  await prior.catch(() => {});
  try {
    await guard();
    let record = store.operation(scheduleId);
    if (record) fail(visible(record), 'forbidden', 'Routine belongs to another company or origin');
    if (action !== 'create') fail(record?.id.startsWith('routine:'), 'routine_not_found', 'Unknown Relay scheduleId');
    if (action === 'create' && record) {
      if (input.relayReviewPolicy === undefined) request.relayReviewPolicy = record.request.relayReviewPolicy ?? 'human';
      fail(canonical(record.request) === canonical(request) && canonical(record.authority) === canonical(authority),
        'operation_conflict', 'Routine key has a different request or human source');
      if (record.creationComplete || record.cancellationRequested) return projection(record);
    }
    const save = changes => { record = store.saveOperation({ ...store.operation(scheduleId), ...changes }); return record; };
    const admission = () => {
      if (record) {
        const live = store.operation(scheduleId);
        fail(!live.cancellationRequested && live.state !== 'cancelled', 'routine_cancelled', 'Cancellation prevents new routine work');
      }
      const scope = record?.persistentScope ?? persistentScope;
      if (scope) {
        fail(canonical(scope) === canonical(persistentRoutineScope(store, observationConfig, companyId, scope.directory)),
          'routine_scope_revoked', 'Routine directory scope changed');
        return null;
      }
      const binding = store.binding(record?.request.targetBindingId ?? request.targetBindingId, false);
      // Human-authorised self-setup may run during this turn; occurrence delivery still requires idle.
      const self = authority.kind === 'native' && action !== 'run' && authority.bindingId === binding?.id &&
        authority.conversationId === binding.config.conversationId &&
        authority.sessionCreatedAt === store.operation(`opencode-bridge:${binding.id}`)?.sessionCreatedAt;
      const result = routineTargetAdmission(store, binding, undefined, { allowBusyBridge: self });
      fail(result.ready, result.blocker, 'Routine target requires a fresh, exactly reserved bridge; other targets must be idle');
      fail(result.target.companyId === companyId && (!record || canonical(record.target) === canonical(result.target)),
        'routine_target_changed', 'Routine target identity changed. Explicit rebinding is not supported');
      return result.target;
    };
    const call = async (method, path, body, ready = false) => {
      await guard();
      if (ready) {
        if (record?.persistentScope ?? persistentScope) await backendTarget();
        else admission();
      }
      const result = await api(method, path, body);
      await guard();
      if (ready === true) {
        if (record?.persistentScope ?? persistentScope) await backendTarget();
        else admission();
      }
      return result;
    };
    const backendTarget = async () => {
      const target = admission();
      const scope = record?.persistentScope ?? persistentScope;
      if (scope) {
        const router = await ensureRoutineRouter(store, api, scope, routingContextFile, async () => {
          await guard();
          admission();
        });
        fail(!record?.router && !record?.body || canonical(record?.router) === canonical(router),
          'routine_router_mismatch', 'Routine router identity changed');
        return router;
      }
      const agent = await call('GET', `/api/agents/${encodeURIComponent(target.agentId)}`, undefined, true);
      fail(agent?.id === target.agentId && agent.companyId === companyId && agent.status === 'idle' &&
        agent.adapterType === 'herdr_relay' && agent.adapterConfig?.bindingId === target.bindingId &&
        agent.adapterConfig.bindingRevision === target.bindingRevision && agent.adapterConfig.observationOnly === false &&
        agent.adapterConfig.relayObservationMarker === target.observationMarker && agent.adapterConfig.requireReviewDisposition === true &&
        agent.runtimeConfig?.heartbeat?.enabled === true && agent.runtimeConfig.heartbeat.wakeOnDemand === true &&
        agent.runtimeConfig.heartbeat.maxConcurrentRuns === 1,
      'routine_backend_target_unavailable', 'Backend agent must match the reserved bridge with one concurrent run');
      return target;
    };
    const detail = async (strict = true) => verifyRoutine(record,
      await call('GET', `/api/routines/${encodeURIComponent(record.routineId)}`), strict);
    const trigger = value => {
      fail(Array.isArray(value.triggers) && value.triggers.length === 1, 'routine_trigger_mismatch', 'Exactly one owned trigger is required');
      return verifyTrigger(record, value.triggers[0]);
    };

    if (action === 'edit') {
      fail(record.created && !record.cancellationRequested, 'routine_cancelled', 'Only provisioned, uncancelled jobs can be edited');
      const payload = input.payload;
      requireValue(payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length &&
        Object.keys(payload).every(key => ['title', 'description', 'relayReviewPolicy'].includes(key)), 'invalid_request', 'Unsupported job definition field');
      if (payload.relayReviewPolicy !== undefined) requireValue(['human', 'none'].includes(payload.relayReviewPolicy), 'invalid_review_policy', 'Use chat output review or explicit human approval');
      const id = `routine-edit:${digest([companyId, owner(authority), text(input.key, 'key')])}`;
      const editRequest = { scheduleId, payload, authority };
      let edit = store.operation(id);
      fail(!edit || canonical(edit.request) === canonical(editRequest), 'operation_conflict', 'Job edit key has another request or source');
      if (edit?.state === 'recorded') return { ...projection(record), operationId: id };
      if (!edit) {
        const body = { ...record.body };
        if (payload.title !== undefined) {
          body.title = text(payload.title, 'title').trim();
          requireValue(body.title.length <= 200 && !body.title.includes('{{'), 'invalid_request', 'Invalid job title');
        }
        if (payload.description !== undefined) {
          const description = text(payload.description, 'description');
          requireValue(!description.includes('{{'), 'invalid_request', 'Templates are not supported');
          body.description = `${description}\n\n${record.marker}`;
        }
        await detail();
        edit = store.saveOperation({ id, runId: '', request: editRequest, state: 'uncertain', body,
          previous: { body: record.body, relayReviewPolicy: record.request.relayReviewPolicy },
          relayReviewPolicy: payload.relayReviewPolicy ?? record.request.relayReviewPolicy });
        save({ editOperationId: id });
      }
      fail(store.operation(scheduleId).editOperationId === id, 'routine_operation_superseded', 'Another edit superseded this operation');
      const current = await detail(false);
      const matches = body => Object.entries(body).filter(([key]) => key !== 'status').every(([key, value]) => canonical(current[key]) === canonical(value));
      if (!matches(edit.body)) {
        fail(matches(edit.previous.body), 'routine_scope_changed', 'Native job changed outside this edit');
        fail(!edit.sent, 'operation_uncertain', 'Native edit is not confirmed; no blind resend');
        edit = store.saveOperation({ ...edit, sent: true });
        await call('PATCH', `/api/routines/${encodeURIComponent(record.routineId)}`, {
          title: edit.body.title, description: edit.body.description, baseRevisionId: current.latestRevisionId,
        });
      }
      const verified = await detail(false);
      fail(Object.entries(edit.body).filter(([key]) => key !== 'status').every(([key, value]) => canonical(verified[key]) === canonical(value)),
        'operation_uncertain', 'Native job has not confirmed the definition');
      const versions = record.versions ?? [];
      if (!versions.some(version => version.editOperationId === id)) versions.push({ ...edit.previous, editOperationId: id });
      save({ body: edit.body, versions, latestRevisionId: verified.latestRevisionId,
        request: { ...record.request, ...(payload.title === undefined ? {} : { title: payload.title.trim() }),
          ...(payload.description === undefined ? {} : { description: payload.description }), relayReviewPolicy: edit.relayReviewPolicy } });
      if (payload.relayReviewPolicy === 'none') await useChatReviewForRoutine(store, api, record, id, guard);
      await guard();
      store.saveOperation({ ...store.operation(id), state: 'recorded' });
      return { ...projection(record), operationId: id };
    }

    if (action === 'create' && !record?.created) {
      if (record?.persistentScope) await backendTarget();
      if (!record?.body) {
        if (persistentScope && !record) {
          record = store.transaction(() => store.operation(scheduleId) ?? store.saveOperation({
            id: scheduleId, runId: '', request, authority, persistentScope, target: null, state: 'intent',
          }));
          fail(canonical(record.request) === canonical(request) && canonical(record.authority) === canonical(authority),
            'operation_conflict', 'Concurrent routine key has different configuration or source');
        }
        const backend = await backendTarget();
        const target = persistentScope ? null : backend;
        if (persistentScope) save({ router: backend });
        for (const [collection, id] of [['projects', request.projectId], ['issues', request.parentTaskId]]) {
          if (!id) continue;
          const resource = await call('GET', `/api/${collection}/${encodeURIComponent(id)}`, undefined, true);
          fail(resource?.id === id && resource.companyId === companyId, 'routine_resource_mismatch', 'Routine resource belongs to another company');
        }
        await guard();
        admission();
        const marker = `<!-- herdr-relay-routine:${randomBytes(32).toString('hex')} -->`;
        const body = { title: request.title, description: `${request.description}\n\n${marker}`, assigneeAgentId: backend.agentId,
          projectId: request.projectId ?? null, parentIssueId: request.parentTaskId ?? null, folderId: null, goalId: null,
          status: 'paused', priority: 'medium', concurrencyPolicy: 'skip_if_active', catchUpPolicy: 'skip_missed',
          activityGatePolicy: 'always', activityGateScope: 'company', variables: [], env: null };
        const claimed = store.transaction(() => {
          const concurrent = store.operation(scheduleId);
          if (concurrent?.body) return false;
          fail(!concurrent || canonical(concurrent.request) === canonical(request) && canonical(concurrent.authority) === canonical(authority),
            'operation_conflict', 'Concurrent routine key has different configuration or source');
          store.saveOperation({ ...concurrent, id: scheduleId, runId: '', request, authority, target, marker, body, state: 'uncertain',
            ...(persistentScope ? { persistentScope, router: backend } : {}),
            triggerBody: { kind: 'schedule', label: `relay-${digest(marker)}`, enabled: false, cronExpression: request.cron, timezone: request.timezone } });
          return true;
        });
        record = store.operation(scheduleId);
        fail(canonical(record.request) === canonical(request) && canonical(record.authority) === canonical(authority),
          'operation_conflict', 'Concurrent routine key has different configuration');
        if (claimed) {
          // There is no native create idempotency. An intent is never POSTed twice.
          const receipt = await call('POST', `/api/companies/${encodeURIComponent(companyId)}/routines`, record.body, true);
          verifyRoutine(record, receipt);
          fail(receipt.status === 'paused', 'routine_scope_changed', 'New routines must be paused');
          save({ routineId: receipt.id, latestRevisionId: receipt.latestRevisionId });
        }
      }
      if (!record.routineId) {
        const listed = await call('GET', `/api/companies/${encodeURIComponent(companyId)}/routines`);
        fail(Array.isArray(listed), 'invalid_backend_response', 'Expected a native routine list');
        const matches = listed.filter(value => typeof value.description === 'string' && value.description.includes(record.marker));
        fail(matches.length === 1, 'operation_uncertain', 'Routine creation is uncertain. No duplicate POST is authorised');
        const found = verifyRoutine(record, matches[0]);
        fail(found.status === 'paused', 'routine_scope_changed', 'Unverified routine must remain paused');
        save({ routineId: found.id, latestRevisionId: found.latestRevisionId });
      }
      let current = await detail();
      fail(current.status === 'paused', 'routine_scope_changed', 'Routine must remain paused during trigger provisioning');
      fail(Array.isArray(current.triggers), 'invalid_backend_response', 'Routine detail must contain triggers');
      if (!record.triggerAttempted) {
        fail(current.triggers.length === 0, 'routine_trigger_mismatch', 'Unowned triggers prevent provisioning');
        await guard();
        const claimed = store.transaction(() => {
          if (store.operation(scheduleId).triggerAttempted) return false;
          save({ triggerAttempted: true });
          return true;
        });
        if (claimed) {
          const receipt = await call('POST', `/api/routines/${encodeURIComponent(record.routineId)}/triggers`, record.triggerBody,
            Boolean(record.persistentScope));
          const found = verifyTrigger(record, receipt?.trigger);
          fail(found.enabled === false, 'routine_trigger_mismatch', 'New trigger must be disabled');
          save({ triggerId: found.id });
        }
        current = await detail();
      }
      const matches = current.triggers.filter(value => value.label === record.triggerBody.label);
      fail(matches.length === 1, 'operation_uncertain', 'Trigger creation is uncertain. No duplicate POST is authorised');
      const found = trigger(current);
      fail(found.enabled === false, 'routine_trigger_mismatch', 'Unverified trigger must remain disabled');
      save({ triggerId: found.id, latestRevisionId: current.latestRevisionId, state: 'paused', created: true });
    }

    if (action === 'inspect') {
      if (!record.routineId) return { ...projection(record), runs: [] };
      const current = await detail(false);
      if (current.status === 'archived') save({ state: 'cancelled', cancellationRequested: true });
      const runs = await call('GET', `/api/routines/${encodeURIComponent(record.routineId)}/runs?limit=50`);
      fail(Array.isArray(runs) && runs.every(run => run.routineId === record.routineId && run.companyId === companyId),
        'invalid_backend_response', 'Routine history belongs to another scope');
      let delivery;
      if (record.persistentScope) {
        try {
          const resolved = resolveRoutineFolder(store, record.persistentScope, observationConfig, routineTargetAdmission);
          delivery = { state: resolved.ready ? 'ready' : 'waiting', reason: resolved.reason ?? null,
            conversationId: resolved.target?.conversationId ?? null };
        } catch (error) { delivery = { state: 'blocked', reason: error.code, conversationId: null }; }
      }
      return { ...projection(record), backendStatus: current.status, runs: runs.map(runView), ...(delivery ? { delivery } : {}) };
    }
    if (action === 'create' && !request.enabled) {
      if (record.persistentScope) await backendTarget();
      return projection(save({ creationComplete: true }));
    }

    const mutationAction = action === 'create' ? 'resume' : action;
    const mutationId = `routine-mutation:${digest([companyId, owner(authority), action === 'create' ? ['create', scheduleId] : text(input.key, 'key')])}`;
    const mutationRequest = { scheduleId, action: mutationAction, authority,
      ...(action === 'run' ? { payload: input.payload ?? null } : {}) };
    if (action === 'run') requireValue(mutationRequest.payload === null || typeof mutationRequest.payload === 'object' &&
      !Array.isArray(mutationRequest.payload) && JSON.stringify(mutationRequest.payload).length <= 65536 &&
      !JSON.stringify(mutationRequest.payload).includes('{{'), 'invalid_request', 'Run payload must be a bounded object without templates');
    let mutation = store.operation(mutationId);
    if (mutation) {
      fail(canonical(mutation.request) === canonical(mutationRequest), 'operation_conflict', 'Mutation key has a different payload or source');
      if (mutation.state === 'recorded') return { ...projection(record), operationId: mutation.id, ...(mutation.receipt ? { run: mutation.receipt } : {}) };
    }
    fail(mutationAction === 'cancel' || !record.cancellationRequested && record.state !== 'cancelled', 'routine_cancelled', 'Cancelled routines cannot be resumed or run');
    fail(record.routineId, 'operation_uncertain', 'Reconcile routine creation before managing it');
    if (!mutation) mutation = store.transaction(() => {
      const existing = store.operation(mutationId);
      if (existing) {
        fail(canonical(existing.request) === canonical(mutationRequest), 'operation_conflict', 'Mutation key has different configuration');
        return existing;
      }
      if (mutationAction === 'cancel') save({ cancellationRequested: true, creationComplete: true });
      if (mutationAction !== 'run') save({ controlOperationId: mutationId });
      return store.saveOperation({ id: mutationId, runId: '', request: mutationRequest, state: 'uncertain', steps: {} });
    });
    const currentControl = () => {
      const live = store.operation(scheduleId);
      fail(mutationAction === 'run' || live.controlOperationId === mutationId,
        'routine_operation_superseded', 'A newer control operation superseded this routine update');
      fail(mutationAction === 'cancel' || !live.cancellationRequested && live.state !== 'cancelled',
        'routine_cancelled', 'Cancellation prevents new routine work');
    };
    currentControl();
    const saveMutation = changes => { mutation = store.saveOperation({ ...store.operation(mutationId), ...changes }); };
    const finish = changes => {
      currentControl();
      save(changes);
      saveMutation({ state: 'recorded' });
      return { ...projection(record), operationId: mutation.id, ...(mutation.receipt ? { run: mutation.receipt } : {}) };
    };
    if (mutationAction === 'run') {
      if (mutation.body) {
        const runs = await call('GET', `/api/routines/${encodeURIComponent(record.routineId)}/runs?limit=100`);
        fail(Array.isArray(runs), 'invalid_backend_response', 'Expected routine run list');
        const matches = runs.filter(run => run.idempotencyKey === mutation.body.idempotencyKey && run.source === 'manual' && !run.triggerId);
        fail(matches.length <= 1, 'operation_uncertain', 'Ambiguous manual run receipt');
        if (matches.length === 1) {
          const receipt = matches[0];
          fail(receipt.routineId === record.routineId && receipt.companyId === companyId && typeof receipt.id === 'string' && receipt.id,
            'invalid_backend_response', 'Manual run receipt has another identity');
          saveMutation({ receipt: runView(receipt) });
          return finish({});
        }
      }
      fail(record.created, 'operation_uncertain', 'Routine provisioning must complete before running');
      const current = await detail();
      fail(current.status !== 'archived', 'routine_cancelled', 'Archived routines cannot run');
      trigger(current);
      await backendTarget();
      await guard();
      admission();
      currentControl();
      if (!mutation.body) saveMutation({ body: { source: 'manual', payload: mutationRequest.payload, idempotencyKey: `relay-${digest(mutationId)}` } });
      const receipt = await call('POST', `/api/routines/${encodeURIComponent(record.routineId)}/run`, mutation.body, 'send');
      fail(receipt?.routineId === record.routineId && receipt.companyId === companyId && typeof receipt.id === 'string' && receipt.id &&
        receipt.idempotencyKey === mutation.body.idempotencyKey && receipt.source === 'manual' && !receipt.triggerId,
      'invalid_backend_response', 'Manual run receipt has another identity');
      saveMutation({ receipt: runView(receipt) });
      return finish({});
    }

    const desired = mutationAction === 'cancel' ? 'archived' : mutationAction === 'pause' ? 'paused' : 'active';
    let current = await detail(desired === 'active');
    if (current.status === 'archived') {
      save({ state: 'cancelled', cancellationRequested: true, creationComplete: true });
      fail(desired === 'archived', 'routine_cancelled', 'Archived routines cannot be resurrected');
    }
    const patch = async (step, path, body, confirmed, ready) => {
      currentControl();
      if (confirmed) return;
      await guard();
      if (ready) await backendTarget();
      currentControl();
      const claimed = store.transaction(() => {
        const latest = store.operation(mutationId);
        if (latest.steps[step]) return false;
        saveMutation({ steps: { ...latest.steps, [step]: { path, body } } });
        return true;
      });
      fail(claimed, 'operation_uncertain', 'Backend has not confirmed the previous update. No blind replay is authorised');
      await call('PATCH', path, body, ready);
      currentControl();
    };
    if (desired === 'active') {
      fail(record.created && !record.cancellationRequested, 'routine_cancelled', 'Only provisioned, uncancelled routines can activate');
      await backendTarget();
      const found = trigger(current);
      await patch('trigger', `/api/routine-triggers/${encodeURIComponent(found.id)}`, { enabled: true }, found.enabled, true);
      current = await detail();
      fail(trigger(current).enabled, 'operation_uncertain', 'Backend has not confirmed trigger activation');
    }
    await patch('status', `/api/routines/${encodeURIComponent(record.routineId)}`,
      { status: desired, baseRevisionId: current.latestRevisionId }, current.status === desired, desired === 'active');
    current = await detail(desired === 'active');
    fail(current.status === desired, 'operation_uncertain', 'Backend has not confirmed routine status');
    if (desired === 'active') {
      admission();
      fail(trigger(current).enabled, 'operation_uncertain', 'Backend trigger is no longer enabled');
    }
    return finish({ state: desired === 'archived' ? 'cancelled' : desired, latestRevisionId: current.latestRevisionId,
      creationComplete: true, nextRunAt: current.triggers?.find(value => value.id === record.triggerId)?.nextRunAt ?? null });
  } finally {
    release();
    if (queue.get(scheduleId) === pending) queue.delete(scheduleId);
  }
}
