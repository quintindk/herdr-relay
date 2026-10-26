import { randomUUID } from 'node:crypto';
import { digest, requireValue } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';
import { nativeAgentLabel, nativeAttention } from './native-board-attention.mjs';
import { buildGrantsView } from './grants-view.mjs';

export function boardLocalIdentity(context) {
  return context?.scope?.kind === 'node_operator' && context.nodeId === context.scope.nodeId && context.instanceId
    ? { localNodeId: context.nodeId, localInstanceId: context.instanceId } : {};
}

export function nativeBoard(api, { decisionJournal, localNodeId, localInstanceId } = {}) {
  const terminalId = `terminal:${randomUUID()}`;
  let approvalSession, approvalApi;
  const grantApi = async (method, path, body) => {
    if (!approvalSession || Date.parse(approvalSession.credential.scope.expiresAt) < Date.now() + 30000) {
      requireValue(api.withToken, 'human_grant_transport_required', 'Human Grants transport is unavailable');
      approvalSession = await api('POST', '/v1/grants/ui-session', { terminalId });
      approvalApi = api.withToken(approvalSession.token);
    }
    try { return await approvalApi(method, path, body); }
    catch (error) { if (error.status === 401) approvalSession = null; throw error; }
  };
  const all = async collection => {
    const items = [];
    const cursors = new Set(), ids = new Set();
    let cursor;
    do {
      const page = await api('GET', `/v1/${collection}?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
      requireValue(page && Array.isArray(page.items), 'invalid_backend_response', 'Native board requires a complete collection page');
      for (const item of page.items) {
        requireValue(item && typeof item.id === 'string' && !ids.has(item.id), 'invalid_backend_response', 'Native board collection contains duplicate or invalid identities');
        ids.add(item.id);
      }
      items.push(...page.items); cursor = page.nextCursor;
      requireValue(items.length <= 100000 && (!cursor || typeof cursor === 'string' && !cursors.has(cursor)),
        'incomplete_collection', 'Native board collection is too large or has a repeated cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return items;
  };
  const scoped = task => ({ ...task, companyId: 'native',
    identifier: task.reference || task.identifier || task.source?.metadata?.identifier ||
      (task.id.length > 24 ? `${task.id.slice(0,12)}…${task.id.slice(-8)}` : task.id),
    assigneeUserId: task.responsibleUserId, assigneeAgentId: null });
  const publicationItems = (security = false) => (decisionJournal?.pending() ?? []).filter(p => p.command.action.startsWith('grant.') === security).map(p => ({
    id: `publication:${p.key}`, kind: 'publication', entityId: p.command.payload.id, key: p.key, section: 'pending',
    title: p.state === 'conflict' ? 'Decision refused: inspect before trying again' : 'Confirmed decision awaiting acknowledgement',
    summary: `${p.command.action}: ${p.command.payload.body ?? p.command.payload.reason ?? 'acknowledgement'}`,
    context: p.state === 'conflict' ? `Refused (${p.error}). Dismiss this refused operation, then reopen the current item for a fresh decision.`
      : 'Outcome is unconfirmed. Retry reuses your original confirmation and operation key.',
    from: 'This terminal', stateLabel: p.state === 'conflict' ? 'Needs inspection' : 'Publication unconfirmed',
    action: p.state === 'conflict' ? 'dismiss' : 'retry', error: p.error, command: p.command, instanceId: p.instance,
  }));
  const load = async () => {
    const collections = ['tasks', 'agents', 'nodes', 'schedules', 'questions', 'executions', 'occurrences', 'notifications', 'monitor_results'];
    const [info, ...values] = await Promise.all([api('GET', '/v1/info'), ...collections.map(all)]);
    requireValue(info.userId && info.instanceId, 'invalid_backend_response', 'Native board requires backend and human identity');
    const data = Object.fromEntries(collections.map((name, i) => [name, values[i]]));
    let grants = { pending: [], active: [], history: [] }, nodePolicies = {};
    if (info.features?.grantsManagement) {
      const names = ['provision_grants', 'headless_grants', 'task_reference_grants', 'review_grants', 'grant_requests', 'grant_decisions', 'provision_requests'];
      const records = Object.fromEntries(await Promise.all(names.map(async name => [name, await all(name)])));
      grants = buildGrantsView({ requests: records.grant_requests, decisions: records.grant_decisions,
        grants: { interactive: records.provision_grants, headless: records.headless_grants, reference: records.task_reference_grants, review: records.review_grants },
        agents: data.agents, nodes: data.nodes, preparations: records.provision_requests, userId: info.userId });
      const publications = publicationItems(true), locked = new Set(publications.map(p => p.entityId));
      grants.pending = [...publications, ...grants.pending.filter(item => !locked.has(item.entityId))];
      nodePolicies = Object.fromEntries(await Promise.all(data.nodes.map(async node => {
        try { return [node.id, await api('GET', `/v1/nodes/${encodeURIComponent(node.id)}/provisioning-policy`)]; }
        catch { return [node.id, null]; }
      })));
    }
    const { inbox, attention } = nativeAttention({ ...data, monitorResults: data.monitor_results, userId: info.userId });
    return { ...data, info, attention, grants, nodePolicies, inbox: [...publicationItems(), ...inbox].map(item => ({ ...item, instanceId: item.instanceId ?? info.instanceId })) };
  };
  const localNode = (nodes, info) => localNodeId && localInstanceId === info.instanceId ? nodes.find(n => n.id === localNodeId) : null;
  const presentAgent = (agent, nodes, info) => {
    const node = nodes.find(node => node.id === agent.nodeId);
    const nodeAge = Date.now() - Date.parse(node?.lastSeenAt), agentAge = Date.now() - Date.parse(agent.lastSeenAt);
    const fresh = nodeAge >= 0 && nodeAge < 15000 && agentAge >= 0 && agentAge < 15000;
    const reported = agent.availability ?? 'unknown';
    const local = localNode(nodes, info);
    return { ...agent, companyId: 'native', displayName: nativeAgentLabel(agent),
      locality: local ? agent.nodeId === local.id ? 'local' : 'remote' : 'unknown',
      name: `${nativeAgentLabel(agent)} @ ${node?.name ?? 'Unknown node'} / ${node?.machine?.hostname ?? 'machine not advertised'}`,
      nodeName: node?.name ?? 'Unknown node', nodeLastSeenAt: node?.lastSeenAt ?? null,
      machineName: node?.machine?.hostname ?? 'Not advertised', machinePlatform: node?.machine?.platform ?? null,
      reportedAvailability: reported, availabilityLabel: fresh && reported === 'busy' ? 'Busy (reported)' : fresh && reported === 'available'
        ? 'Available (reported)' : 'Unknown or stale', availability: fresh ? 'present' : 'unknown', nativeState: 'unknown', bridgeState: null };
  };
  const routine = (schedule, agents = []) => {
    const d = schedule.definition;
    const pending = schedule.appliedRevision !== schedule.revision;
    const expired = d.expiresAt && Date.parse(d.expiresAt) <= Date.now();
    const state = pending ? 'change_pending' : schedule.cancelled ? 'cancelled' : schedule.transfer?.state === 'requested' || schedule.transfer?.state === 'fenced' ? 'transferring'
      : !d.enabled ? 'paused' : expired ? 'expired' : 'active';
    const preview = state === 'active' ? d.cron ? previewCron(d.cron, d.timezone).nextRuns[0] : Date.parse(d.at) > Date.now() ? d.at : null : null;
    const next = preview && (!d.expiresAt || Date.parse(preview) < Date.parse(d.expiresAt)) ? preview : null;
    return { id: schedule.id, scheduleId: schedule.id, routineId: schedule.id, companyId: 'native', title: schedule.id,
      state, backendStatus: pending ? 'change pending' : 'applied', revision: schedule.revision, appliedRevision: schedule.appliedRevision,
      intent: d.intent ?? 'job', executionMode: d.targetFolder ? 'interactive_folder' : d.targetConversationId ? 'interactive_exact' :
        agents.find(a => a.id === d.targetAgentId)?.standingGrant ? 'interactive_agent' : agents.find(a => a.id === d.targetAgentId)?.mode === 'interactive' ? 'interactive_exact' : 'headless',
      cron: d.cron ?? `at ${d.at}`, timezone: d.timezone ?? 'Africa/Johannesburg', nextRunAt: next ?? null, nextRunIsEstimate: true,
      target: d.targetFolder ?? d.targetAgentId ?? 'human', targetAgentId: d.targetAgentId, targetConversationId: d.targetConversationId,
      targetDirectory: d.targetFolder, ownerNodeId: d.nodeId,
      delivery: { state: pending ? 'change_pending' : state,
        reason: `Requested revision ${schedule.revision}, applied ${schedule.appliedRevision ?? 0}. Local node owns admission and clock.` } };
  };
  return {
    async read() {
      const { tasks, agents, nodes, schedules, inbox, attention, info, grants, nodePolicies } = await load();
      return { companies: [{ id: 'native', name: 'Relay' }], projects: [], nodes, routines: schedules.map(s => routine(s, agents)),
        inbox, grants, grantsAvailable: !!info.features?.grantsManagement, nodePolicies,
        tasks: tasks.map(t => ({ ...scoped(t), instanceId: info.instanceId, ...attention(t), responsibleName: t.responsibleUserId === info.userId ? 'You' : t.responsibleUserId })),
        showEmptyLocalBoard: false,
        localNode: localNode(nodes, info) ? { id: localNodeId, name: localNode(nodes, info).name ?? localNodeId } : null,
        agents: agents.map(agent => presentAgent(agent, nodes, info)), fetchedAt: new Date().toISOString(), warnings: ['Native task view. Assignment is separate from execution.',
          'Schedule next times are clock previews, not admission receipts. Occurrence history contains published receipts, not all local pending/running work.'] };
    },
    async detailAgent({ agentId }) {
      const { agents, nodes, tasks, executions, schedules, attention, info } = await load();
      const agent = agents.find(a => a.id === agentId);
      requireValue(agent, 'agent_missing', 'Agent no longer appears in the directory');
      const taskIds = new Set(executions.filter(e => e.targetAgentId === agentId && !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state)).map(e => e.taskId));
      return { agent: presentAgent(agent, nodes, info), tasks: tasks.filter(t => taskIds.has(t.id)).map(t => ({ title: t.title, attentionLabel: attention(t).attentionLabel })),
        persistentSchedules: schedules.filter(s => s.definition.targetAgentId === agent.id && !s.definition.targetConversationId).length,
        historicalAttempts: executions.filter(e => e.targetAgentId === agent.id && e.bindingId && e.bindingId !== agent.bindingId &&
          !['completed', 'cancelled', 'failed', 'rejected'].includes(e.state)).map(e => ({ id: e.id, state: e.state, conversationId: e.targetConversationId })) };
    },
    pendingDecisions: publicationItems,
    async dispatchTask({ taskId, expectedRevision, instanceId, key, payload }) {
      requireValue(decisionJournal && key && payload?.targetAgentId && typeof payload.instructions === 'string' &&
        payload.instructions.trim() && payload.instructions.length <= 4000, 'invalid_handover', 'Select an agent and provide a bounded handover');
      const previous = decisionJournal.inspect(key);
      if (previous) {
        const command = previous.command;
        const marker = '\nHuman handover:\n';
        requireValue(command.action === 'execution.request' && command.payload.taskId === taskId && command.payload.taskRevision === expectedRevision &&
          command.payload.targetAgentId === payload.targetAgentId && command.payload.instructions.includes(marker) &&
          command.payload.instructions.slice(command.payload.instructions.indexOf(marker) + marker.length) === payload.instructions.trim(),
        'decision_conflict', 'Confirmed handover payload changed');
        const execution = await decisionJournal.submit(api, command, previous.instance);
        return { state: 'recorded', execution, message: 'Original execution request reconciled. No additional work was sent.' };
      }
      requireValue(!(decisionJournal.pending().some(item => item.command.action === 'execution.request' && item.command.payload.taskId === taskId)),
        'decision_pending', 'This task has an unconfirmed execution request. Reconcile its original key from Inbox');
      const task = await api('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
      requireValue(task.revision === expectedRevision, 'stale_revision', 'Task changed. Refresh and inspect the handover again', 409);
      const info = await api('GET', '/v1/info');
      requireValue(!instanceId || info.instanceId === instanceId, 'backend_identity_changed', 'Backend identity changed since the task preview. No work was requested');
      const command = { key, action: 'execution.request', payload: { id: `execution_${digest([taskId, key])}`, taskId, taskRevision: expectedRevision,
        targetAgentId: payload.targetAgentId, reviewPolicy: 'none', instructions:
          `Read task ${task.reference ?? task.id} (${task.id}), its description and comments before acting.\nHuman handover:\n${payload.instructions.trim()}` } };
      const execution = await decisionJournal.submit(api, command, info.instanceId);
      return { state: 'recorded', execution, message: 'Execution requested. Delivery waits for the designated receiver and available capacity.' };
    },
    pendingGrantDecisions: () => publicationItems(true),
    async detailGrant({ id }) {
      const data = await load();
      const item = [...data.grants.pending, ...data.grants.active, ...data.grants.history].find(item => item.id === id);
      requireValue(item, 'grant_unavailable', 'Security item changed. Refresh Grants');
      return { ...item, instanceId: data.info.instanceId };
    },
    async decideGrant({ item, key, decision, reason, scope }) {
      requireValue(decisionJournal && item && key, 'decision_storage_required', 'Durable Grants decision storage required');
      if (item.kind === 'publication') {
        if (item.action === 'dismiss') decisionJournal.dismiss(item.key); else await decisionJournal.retry(grantApi, item.key);
        return { state: 'recorded', message: item.action === 'dismiss' ? 'Refused security decision dismissed.' : 'Original security decision reconciled.' };
      }
      const pending = item.section === 'pending';
      const command = pending ? { key, action: 'grant.request_decide', payload: { id: item.entityId, expectedRevision: item.revision,
        requestHash: item.requestHash, decision, reason: reason ?? '', ...(decision === 'allow_scope' ? { scope: scope ?? item.scope } : {}) } } :
        { key, action: 'grant.revoke', payload: { id: item.entityId, kind: item.kind, expectedRevision: item.revision, reason: reason ?? '' } };
      await decisionJournal.submit(grantApi, command, item.instanceId);
      return { state: 'recorded', message: pending ? decision === 'reject' ? 'Permission rejected. No operation started.' : 'Permission recorded. The saved preparation resumes automatically.' : 'Permission revoked. Existing processes were not terminated.' };
    },
    async createGrant({ key, payload }) {
      requireValue(decisionJournal, 'decision_storage_required', 'Durable Grants decision storage required');
      const info = await api('GET', '/v1/info');
      await decisionJournal.submit(grantApi, { key, action: 'grant.create', payload }, info.instanceId);
      return { state: 'recorded', message: 'Standing permission created. Matching waiting requests resume automatically.' };
    },
    async detailInbox({ id }) {
      const local = publicationItems().find(item => item.id === id);
      if (local) return local;
      const data = await load();
      const item = data.inbox.find(item => item.id === id);
      requireValue(item, 'decision_unavailable', 'This item changed or was resolved. Refresh Inbox');
      return item;
    },
    async decideInbox({ item, body, decision, reason, key }) {
      requireValue(decisionJournal, 'decision_storage_required', 'Durable human decision storage is required');
      requireValue(item && typeof key === 'string' && key, 'invalid_request', 'Exact preview and stable operation key required');
      if (item.kind === 'publication') {
        if (item.action === 'dismiss') { decisionJournal.dismiss(item.key); return { state: 'recorded', message: 'Refused operation dismissed. Reopen the current item before deciding again.' }; }
        await decisionJournal.retry(api, item.key);
        return { state: 'recorded', message: 'Original confirmed decision published.' };
      }
      requireValue(!item.disabled && ['question.answer', 'execution.review', 'execution.monitor_review', 'occurrence.review', 'notification.acknowledge'].includes(item.action),
        'decision_unavailable', 'This item does not permit a human decision');
      const payload = { id: item.entityId, expectedRevision: item.revision };
      if (item.kind === 'question') {
        requireValue(typeof body === 'string' && body.trim() && body.trim().length <= 4000, 'invalid_answer', 'Answer must contain 1..4000 characters');
        payload.body = body.trim();
      } else if (item.kind === 'review') {
        requireValue(['accept', 'reject'].includes(decision) && typeof reason === 'string' && reason.trim() && reason.trim().length <= 4000,
          'invalid_review', 'Exact decision and review reason required');
        Object.assign(payload, { candidate: item.candidate, decision, reason: reason.trim() });
      }
      if (item.action !== 'execution.monitor_review' && item.kind !== 'reminder') payload.source = {
        conversationId: terminalId, messageId: `dialog:${key}`, digest: digest(payload),
      };
      await decisionJournal.submit(api, { key, action: item.action, payload }, item.instanceId);
      const message = item.kind === 'review' ? item.action === 'execution.monitor_review'
        ? decision === 'accept' ? 'Check accepted. Monitoring can continue within its existing window.' : 'Check rejected. Monitoring is blocked.'
        : item.action === 'occurrence.review' ? decision === 'accept' ? 'Scheduled result accepted.' : 'Scheduled result rejected. Future scheduled runs are unchanged.'
          : decision === 'accept' ? 'Result accepted. Task completed.' : 'Changes requested. Task returned to Todo; no new turn started.'
        : item.kind === 'reminder' ? 'Reminder acknowledged. No model turn started.' : item.effect;
      return { state: 'recorded', message };
    },
    async detailRoutine({ scheduleId }) {
      const schedule = await api('GET', `/v1/schedules/${encodeURIComponent(scheduleId)}`);
      const [agents, occurrences, executions] = await Promise.all([all('agents'), all('occurrences'), all('executions')]);
      return { ...routine(schedule, agents), runs: occurrences.filter(o => o.scheduleId === scheduleId)
        .sort((a, b) => b.intendedAt.localeCompare(a.intendedAt)).slice(0, 50).map(o => {
          const execution = executions.find(e => e.id === o.id && e.localOccurrence && e.targetNodeId === o.nodeId);
          return { id: o.id, status: o.state, triggeredAt: o.intendedAt,
            summary: o.summary ?? (o.failure ? `${o.failure.message} (${o.failure.stage}/${o.failure.code})` : o.reason ?? ''), failure: o.failure ?? null, nativeOccurrence: true,
            linkedIssueId: execution?.taskId ?? null, nativeTaskId: execution?.taskId ?? null };
        }) };
    },
    async inspectTask({ taskId }) {
      const task = await api('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
      const { executions, questions } = await load();
      return { task: scoped(task), revision: task.revision, defaultHumanUserId: task.responsibleUserId,
        interactions: [...executions.filter(e => e.taskId === taskId && !['completed', 'failed', 'cancelled', 'rejected'].includes(e.state)),
          ...questions.filter(q => q.taskId === taskId && q.status === 'open' && q.blocking)].map(item => ({ id: item.id, status: 'pending' })) };
    },
    async detailTask({ taskId }) {
      const [{ tasks, executions, questions, attention, inbox, info }, comments] = await Promise.all([load(), all('comments')]);
      const task = tasks.find(t => t.id === taskId);
      requireValue(task, 'task_missing', 'Task not found');
      const execution = executions.filter(e => e.taskId === taskId && e.result).sort((a, b) => (b.result.sequence ?? 0) - (a.result.sequence ?? 0))[0];
      return { task: { ...scoped(task), ...attention(task), responsibleName: task.responsibleUserId === info.userId ? 'You' : task.responsibleUserId }, actions: inbox.filter(i => i.taskId === taskId),
        activity: [...questions.filter(q => q.taskId === taskId).map(q => `${q.status === 'answered' ? 'Answered' : 'Question'}: ${q.prompt}${q.answer ? ` — ${q.answer.body}` : ''}`),
          ...executions.filter(e => e.taskId === taskId && e.review).map(e => `Review ${e.review.decision}: ${e.review.reason}`)],
        revision: task.revision, comments: comments.filter(c => c.taskId === taskId).map(c => ({ ...c,
        authorUserId: c.author.type === 'user' ? c.author.id : null, authorAgentId: null })),
      result: execution?.result, review: execution?.state === 'in_review' ? { candidate: execution.result.candidate,
        interactionId: execution.id, executionRevision: execution.revision } : null };
    },
    async statusTask(input) {
      const result = await api('POST', '/v1/commands', { key: input.key ?? randomUUID(), action: 'task.update',
        payload: { id: input.taskId, expectedRevision: input.expectedRevision, changes: { status: input.payload.status },
          ...(input.payload.comment ? { comment: input.payload.comment } : {}) } });
      return { state: 'recorded', task: scoped(result), revision: result.revision, outcome: { confirmed: result.status === input.payload.status } };
    },
    async reviewTask(input) {
      const task = await api('GET', `/v1/tasks/${encodeURIComponent(input.taskId)}`);
      requireValue(task.revision === input.expectedRevision, 'stale_revision', 'Task changed since review preview');
      const execution = await api('GET', `/v1/executions/${encodeURIComponent(input.interactionId)}`);
      requireValue(execution.taskId === input.taskId && execution.result.candidate === input.candidate, 'stale_candidate', 'Candidate changed');
      const result = await api('POST', '/v1/commands', { key: input.key, action: 'execution.review', payload: {
        id: execution.id, expectedRevision: execution.revision, candidate: input.candidate, decision: input.action,
        reason: input.reason?.trim() || 'Accepted from native task board',
      } });
      return { state: 'recorded', decision: input.action, receipt: { status: input.action === 'accept' ? 'accepted' : 'rejected' },
        outcome: { confirmed: result.state === (input.action === 'accept' ? 'completed' : 'rejected') } };
    },
  };
}
