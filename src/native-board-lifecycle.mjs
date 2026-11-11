import { canonical, requireValue } from './protocol.mjs';
import { canonicalDirectory, withinRoots } from './interactive-contract.mjs';
import { previewCron } from './cron-schedule.mjs';

const inScope = (identity, nodeId, directory, reminder = false) => !identity.scope || identity.scope.kind === 'node_operator' &&
  identity.scope.nodeId === nodeId && (reminder || identity.scope.mode === 'localUser' || canonicalDirectory(directory) && withinRoots(directory, identity.scope.roots ?? []));

export function nativeBoardLifecycle(api, { decisionJournal, all }) {
  const context = async feature => {
    const [info, identity] = await Promise.all([api('GET', '/v1/info'), api('GET', '/v1/identity')]);
    requireValue(info.features?.[feature], 'backend_upgrade_required', 'Upgrade the backend and TUI for these controls');
    requireValue(identity.type === 'user' && identity.id === info.userId && (!identity.scope || identity.scope.kind === 'node_operator'),
      'forbidden', 'Human operator context required', 403);
    return { info, identity };
  };
  const pending = (id, prefix) => requireValue(!decisionJournal?.pending().some(item => item.command.payload.id === id && item.command.action.startsWith(prefix)),
    'decision_pending', 'Reconcile the original confirmed operation in Inbox first');
  const board = {
    async prepareAgentDelete({ agentId }) {
      await context('agentDeletion'); pending(agentId, 'agent.');
      return api('GET', `/v1/agents/${encodeURIComponent(agentId)}/delete-preview`);
    },
    async deleteAgent({ agentId, expectedRevision, instanceId, key, reason }) {
      requireValue(decisionJournal && key && instanceId, 'decision_storage_required', 'Durable confirmed deletion required');
      requireValue(typeof reason === 'string' && reason.trim() && reason.length <= 2000, 'invalid_request', 'A bounded deletion reason is required');
      const command = { key, action: 'agent.delete', payload: { id: agentId, expectedRevision, reason } };
      const previous = decisionJournal.inspect(key);
      if (!previous) {
        const fresh = await board.prepareAgentDelete({ agentId });
        requireValue(fresh.instanceId === instanceId && fresh.expectedRevision === expectedRevision, 'stale_revision', 'Agent changed. Reopen its deletion preview', 409);
        requireValue(fresh.eligible, 'agent_in_use', 'Agent is online or referenced by outstanding work, schedules or permissions', 409);
      }
      const agent = await decisionJournal.submit(api, command, instanceId);
      return { state: 'recorded', agent, message: previous ? 'Original agent deletion reconciled. Refreshing the current directory.'
        : 'Inactive agent deleted from the directory. History retained; native processes were not terminated.' };
    },
    async prepareScheduleCreation() {
      const { info, identity } = await context('humanScheduleManagement');
      const [nodes, agents] = await Promise.all([all('nodes'), all('agents')]);
      return { instanceId: info.instanceId, nodes: nodes.filter(node => inScope(identity, node.id, null, true)),
        agents: agents.filter(agent => !agent.deletedAt && agent.mode === 'interactive' && agent.standingGrant?.scheduleManagement &&
          !agent.headlessSetupId && !agent.capabilities?.includes('observation_only') && inScope(identity, agent.nodeId, agent.directory)) };
    },
    async prepareScheduleCreate({ payload }) {
      const candidates = await board.prepareScheduleCreation();
      requireValue(payload && Object.keys(payload).every(key => ['id', 'definition'].includes(key)) && typeof payload.id === 'string' &&
        payload.id.length > 0 && payload.id.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(payload.id),
      'invalid_schedule', 'Schedule name/ID must be 1–256 characters without spaces or control characters');
      const definition = payload.definition;
      requireValue(definition && Object.keys(definition).every(key => ['nodeId', 'targetAgentId', 'intent', 'instructions', 'cron', 'timezone', 'enabled', 'reviewPolicy'].includes(key)) &&
        candidates.nodes.some(node => node.id === definition.nodeId) && ['job', 'reminder'].includes(definition.intent) &&
        typeof definition.enabled === 'boolean' && ['none', 'human'].includes(definition.reviewPolicy), 'invalid_schedule', 'Choose a permitted node, schedule kind, activation and review policy');
      requireValue(typeof definition.instructions === 'string' && definition.instructions.trim() && definition.instructions.length <= 16000,
        'invalid_schedule', 'Instructions or reminder text must contain 1–16000 characters');
      requireValue(typeof definition.timezone === 'string' && definition.timezone.length <= 128, 'invalid_timezone', 'Explicit IANA timezone required');
      if (definition.intent === 'job') requireValue(candidates.agents.some(agent => agent.id === definition.targetAgentId && agent.nodeId === definition.nodeId),
        'target_not_enrolled', 'Select an existing interactive agent inside this operator scope. Independent headless workers use their separate setup flow');
      else requireValue(!definition.targetAgentId && definition.reviewPolicy === 'none', 'invalid_schedule', 'Human reminders have no agent or result review');
      const preview = previewCron(definition.cron, definition.timezone);
      const clean = { id: payload.id, definition: { ...definition, instructions: definition.instructions.trim(), cron: preview.cron } };
      pending(payload.id, 'schedule.');
      let existing;
      try { existing = await api('GET', `/v1/schedules/${encodeURIComponent(payload.id)}`); }
      catch (error) { if (error.status !== 404) throw error; }
      requireValue(!existing, 'schedule_exists', 'This schedule ID is already used, including cancelled schedules. Choose a new ID', 409);
      const target = candidates.agents.find(agent => agent.id === definition.targetAgentId), node = candidates.nodes.find(node => node.id === definition.nodeId);
      return { ...clean, instanceId: candidates.instanceId, nextRuns: preview.nextRuns, warnings: preview.warnings,
        ...(target ? { target: { id: target.id, name: target.name, nodeId: target.nodeId, directory: target.directory } } : {}),
        node: { id: node.id, name: node.name } };
    },
    async createSchedule({ id, definition, instanceId, key }) {
      requireValue(decisionJournal && key && instanceId, 'decision_storage_required', 'Durable confirmed schedule required');
      const command = { key, action: 'schedule.install', payload: { id, expectedRevision: 0, definition } };
      const previous = decisionJournal.inspect(key);
      if (!previous) {
        const fresh = await board.prepareScheduleCreate({ payload: { id, definition } });
        requireValue(fresh.instanceId === instanceId && canonical(fresh.definition) === canonical(definition),
          'stale_schedule_preview', 'Schedule preview changed. Inspect it again');
      }
      const schedule = await decisionJournal.submit(api, command, instanceId);
      return { state: 'recorded', schedule, message: previous ? 'Original schedule creation reconciled. Refreshing the current schedule state.'
        : definition.enabled ? 'Schedule created. Activation waits for its owning node acknowledgement.' : 'Paused schedule created. No work starts until it is resumed and acknowledged.' };
    },
    async prepareScheduleChange({ scheduleId, operation = 'delete' }) {
      const { info, identity } = await context('humanScheduleManagement'); pending(scheduleId, 'schedule.');
      requireValue(['delete', 'pause', 'resume'].includes(operation), 'invalid_schedule', 'Unknown schedule control');
      const schedule = await api('GET', `/v1/schedules/${encodeURIComponent(scheduleId)}`), d = schedule.definition;
      const agent = d.targetAgentId ? await api('GET', `/v1/agents/${encodeURIComponent(d.targetAgentId)}`) : null;
      requireValue(inScope(identity, d.nodeId, d.targetFolder ?? agent?.directory, d.intent === 'reminder'), 'operator_scope_mismatch', 'Use the operator on this schedule\'s owning node', 403);
      requireValue(!schedule.cancelled && (!schedule.transfer || schedule.transfer.state === 'completed'),
        'schedule_unavailable', 'Cancelled or transferring schedules cannot use this control');
      return { scheduleId, expectedRevision: schedule.revision, instanceId: info.instanceId, operation,
        eligible: true, definition: d, name: schedule.id, nodeId: d.nodeId, blockers: [] };
    },
    async changeSchedule({ scheduleId, expectedRevision, instanceId, operation = 'delete', key, reason }) {
      requireValue(decisionJournal && key && instanceId && ['delete', 'pause', 'resume'].includes(operation), 'decision_storage_required', 'Exact confirmed schedule control required');
      if (operation === 'delete') requireValue(typeof reason === 'string' && reason.trim() && reason.length <= 2000, 'invalid_request', 'A bounded deletion reason is required');
      const command = { key, action: `schedule.${operation === 'delete' ? 'cancel' : operation}`, payload: { id: scheduleId, expectedRevision,
        ...(operation === 'delete' ? { reason } : {}) } };
      const previous = decisionJournal.inspect(key);
      if (!previous) {
        const fresh = await board.prepareScheduleChange({ scheduleId, operation });
        requireValue(fresh.instanceId === instanceId && fresh.expectedRevision === expectedRevision, 'stale_revision', 'Schedule changed. Reopen its control preview', 409);
      }
      const schedule = await decisionJournal.submit(api, command, instanceId);
      return { state: 'recorded', schedule, message: previous ? 'Original schedule control reconciled. Refreshing its current state.'
        : operation === 'delete' ? 'Schedule deleted. Future ticks stop after node acknowledgement. Run history is retained; admitted work is not interrupted.'
        : `${operation === 'pause' ? 'Pause' : 'Resume'} saved. The owning node must acknowledge the change.` };
    },
  };
  return board;
}
