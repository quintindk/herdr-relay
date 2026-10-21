const ended = e => ['completed', 'failed', 'cancelled', 'rejected'].includes(e.state);
export const nativeAgentLabel = agent => agent?.name === 'Interactive Relay chat' && agent.directory
  ? `${agent.directory.split('/').filter(Boolean).at(-1)} (interactive)` : agent?.name ?? 'Unknown agent';
export function nativeAttention({ tasks, executions, questions, agents, nodes = [], occurrences, notifications, monitorResults, userId }) {
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const agentName = id => nativeAgentLabel(agents.find(a => a.id === id));
  const name = (taskId, scheduleId) => taskById.get(taskId)?.title ?? (scheduleId ? `Scheduled job: ${scheduleId}` : 'Task unavailable');
  const location = nodeId => {
    const node = nodes.find(n => n.id === nodeId);
    return { nodeId, nodeName: node?.name ?? 'Unknown node', machineName: node?.machine?.hostname ?? 'Not advertised',
      locationLabel: `Node: ${node?.name ?? 'Unknown'} · Machine: ${node?.machine?.hostname ?? 'not advertised'}` };
  };
  const inbox = [];
  for (const q of questions.filter(q => q.status === 'open' && q.addressedTo.type === 'user' && q.addressedTo.id === userId &&
    q.allowedResponders.some(r => r.type === 'user' && r.id === userId))) {
    const execution = executions.find(e => e.id === q.executionId);
    inbox.push({ id: `question:${q.id}`, kind: 'question', entityId: q.id, revision: q.revision, taskId: q.taskId,
      ...location(execution?.targetNodeId ?? agents.find(a => a.id === q.requestingAgentId)?.nodeId),
      title: name(q.taskId), summary: q.prompt, from: agentName(q.requestingAgentId), stateLabel: q.blocking ? 'Waiting for your answer' : 'Answer requested',
      context: q.routing?.at(-1)?.reason ?? '', action: 'question.answer',
      effect: execution?.cancellationRequested || execution && ended(execution)
        ? 'Answering will not restart cancelled or ended work.' : q.blocking ? 'Answer recorded. The worker can continue when eligible.'
          : 'Answer recorded. This does not start a second worker turn.' });
  }
  for (const e of executions.filter(e => ['in_review', 'monitor_review'].includes(e.state) &&
    (e.reviewPolicy === 'human' || e.reviewerMode === 'human_recovery'))) {
    const monitor = e.state === 'monitor_review';
    const result = monitor ? monitorResults.find(r => r.id === e.monitorResultId) : e.result;
    if (!result) continue;
    inbox.push({ id: `review:${e.id}`, kind: 'review', entityId: e.id, revision: e.revision, taskId: e.taskId,
      ...location(e.targetNodeId),
      title: name(e.taskId), from: agentName(e.targetAgentId), stateLabel: e.cancellationRequested ? 'Review blocked: cancellation requested' : 'Ready for your review',
      summary: result.summary, candidate: result.candidate, resultDigest: result.digest ?? null,
      action: monitor ? 'execution.monitor_review' : 'execution.review', disabled: Boolean(e.cancellationRequested),
      acceptEffect: monitor ? 'Accept this check. Monitoring can continue within its existing window.' : 'Accept this exact result and complete the task.',
      rejectEffect: monitor ? 'Reject this check and block further monitoring.' : 'Return the task to Todo. No revision turn is started automatically.' });
  }
  for (const o of occurrences.filter(o => o.state === 'in_review' && !o.executionId)) inbox.push({
    id: `occurrence:${o.id}`, kind: 'review', entityId: o.id, revision: o.revision, title: name(null, o.scheduleId),
    ...location(o.nodeId),
    from: o.targetAgentId ? agentName(o.targetAgentId) : 'Scheduled job', stateLabel: 'Ready for your review', summary: o.summary, candidate: o.candidate,
    action: 'occurrence.review', acceptEffect: 'Accept this scheduled result.', rejectEffect: 'Reject this result. Future scheduled runs are unchanged.' });
  for (const n of notifications.filter(n => n.state === 'pending' && n.userId === userId)) inbox.push({
    id: `reminder:${n.id}`, kind: 'reminder', entityId: n.id, revision: n.revision, title: 'Reminder', summary: n.message,
    ...location(n.nodeId),
    from: 'Relay', stateLabel: 'Needs acknowledgement', action: 'notification.acknowledge', effect: 'Acknowledge this reminder. No model turn is started.' });
  const attention = task => {
    const candidates = executions.filter(e => e.taskId === task.id).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') ||
      (b.result?.sequence ?? 0) - (a.result?.sequence ?? 0) || b.id.localeCompare(a.id));
    const e = candidates.find(e => !ended(e)) ?? candidates[0];
    const actions = inbox.filter(i => i.taskId === task.id);
    if (!e) return { actions, attentionLabel: actions[0]?.stateLabel ?? null };
    const q = questions.find(q => q.executionId === e.id && q.status === 'open' && q.blocking);
    const state = e.cancellationRequested && !ended(e) ? 'Cancellation requested: awaiting worker'
      : q ? q.addressedTo.type === 'user' ? 'Waiting for your answer' : 'Waiting for coordinator'
      : e.state === 'continuation_ready' ? 'Answer recorded: waiting for worker'
      : ['in_review', 'monitor_review'].includes(e.state) ? actions.length ? 'Ready for your review' : 'Waiting for reviewer'
      : e.state === 'accepted' ? `${e.progress ? 'Working' : 'Admitted'}: ${agentName(e.targetAgentId)}`
      : e.state === 'requested' ? `Waiting for admission: ${agentName(e.targetAgentId)}`
      : e.state === 'waiting_children' ? 'Waiting for child work'
      : e.state === 'waiting_time' ? 'Waiting for next check'
      : e.state === 'monitor_blocked' ? 'Monitoring blocked'
      : e.state === 'completed' ? `Completed: ${agentName(e.targetAgentId)}`
      : e.state === 'failed' ? 'Execution failed' : e.state === 'cancelled' ? 'Execution cancelled' : 'Changes requested';
    const where = location(e.targetNodeId);
    return { actions, attentionLabel: state, executionAgentId: e.targetAgentId, executionAgentName: agentName(e.targetAgentId), executionState: e.state,
      executionNodeId: e.targetNodeId, executionNodeName: where.nodeName, executionMachineName: where.machineName };
  };
  return { inbox, attention };
}
