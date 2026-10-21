import { randomUUID } from 'node:crypto';
import { requireValue } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';

export function nativeBoard(api) {
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
    identifier: task.identifier || task.source?.metadata?.identifier ||
      (task.id.length > 24 ? `${task.id.slice(0,12)}…${task.id.slice(-8)}` : task.id),
    assigneeUserId: task.responsibleUserId, assigneeAgentId: null });
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
      intent: d.intent ?? 'job', executionMode: d.targetFolder ? 'interactive_folder' : agents.find(a => a.id === d.targetAgentId)?.mode === 'interactive' ? 'interactive_exact' : 'headless',
      cron: d.cron ?? `at ${d.at}`, timezone: d.timezone ?? 'Africa/Johannesburg', nextRunAt: next ?? null, nextRunIsEstimate: true,
      target: d.targetFolder ?? d.targetAgentId ?? 'human', targetAgentId: d.targetAgentId, targetConversationId: d.targetConversationId,
      targetDirectory: d.targetFolder, ownerNodeId: d.nodeId,
      delivery: { state: pending ? 'change_pending' : state,
        reason: `Requested revision ${schedule.revision}, applied ${schedule.appliedRevision ?? 0}. Local node owns admission and clock.` } };
  };
  return {
    async read() {
      const [tasks, agents, nodes, schedules] = await Promise.all([all('tasks'), all('agents'), all('nodes'), all('schedules')]);
      return { companies: [{ id: 'native', name: 'Relay' }], projects: [], routines: schedules.map(s => routine(s, agents)), tasks: tasks.map(scoped),
        showEmptyLocalBoard: false,
        agents: agents.map(agent => {
          const node = nodes.find(node => node.id === agent.nodeId);
          const age = Date.now() - Date.parse(node?.lastSeenAt);
          return { ...agent, companyId: 'native', name: `${agent.name} @ ${node?.name ?? agent.nodeId}`,
            availability: age >= 0 && age < 15000 ? 'present' : 'unknown', nativeState: 'unknown', bridgeState: null };
        }), fetchedAt: new Date().toISOString(), warnings: ['Native task view. Assignment is separate from execution.',
          'Schedule next times are clock previews, not admission receipts. Occurrence history contains published receipts, not all local pending/running work.'] };
    },
    async detailRoutine({ scheduleId }) {
      const schedule = await api('GET', `/v1/schedules/${encodeURIComponent(scheduleId)}`);
      const [agents, occurrences, executions] = await Promise.all([all('agents'), all('occurrences'), all('executions')]);
      return { ...routine(schedule, agents), runs: occurrences.filter(o => o.scheduleId === scheduleId)
        .sort((a, b) => b.intendedAt.localeCompare(a.intendedAt)).slice(0, 50).map(o => {
          const execution = executions.find(e => e.id === o.id && e.localOccurrence && e.targetNodeId === o.nodeId);
          return { id: o.id, status: o.state, triggeredAt: o.intendedAt, summary: o.summary ?? o.reason ?? '', nativeOccurrence: true,
            linkedIssueId: execution?.taskId ?? null, nativeTaskId: execution?.taskId ?? null };
        }) };
    },
    async inspectTask({ taskId }) {
      const task = await api('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
      return { task: scoped(task), revision: task.revision, defaultHumanUserId: task.responsibleUserId };
    },
    async detailTask({ taskId }) {
      const task = await api('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
      const [comments, executions] = await Promise.all([all('comments'), all('executions')]);
      const execution = executions.filter(e => e.taskId === taskId && e.result).sort((a, b) => (b.result.sequence ?? 0) - (a.result.sequence ?? 0))[0];
      return { task: scoped(task), revision: task.revision, comments: comments.filter(c => c.taskId === taskId).map(c => ({ ...c,
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
