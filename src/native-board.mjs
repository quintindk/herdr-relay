import { randomUUID } from 'node:crypto';
import { requireValue } from './protocol.mjs';

export function nativeBoard(api) {
  const all = async collection => {
    const items = [];
    let cursor;
    do {
      const page = await api('GET', `/v1/${collection}?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
      items.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  const scoped = task => ({ ...task, companyId: 'native',
    identifier: task.identifier || task.source?.metadata?.identifier ||
      (task.id.length > 24 ? `${task.id.slice(0,12)}…${task.id.slice(-8)}` : task.id),
    assigneeUserId: task.responsibleUserId, assigneeAgentId: null });
  return {
    async read() {
      const [tasks, agents, nodes] = await Promise.all([all('tasks'), all('agents'), all('nodes')]);
      return { companies: [{ id: 'native', name: 'Relay' }], projects: [], routines: [], tasks: tasks.map(scoped),
        agents: agents.map(agent => {
          const node = nodes.find(node => node.id === agent.nodeId);
          const age = Date.now() - Date.parse(node?.lastSeenAt);
          return { ...agent, companyId: 'native', name: `${agent.name} @ ${node?.name ?? agent.nodeId}`,
            availability: age >= 0 && age < 15000 ? 'present' : 'unknown', nativeState: 'unknown', bridgeState: null };
        }), fetchedAt: new Date().toISOString(), warnings: ['Native task view. Assignment is separate from execution.'] };
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
