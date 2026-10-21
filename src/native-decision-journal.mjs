import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, requireValue } from './protocol.mjs';

// Human keyboard decisions only. Persist the exact authorised command before
// sending it. A lost reply must never create a new decision or operation key.
export class NativeDecisionJournal {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      key TEXT PRIMARY KEY, entity TEXT NOT NULL, instance TEXT NOT NULL, command TEXT NOT NULL,
      state TEXT NOT NULL, receipt TEXT, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS outstanding_decision ON decisions(entity) WHERE state IN ('pending','conflict');`);
  }
  pending() { return this.db.prepare("SELECT * FROM decisions WHERE state IN ('pending','conflict') ORDER BY rowid").all()
    .map(row => ({ ...row, command: JSON.parse(row.command) })); }
  async submit(api, command, instanceId) {
    requireValue(instanceId, 'invalid_backend_response', 'Preview backend instance identity required');
    const previous = this.db.prepare('SELECT * FROM decisions WHERE key=?').get(command.key);
    if (previous) {
      requireValue(previous.command === canonical(command) && previous.instance === instanceId,
        'decision_conflict', 'Stored decision payload or backend identity changed');
      if (previous.state === 'recorded') return JSON.parse(previous.receipt);
      requireValue(previous.state === 'pending', 'decision_conflict', 'Decision requires inspection. It will not be reapplied automatically');
    } else {
      const entity = `${command.action}:${command.payload.id}`;
      requireValue(!this.db.prepare("SELECT key FROM decisions WHERE entity=? AND state IN ('pending','conflict')").get(entity),
        'decision_pending', 'A confirmed decision for this item is already pending. Reconcile it from Inbox');
      this.db.prepare('INSERT INTO decisions(key,entity,instance,command,state) VALUES (?,?,?,?,?)')
        .run(command.key, entity, instanceId, canonical(command), 'pending');
    }
    try {
      const info = await api('GET', '/v1/info');
      requireValue(info.instanceId === instanceId, 'backend_identity_changed', 'Backend identity changed. The confirmed decision remains pending for inspection');
      const receipt = await api('POST', '/v1/commands', command);
      const p = command.payload;
      const valid = receipt?.id === p.id && (command.action === 'question.answer'
        ? receipt.status === 'answered' && receipt.answer?.body === p.body && receipt.answer.author?.type === 'user'
        : command.action === 'notification.acknowledge' ? receipt.state === 'acknowledged'
          : command.action === 'execution.monitor_review' ? receipt.state === (p.decision === 'accept' ? 'waiting_time' : 'monitor_blocked')
            : receipt.state === (p.decision === 'accept' ? 'completed' : 'rejected') && receipt.review?.candidate === p.candidate && receipt.review.decision === p.decision);
      requireValue(valid, 'invalid_decision_receipt', 'Decision receipt is incomplete or does not match the confirmed item. Reconcile the original operation', 502);
      this.db.prepare("UPDATE decisions SET state='recorded',receipt=?,error=NULL WHERE key=?").run(JSON.stringify(receipt), command.key);
      return receipt;
    } catch (error) {
      const conflict = error.code !== 'backend_identity_changed' && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
      this.db.prepare('UPDATE decisions SET state=?,error=? WHERE key=?').run(conflict ? 'conflict' : 'pending', error.code ?? 'publication_uncertain', command.key);
      throw error;
    }
  }
  async retry(api, key) {
    const row = this.db.prepare('SELECT * FROM decisions WHERE key=?').get(key);
    requireValue(row, 'decision_missing', 'Stored decision not found');
    return this.submit(api, JSON.parse(row.command), row.instance);
  }
  dismiss(key) {
    requireValue(this.db.prepare('SELECT state FROM decisions WHERE key=?').get(key)?.state === 'conflict',
      'decision_uncertain', 'Only a definitively refused decision can be dismissed. Uncertain publication must be reconciled');
    this.db.prepare("UPDATE decisions SET state='dismissed' WHERE key=?").run(key);
  }
  close() { this.db.close(); }
}
