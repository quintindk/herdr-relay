import { digest, requireValue } from './protocol.mjs';
import { canonicalDirectory } from './interactive-contract.mjs';
import { previewCron } from './cron-schedule.mjs';

const fields = (p, keys, required = keys) => requireValue(p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).every(k => keys.includes(k)) && required.every(k => Object.hasOwn(p, k)), 'invalid_headless_setup', 'Missing or unsupported headless setup fields');
const text = (s, max = 256) => requireValue(typeof s === 'string' && s.trim() && s.length <= max && !/[\x00-\x1f]/.test(s), 'invalid_headless_setup', 'Bounded text required');
export const setupTerminal = ['ready', 'blocked'];
export const headlessProbeId = setup => `probe_${setup.id}_${setup.attempt ?? 1}`;
export function headlessAuthority(store, actor, id) {
  const setup = store.get('headless_setup', id), grant = store.get('headless_grant', setup.grantId);
  if (actor.type === 'user') store.ownerOnly(actor); else store.nodeOnly(actor, setup.nodeId);
  requireValue(grant.state === 'active' && grant.revision === setup.grantRevision && (!grant.expiresAt || Date.now() < Date.parse(grant.expiresAt)),
    'headless_grant_inactive', 'Headless authorisation expired, changed or was revoked', 403);
  return { setup, grant };
}

