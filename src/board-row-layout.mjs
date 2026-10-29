import { wrapBoardText, truncateBoardText, taskBoardColumns } from './task-board-view.mjs';

export function layoutBoardRows(rows, { columns, native, rowText, statusLabel }) {
  const width = Math.max(1, columns - (native ? 4 : 2));
  const table = taskBoardColumns(columns, rows.filter(row => row.type === 'task').map(row => statusLabel(row.task)));
  return rows.map(row => {
    let fields;
    if (row.type === 'machine') fields = [`${row.local ? 'LOCAL · ' : ''}${row.expanded ? '▾' : '▸'} ${row.name}${row.machineName && row.machineName !== row.name ? ` / ${row.machineName}` : ''} · ${row.count}${row.count !== row.total ? `/${row.total}` : ''} ${row.total === 1 ? 'agent' : 'agents'}`];
    else if (row.type === 'agent') fields = [`  ${row.last ? '└─' : '├─'} ${row.agent.displayName || row.agent.name} · ${row.agent.mode || 'Unknown mode'} · ${row.agent.availabilityLabel || 'Unknown or stale'}`];
    else if (row.type === 'inbox') fields = [`${row.item.kind === 'run_result' ? 'Run result' : row.item.kind === 'review' ? 'Review' : row.item.kind === 'question' ? 'Question' : row.item.kind === 'reminder' ? 'Reminder' : 'Publication'} · ${row.item.title}`,
      row.item.summary, `${row.item.from || 'Relay'} · ${row.item.stateLabel}${row.item.locationLabel ? ` · ${row.item.locationLabel}` : ''}`, ''];
    else if (row.type === 'routine' && native) fields = [`${row.routine.title}  [${row.routine.state}]`, `${row.routine.cron} · ${row.routine.timezone}`,
      `Next (clock preview) ${row.routine.nextRunAt || 'none'} · ${row.routine.target || 'Unresolved target'}`, ''];
    else if (row.type === 'task') {
      const text = rowText(row), reference = row.task.reference;
      // Prefer a complete reference over the separate status column when narrow.
      if (table.title >= 22 && (!reference || text.indexOf(reference) + reference.length + 3 <= table.title)) {
        return [{ left: truncateBoardText(text, table.title), right: truncateBoardText(statusLabel(row.task), table.status),
          leftWidth: table.title, rightWidth: table.status, gap: table.gap }];
      }
      return [{ text: truncateBoardText(`${text} ${statusLabel(row.task)}`, width), heading: true }];
    } else if (row.type === 'group' || row.type === 'section') {
      return [{ text: truncateBoardText(rowText(row), width), heading: true }];
    } else fields = [rowText(row)];
    return fields.flatMap((field, fieldIndex) => wrapBoardText(field, width).map(text => ({ text, heading: fieldIndex === 0 })));
  });
}

export function boardRowViewport(blocks, selected, height, offset = 0) {
  if (!blocks.length) return [];
  selected = Math.max(0, Math.min(blocks.length - 1, selected));
  const selectedOffset = blocks.slice(0, selected).reduce((n, block) => n + block.length, 0);
  const lines = blocks.flatMap((block, rowIndex) => block.map(line => ({ ...line, rowIndex })));
  const start = blocks[selected].length >= height ? selectedOffset + Math.min(offset, Math.max(0, blocks[selected].length - height))
    : Math.max(0, Math.min(selectedOffset - Math.floor((height - blocks[selected].length) / 2), lines.length - height));
  return lines.slice(start, start + height);
}
