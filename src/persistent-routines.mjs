import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { enrolmentDirectories } from './enrolment.mjs';
import { observedAgents } from './herdr-agents.mjs';
import { canonical, digest, requireValue } from './protocol.mjs';

const fail = (condition, code, message) => requireValue(condition, code, message, 409);
const exactPath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value &&
  !/[\x00-\x1f\x7f-\x9f*]/.test(value);
const fresh = value => Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) < 15000;
const inScope = (item, scope) => item?.identity?.companyId === scope.companyId &&
  item.identity.machineId === scope.machineId && item.identity.session === scope.session;
const locks = new Map();

export function persistentRoutineScope(store, config, companyId, directory) {
  let authorised = false;
  try {
    authorised = exactPath(directory) && config?.companyId === companyId &&
      enrolmentDirectories(store, config).includes(directory);
  } catch { /* Invalid or missing configuration is not a directory grant. */ }
  fail(authorised, 'routine_scope_revoked', 'Routine directory requires an existing exact authorised scope');
  return { companyId, directory, machineId: config.machineId, session: config.session, socketPath: config.socketPath };
}

export function resolveRoutineFolder(store, scope, config, admit) {
  fail(canonical(scope) === canonical(persistentRoutineScope(store, config, scope?.companyId, scope?.directory)),
    'routine_scope_revoked', 'Routine directory scope changed');
  const blocked = reason => ({ ready: false, blocker: 'routine_target_busy', reason, target: null });
  const bridges = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'opencode-bridge:%'").all()
    .map(row => JSON.parse(row.data)).filter(item => {
      if (item.identity?.directory !== scope.directory) return false;
      const binding = store.binding(item.identity.bindingId, false);
      return inScope(store.operation(item.identity.observedId), scope) ||
        binding?.config.companyId === scope.companyId && binding.config.harness === 'opencode' &&
        binding.config.instanceId === digest([scope.machineId, scope.session]);
    });
  if (bridges.some(item => store.runs(item.identity.bindingId).some(run => run.nativeState !== 'settled'))) return blocked('unavailable');
  const candidates = observedAgents(store).filter(item => inScope(item, scope) && item.identity.harness === 'opencode' &&
    item.identity.sessionKind === 'id' && item.placement?.directory === scope.directory && item.availability !== 'offline');
  if (!candidates.length) return blocked('offline');
  if (candidates.length !== 1) return blocked('ambiguous');
  const observed = candidates[0];
  if (observed.availability !== 'present' || observed.error || !fresh(observed.updatedAt)) return blocked('unavailable');
  const matches = bridges.filter(item => item.identity.observedId === observed.id);
  if (matches.length !== 1) return blocked(matches.length > 1 ? 'ambiguous' : 'unavailable');
  const result = admit(store, store.binding(matches[0].identity.bindingId, false));
  return result?.ready ? result : blocked('unavailable');
}

export async function ensureRoutineRouter(store, api, scope, contextFile, check = () => {}) {
  fail(exactPath(contextFile), 'invalid_request', 'An exact private routing context file is required');
  const id = `routine-router:${digest(scope)}`;
  const prior = locks.get(id) ?? Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = prior.catch(() => {}).then(() => gate);
  locks.set(id, pending);
  await prior.catch(() => {});
  try {
    const guard = async () => fail(await check() !== false, 'routine_authority_changed', 'Routine router authority changed');
    const call = async (method, path, body) => {
      await guard();
      const result = await api(method, path, body);
      await guard();
      return result;
    };
    await guard();
    let operation = store.operation(id);
    if (!operation) operation = store.transaction(() => store.operation(id) ?? store.saveOperation({
      id, runId: '', scope, contextFile, marker: randomBytes(32).toString('hex'), state: 'intent',
    }));
    fail(canonical(operation.scope) === canonical(scope) && operation.contextFile === contextFile,
      'routine_router_mismatch', 'Router scope or private context changed');
    const adapterConfig = { observationOnly: false, relayRoutineScope: scope, relayRoutineMarker: operation.marker,
      relayContextFile: contextFile, requireReviewDisposition: true };
    const heartbeat = { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 };
    const verify = agent => {
      fail(typeof agent?.id === 'string' && agent.id && (!operation.agentId || agent.id === operation.agentId) &&
        agent.companyId === scope.companyId && agent.adapterType === 'herdr_relay' &&
        ['idle', 'running', 'error'].includes(agent.status) &&
        Object.entries(adapterConfig).every(([key, value]) => canonical(agent.adapterConfig?.[key]) === canonical(value)) &&
        !['bindingId', 'bindingRevision', 'relayObservationMarker'].some(key => Object.hasOwn(agent.adapterConfig ?? {}, key)) &&
        Object.entries(heartbeat).every(([key, value]) => agent.runtimeConfig?.heartbeat?.[key] === value),
      'routine_router_mismatch', 'Backend router does not match the durable folder intent');
      return agent;
    };
    const listed = await call('GET', `/api/companies/${encodeURIComponent(scope.companyId)}/agents`);
    fail(Array.isArray(listed), 'invalid_backend_response', 'Expected a backend agent list');
    const matches = listed.filter(agent => agent.adapterConfig?.relayRoutineMarker === operation.marker);
    fail(matches.length <= 1, 'routine_router_mismatch', 'Router marker must identify exactly one agent');
    let agent = matches[0];
    if (!agent) {
      fail(!operation.agentId && operation.state === 'intent', 'operation_uncertain', 'Router creation is uncertain. No duplicate POST is authorised');
      await guard();
      const claimed = store.transaction(() => {
        const live = store.operation(id);
        if (live.state !== 'intent') return false;
        operation = store.saveOperation({ ...live, state: 'uncertain' });
        return true;
      });
      fail(claimed, 'operation_uncertain', 'Another caller attempted router creation');
      agent = await call('POST', `/api/companies/${encodeURIComponent(scope.companyId)}/agents`, {
        name: `${basename(scope.directory) || 'root'} cron`, adapterType: 'herdr_relay', adapterConfig, runtimeConfig: { heartbeat },
      });
    } else {
      verify(agent);
      agent = await call('GET', `/api/agents/${encodeURIComponent(agent.id)}`);
    }
    verify(agent);
    store.saveOperation({ ...store.operation(id), agentId: agent.id, state: 'recorded' });
    return { agentId: agent.id, marker: operation.marker, scope: structuredClone(scope) };
  } finally {
    release();
    if (locks.get(id) === pending) locks.delete(id);
  }
}
