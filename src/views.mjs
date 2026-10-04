export function overview(bindings, runs) {
  const rows = runs.map(run => ({ run: run.id, agent: run.request.bindingId, task: run.request.taskId,
    delivery: run.deliveryState, native: run.native?.state ?? run.nativeState,
    outcome: run.settlement?.outcome ?? 'unsettled', publication: run.publication.state,
    question: run.waiting?.state ?? '-', review: run.review?.status ?? '-' }));
  return { agents: bindings.map(binding => ({ id: binding.id, harness: binding.config.harness,
    conversation: binding.config.conversationId, delivery: binding.config.delivery })), work: rows };
}

export function renderOverview(value) {
  const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  const rows = value.work.map(row => Object.values(row).map(safe));
  const headers = ['Run', 'Agent', 'Task', 'Delivery', 'Native', 'Outcome', 'Publication', 'Question', 'Review'];
  return ['Herdr Relay', '', `${value.agents.length} registered agents, ${rows.length} work invocations`, '',
    headers.join(' | '), ...rows.map(row => row.join(' | ')), ''].join('\n');
}
