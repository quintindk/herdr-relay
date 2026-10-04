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

export async function watchOverview(read, { input = process.stdin, output = process.stdout, interval = 1000 } = {}) {
  let stopped = false;
  let selected = 0;
  let detailed = false;
  const tty = input.isTTY && output.isTTY;
  const key = chunk => {
    const value = String(chunk);
    if (value === 'q' || value === '\x03') stopped = true;
    if (value === 'j' || value === '\x1b[B') selected++;
    if (value === 'k' || value === '\x1b[A') selected = Math.max(0, selected - 1);
    if (value === '\r' || value === '\n') detailed = !detailed;
  };
  const stop = () => { stopped = true; };
  if (tty) {
    input.setRawMode(true);
    input.resume();
    input.on('data', key);
    output.write('\x1b[?1049h\x1b[?25l');
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    do {
      let text;
      try {
        const value = await read();
        selected = Math.min(selected, Math.max(0, value.work.length - 1));
        text = renderOverview(value);
        if (detailed && value.work[selected]) text += `\nSelected work\n${JSON.stringify(value.work[selected], null, 2)}\n`;
        text += `\nSelected row ${selected + 1}. j/k: select, Enter: details, q: close\n`;
      } catch (error) { text = `Herdr Relay unavailable (${error.code ?? 'connection_error'}). Retrying. q: close\n`; }
      if (tty) output.write('\x1b[H\x1b[2J');
      output.write(text);
      if (!tty) break;
      await new Promise(resolve => setTimeout(resolve, interval));
    } while (!stopped);
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (tty) {
      input.off('data', key);
      input.setRawMode(false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
    }
  }
}