export function applyHeadlessSetup(store, actor, action, p, { created, changed }) {
  if (action === 'headless.grant') {
    store.rootOwnerOnly(actor);
    fields(p, ['id', 'requesterAgentId', 'nodeId', 'name', 'directory', 'model', 'workiq', 'contract', 'schedule', 'expiresAt'], ['id', 'requesterAgentId', 'nodeId', 'name', 'directory', 'model', 'workiq', 'contract', 'schedule']);
    for (const key of ['id', 'name', 'requesterAgentId', 'nodeId']) text(p[key]);
    const requester = store.get('agent', p.requesterAgentId); store.get('node', p.nodeId);
    requireValue(requester.nodeId === p.nodeId && requester.mode === 'interactive' && requester.standingGrant, 'headless_requester_scope', 'An enrolled coordinator on the destination node is required');
    requireValue(canonicalDirectory(p.directory), 'invalid_headless_setup', 'Canonical workspace required');
    fields(p.model, ['providerID', 'id', 'integrationID', 'connectionId']); for (const v of Object.values(p.model)) text(v);
    fields(p.workiq, ['server', 'integrationID', 'connectionId', 'readTool', 'probeInput'], ['server', 'readTool', 'probeInput']);
    for (const key of ['server', 'readTool']) text(p.workiq[key]);
    requireValue(Boolean(p.workiq.integrationID) === Boolean(p.workiq.connectionId), 'invalid_headless_setup', 'WorkIQ credential references require both integration and connection ID');
    if (p.workiq.integrationID) { text(p.workiq.integrationID); text(p.workiq.connectionId); }
    requireValue(/^[A-Za-z0-9_]+$/.test(p.workiq.readTool) && p.workiq.probeInput && typeof p.workiq.probeInput === 'object' && !Array.isArray(p.workiq.probeInput) && JSON.stringify(p.workiq.probeInput).length <= 4000,
      'invalid_headless_setup', 'Explicit read-only WorkIQ tool and bounded probe input required');
    requireValue(typeof p.contract === 'string' && /^\.opencode\/skills\/[A-Za-z0-9_-]+\/SKILL\.md$/.test(p.contract), 'invalid_headless_setup', 'Workspace skill contract required');
    fields(p.schedule, ['id', 'cron', 'timezone', 'reviewPolicy']); text(p.schedule.id);
    requireValue(p.schedule.reviewPolicy === 'none', 'invalid_headless_setup', 'This headless setup flow supports explicit none review only');
    previewCron(p.schedule.cron, p.schedule.timezone);
    if (p.expiresAt) requireValue(Date.parse(p.expiresAt) > Date.now(), 'invalid_expiry', 'Future grant expiry required');
    return created('headless_grant', { ...p, state: 'active', userId: actor.id });
  }
  if (action === 'headless.revoke') {
    store.rootOwnerOnly(actor); fields(p, ['id', 'expectedRevision']);
    const grant = store.get('headless_grant', p.id); store.revision(grant, p.expectedRevision);
    for (const setup of store.all('headless_setup').filter(s => s.grantId === grant.id)) {
      const schedule = store.get('schedule', setup.scheduleId, false);
      if (schedule?.definition.enabled && !schedule.cancelled) {
        const paused = store.apply(actor, 'schedule.pause', { id: schedule.id, expectedRevision: schedule.revision }); store.event('schedule.pause', paused, actor, p.id);
      }
    }
    return changed('headless_grant', grant, { state: 'revoked' });
  }
  if (action === 'headless.request') {
    fields(p, ['grantId', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision', 'retry'], ['grantId', 'requesterAgentId', 'sourceConversationId', 'sourceBindingRevision']);
    requireValue(p.retry === undefined || typeof p.retry === 'boolean', 'invalid_headless_setup', 'Retry must be explicit boolean');
    const requester = store.agent(actor, p.requesterAgentId), grant = store.get('headless_grant', p.grantId);
    requireValue(requester.standingGrant && requester.mode === 'interactive' && requester.nodeId === grant.nodeId && requester.id === grant.requesterAgentId &&
      requester.conversationId === p.sourceConversationId && requester.bindingRevision === p.sourceBindingRevision,
    'headless_requester_scope', 'Exact current coordinator receiver required', 403);
    requireValue(grant.state === 'active' && (!grant.expiresAt || Date.now() < Date.parse(grant.expiresAt)), 'headless_grant_inactive', 'Active headless grant required', 403);
    const id = `setup_${digest([grant.nodeId, grant.name, grant.directory])}`, existing = store.get('headless_setup', id, false);
    if (existing) {
      requireValue(existing.grantId === grant.id && existing.grantRevision === grant.revision, 'headless_setup_conflict', 'Existing worker authorisation differs');
      if (p.retry && existing.state === 'blocked') {
        const probe = store.get('execution', headlessProbeId(existing), false);
        requireValue(!probe || ['completed', 'cancelled', 'failed', 'rejected'].includes(probe.state), 'headless_probe_unsettled', 'Settle the original readiness execution before retrying');
        return changed('headless_setup', existing, { state: 'requested', blocker: null, attempt: (existing.attempt ?? 1) + 1 });
      }
      return existing;
    }
    const agentId = `agent_hs_${digest([grant.nodeId, grant.name, grant.directory]).slice(0, 48)}`;
    requireValue(!store.all('agent').some(a => a.nodeId === grant.nodeId && a.name === grant.name && a.directory === grant.directory), 'headless_setup_conflict', 'A different agent already uses this workspace and name');
    requireValue(!store.get('schedule', grant.schedule.id, false), 'headless_setup_conflict', 'Schedule ID is already used');
    return created('headless_setup', { id, grantId: grant.id, grantRevision: grant.revision, requesterAgentId: requester.id, nodeId: grant.nodeId,
      agentId, sessionId: `ses_${digest(['headless-session', id]).slice(0, 32)}`, bindingId: `binding_${digest(['headless-binding', id])}`,
      name: grant.name, directory: grant.directory, scheduleId: grant.schedule.id, state: 'requested', attempt: 1 });
  }
  fields(p, ['id', 'receipt', 'reason'], ['id']);
  const setup = store.get('headless_setup', p.id); store.nodeOnly(actor, setup.nodeId);
  if (action === 'headless.block') {
    text(p.reason);
    const probe = store.get('execution', headlessProbeId(setup), false);
    if (probe && !['completed', 'cancelled', 'failed', 'rejected'].includes(probe.state)) {
      const cancelled = store.apply(actor, 'execution.cancel', { id: probe.id, expectedRevision: probe.revision, reason: p.reason });
      store.event('execution.cancel', cancelled, actor, setup.id);
    }
    return changed('headless_setup', setup, { state: 'blocked', blocker: p.reason });
  }
  const { grant } = headlessAuthority(store, actor, p.id);
  if (action === 'headless.register') {
    const existing = store.get('agent', setup.agentId, false);
    if (existing) { requireValue(existing.headlessSetupId === setup.id && existing.mode === 'headless', 'headless_setup_conflict', 'Do not adopt another agent'); return existing; }
    const agent = store.apply(actor, 'agent.register', { id: setup.agentId, nodeId: setup.nodeId, name: setup.name, mode: 'headless', directory: setup.directory });
    const saved = store.save('agent', { ...agent, headlessSetupId: setup.id }); store.event('agent.register', saved, actor, setup.id); return saved;
  }
  if (action === 'headless.probe') {
    const existing = store.get('execution', headlessProbeId(setup), false); if (existing) return existing;
    const agent = store.get('agent', setup.agentId);
    requireValue(agent.conversationId === setup.sessionId && agent.availability === 'available', 'headless_not_ready', 'Worker must be loaded and idle before readiness probing');
    const instructions = `Bounded readiness check only. Call relay_workiq_read once with arguments exactly ${JSON.stringify(grant.workiq.probeInput)}. This invokes the authorised ${grant.workiq.readTool} connection. This is a read, not a sweep. Do not modify external data. Then use relay_work_submit with candidate "headless-readiness" and a short pass/fail summary without private content. Finish the turn.`;
    const authority = { headlessSetup: setup };
    const task = store.apply(actor, 'task.create', { id: `probe_task_${setup.id}_${setup.attempt ?? 1}`, title: `Readiness: ${setup.name}`, description: instructions }, authority);
    store.event('task.create', task, actor, setup.id);
    const execution = store.apply(actor, 'execution.request', { id: headlessProbeId(setup), taskId: task.id, taskRevision: task.revision,
      targetAgentId: agent.id, originAgentId: setup.requesterAgentId, instructions, reviewPolicy: 'none' }, authority);
    store.event('execution.request', execution, actor, setup.id); return execution;
  }
  if (action === 'headless.activate') {
    if (setup.state === 'ready') return setup;
    fields(p.receipt, ['nativeTerminalId', 'workiqToolCallId', 'workiqInputDigest', 'accessDigest']);
    for (const key of ['nativeTerminalId', 'workiqToolCallId', 'workiqInputDigest', 'accessDigest']) text(p.receipt[key]);
    const execution = store.get('execution', headlessProbeId(setup));
    requireValue(execution.state === 'completed' && execution.result?.candidate === 'headless-readiness' && execution.targetAgentId === setup.agentId &&
      p.receipt.workiqInputDigest === digest(grant.workiq.probeInput), 'headless_readiness_required', 'Correlated model, WorkIQ and native submission evidence required');
    const schedule = store.apply(actor, 'schedule.install', { id: setup.scheduleId, definition: { nodeId: setup.nodeId, targetAgentId: setup.agentId,
      instructions: `Perform the authorised job contract at ${grant.directory}/${grant.contract}. Read that exact skill, follow its scope, and submit the native Relay result. Use relay_workiq_read with {arguments:{...}} for the authorised WorkIQ read tool. Do not use shell or generic execute as an authentication workaround.`,
      cron: grant.schedule.cron, timezone: grant.schedule.timezone, reviewPolicy: 'none', enabled: true } }, { headlessSetup: setup });
    store.event('schedule.install', schedule, actor, setup.id);
    return changed('headless_setup', setup, { state: 'ready', readiness: p.receipt, scheduleRevision: schedule.revision });
  }
  requireValue(false, 'invalid_action', 'Unknown headless setup action');
}
