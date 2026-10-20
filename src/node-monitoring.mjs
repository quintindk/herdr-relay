import { digest, canonical, requireValue } from './protocol.mjs';

// Bounded standing-task checks retain one task/execution chain. They do not
// create an issue per tick and do not alias cron/new-occurrence semantics.
export function installMonitor(journal, input) {
  requireValue(input && Object.keys(input).every(key => ['id', 'executionId', 'startsAt', 'endsAt', 'intervalSec'].includes(key)) &&
    typeof input.id === 'string' && input.id && typeof input.executionId === 'string' && input.executionId &&
    Number.isFinite(Date.parse(input.startsAt)) && Date.parse(input.endsAt) > Date.parse(input.startsAt) &&
    Number.isSafeInteger(input.intervalSec) && input.intervalSec > 0, 'invalid_monitor', 'Explicit bounded monitor window and interval required');
  return journal.transaction(() => {
    const key = `monitor:${input.id}`;
    const previous = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (previous) {
      const monitor = JSON.parse(previous.value);
      requireValue(canonical(monitor.definition) === canonical(input), 'monitor_conflict', 'Standing monitor definition changed');
      return monitor;
    }
    const monitor = { definition: input, state: 'active', nextAt: input.startsAt };
    journal.db.prepare('INSERT INTO settings VALUES (?,?)').run(key, JSON.stringify(monitor));
    return monitor;
  });
}

export function stopMonitor(journal, id) {
  const key = `monitor:${id}`;
  const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  requireValue(row, 'monitor_not_found', 'Unknown monitor');
  const monitor = { ...JSON.parse(row.value), state: 'stopped' };
  journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(monitor), key);
  return monitor;
}

export function tickMonitors(journal, clock = Date.now()) {
  const due = [];
  for (const row of journal.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'monitor:%'").all()) {
    const monitor = JSON.parse(row.value);
    if (monitor.state !== 'active') continue;
    if (clock >= Date.parse(monitor.definition.endsAt)) {
      journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ ...monitor, state: 'ended' }), row.key);
      continue;
    }
    if (clock < Date.parse(monitor.nextAt) || clock < Date.parse(monitor.definition.startsAt)) continue;
    const work = journal.work(monitor.definition.executionId);
    if (!work || !['settled_waiting', 'native_finished'].includes(work.state) || work.execution.cancellationRequested) continue;
    // A monitor only makes existing work eligible for a controlled check. Caller
    // must reconcile backend continuation and native admission, never inject here.
    const slot = monitor.pendingSlot ?? monitor.nextAt;
    due.push({ id: `monitor-check_${digest([monitor.definition.id, slot])}`, executionId: work.id,
      startsAt: monitor.definition.startsAt, endsAt: monitor.definition.endsAt, intendedAt: slot });
    journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ ...monitor, pendingSlot: slot }), row.key);
  }
  return due;
}

export function acknowledgeMonitor(journal, id, checkId, clock = Date.now()) {
  const key = `monitor:${id}`;
  const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  requireValue(row, 'monitor_not_found', 'Unknown monitor');
  const monitor = JSON.parse(row.value);
  requireValue(monitor.state === 'active' && monitor.pendingSlot && checkId === `monitor-check_${digest([id, monitor.pendingSlot])}` &&
    clock < Date.parse(monitor.definition.endsAt), 'monitor_expired', 'Monitor check is no longer admissible');
  journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ ...monitor, pendingSlot: null,
    nextAt: new Date(clock + monitor.definition.intervalSec * 1000).toISOString() }), key);
}
