import { wrapBoardText } from './task-board-view.mjs';

/** Associate every wrapped physical line with its logical occurrence. */
export function routineDetailLayout(routine, entries, columns) {
  const lines = [], ranges = [];
  const append = (text, metadata = {}) => {
    for (const line of wrapBoardText(text, columns)) lines.push({ text: line, ...metadata });
  };
  if (routine.title) append(`Schedule: ${routine.title}`);
  append(`${routine.state} / backend ${routine.backendStatus} / ${routine.intent === 'reminder' ? 'human reminder' : routine.executionMode}`);
  append(`${routine.cron} · ${routine.timezone}`);
  append(`Next${routine.nextRunIsEstimate ? ' (clock preview)' : ''} ${routine.nextRunAt || 'none'} · target ${routine.targetAgentId || routine.targetBindingId || routine.targetDirectory || 'unresolved'}`);
  if (routine.delivery) append(`Delivery ${routine.delivery.state}${routine.delivery.reason ? ` · ${routine.delivery.reason}` : ''}`);
  append('Run result notifications');
  append(`Inbox: ${routine.runResultNotifications?.inbox ? 'on' : 'off'} · Requester (online-only): ${routine.runResultNotifications?.requester ? 'on' : 'off'}`);
  append(''); append(`Recent occurrences (${entries.length}${entries.length === 50 ? '+' : ''})`, { heading: true });
  entries.forEach((entry, occurrenceIndex) => {
    const start = lines.length, run = entry.run;
    const metadata = { occurrenceIndex, task: entry.task, mismatch: entry.mismatch };
    append(`${run.triggeredAt || '-'}  ${run.status}  ${entry.task?.identifier || run.linkedIssueId || (run.nativeOccurrence ? 'taskless' : 'unlinked')}`, { ...metadata, heading: true });
    if (run.summary) append(run.summary, metadata);
    if (!run.nativeOccurrence) append(entry.task ? entry.task.status : entry.mismatch ? 'identity mismatch' : 'not on board', metadata);
    append('', metadata); ranges.push({ start, end: lines.length });
  });
  return { lines, ranges };
}
