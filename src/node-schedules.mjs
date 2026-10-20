import { canonical, digest, requireValue } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';
import { isAbsolute, normalize } from 'node:path';

export function installLocalSchedule(journal, input, clock = Date.now()) {
  const allowed = ['id', 'revision', 'nodeId', 'targetAgentId', 'targetFolder', 'targetConversationId', 'instructions', 'cron', 'timezone', 'at', 'enabled', 'reviewPolicy', 'expiresAt', 'intent'];
  requireValue(input && Object.keys(input).every(key => allowed.includes(key)) &&
    typeof input.id === 'string' && input.id.length > 0 && input.nodeId === journal.nodeId &&
    Number.isSafeInteger(input.revision) && input.revision > 0 && (input.intent === 'reminder' || typeof input.targetAgentId === 'string' || typeof input.targetFolder === 'string') &&
    typeof input.instructions === 'string' && input.instructions.trim() && typeof input.enabled === 'boolean' &&
    ['none', 'human'].includes(input.reviewPolicy ?? 'none') && ['job', 'reminder'].includes(input.intent ?? 'job'), 'invalid_schedule', 'Invalid local schedule definition');
  requireValue(Boolean(input.cron) !== Boolean(input.at), 'invalid_schedule', 'Choose cron or one-shot time');
  requireValue(input.targetFolder === undefined || input.intent !== 'reminder' && !input.targetAgentId && !input.targetConversationId &&
    typeof input.targetFolder === 'string' && isAbsolute(input.targetFolder) && normalize(input.targetFolder) === input.targetFolder && input.targetFolder.length <= 4096,
  'invalid_schedule', 'Folder schedules require one explicit absolute folder target');
  requireValue(input.targetConversationId === undefined || input.intent !== 'reminder' &&
    typeof input.targetConversationId === 'string' && input.targetConversationId.trim() && input.targetConversationId.length <= 512,
  'invalid_schedule', 'Exact conversation is supported only for execution schedules');
  const definition = structuredClone({ ...input, timezone: input.timezone ?? 'Africa/Johannesburg', reviewPolicy: input.reviewPolicy ?? 'none' });
  const nextAt = definition.cron ? previewCron(definition.cron, definition.timezone, clock).nextRuns[0] : definition.at;
  requireValue(Number.isFinite(Date.parse(nextAt)) && (!input.expiresAt || Number.isFinite(Date.parse(input.expiresAt))),
    'invalid_schedule', 'Valid occurrence and expiry timestamps required');
  return journal.transaction(() => {
    const previous = journal.db.prepare('SELECT data FROM schedules WHERE id=?').get(input.id);
    if (previous) {
      const stored = JSON.parse(previous.data);
      requireValue(stored.state !== 'cancelled', 'schedule_cancelled', 'Cancelled schedule cannot be reinstalled');
      if (stored.definition.revision === input.revision) {
        requireValue(canonical(stored.definition) === canonical(definition), 'schedule_conflict', 'Schedule revision payload changed');
        return stored;
      }
      requireValue(input.revision > stored.definition.revision, 'stale_revision', 'Newer schedule revision required');
      requireValue((stored.definition.intent ?? 'job') === (definition.intent ?? 'job'), 'schedule_mode_locked', 'Schedule intent is immutable');
    }
    const schedule = { id: input.id, definition, nextAt, state: definition.enabled ? 'active' : 'paused' };
    journal.db.prepare('INSERT INTO schedules VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(schedule.id, JSON.stringify(schedule));
    return schedule;
  });
}

export function tickLocalSchedules(journal, clock = Date.now()) {
  return journal.transaction(() => {
    const admitted = [];
    for (const row of journal.db.prepare('SELECT data FROM schedules ORDER BY id').all()) {
      let schedule = JSON.parse(row.data);
      if (schedule.state !== 'active' || clock < Date.parse(schedule.nextAt)) continue;
      const d = schedule.definition;
      if (d.expiresAt && clock >= Date.parse(d.expiresAt)) schedule.state = 'expired';
      else {
        const due = Date.parse(schedule.nextAt);
        // On recurring downtime, skip old ticks instead of replaying a backlog.
        const stale = d.cron && clock - due >= 60000;
        const active = journal.db.prepare("SELECT 1 FROM occurrences WHERE schedule_id=? AND state IN ('pending','admitted','uncertain','waiting_question') LIMIT 1").get(d.id);
        if (!stale && !active) {
          const id = `occurrence_${digest([d.id, schedule.nextAt])}`;
          const occurrence = { id, scheduleId: d.id, intendedAt: schedule.nextAt, definition: d, state: 'pending' };
          journal.db.prepare('INSERT OR IGNORE INTO occurrences VALUES (?,?,?,?)').run(id, d.id, occurrence.state, JSON.stringify(occurrence));
          admitted.push(occurrence);
        }
        if (d.cron) schedule.nextAt = previewCron(d.cron, d.timezone, clock).nextRuns[0];
        else if (!active) schedule.state = 'ended';
      }
      journal.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify(schedule), schedule.id);
    }
    return admitted;
  });
}
