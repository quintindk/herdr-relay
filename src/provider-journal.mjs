import { digest, canonical, requireValue } from './protocol.mjs';

// Shared uncertainty wrapper for external APIs without idempotent mutations.
// 'uncertain' must be committed before send. Absence is never a resend permit.
export class ProviderJournal {
  constructor(db, scope) {
    this.db = db; this.scope = scope;
    this.pending = new Map();
    db.exec('CREATE TABLE IF NOT EXISTS provider_operations(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  }
  save(operation) {
    this.db.prepare('INSERT INTO provider_operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(operation.id, JSON.stringify(operation));
    return operation;
  }
  async perform({ key, kind, payload, send, reconcile }) {
    requireValue(typeof key === 'string' && key.trim() && key.length <= 256, 'invalid_key', 'Stable external operation key required');
    const identity = digest([this.scope, key]);
    const hash = digest({ kind, payload });
    const active = this.pending.get(identity);
    if (active) {
      requireValue(active.hash === hash, 'operation_conflict', 'Concurrent external operation payload changed');
      return active.promise;
    }
    const promise = this.execute({ key, kind, payload, send, reconcile }).finally(() => this.pending.delete(identity));
    this.pending.set(identity, { hash, promise });
    return promise;
  }
  async execute({ key, kind, payload, send, reconcile }) {
    const id = digest([this.scope, key]);
    const row = this.db.prepare('SELECT data FROM provider_operations WHERE id=?').get(id);
    let operation = row ? JSON.parse(row.data) : null;
    const request = { kind, payload };
    if (operation) {
      requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'External operation key payload changed');
      if (operation.state === 'recorded') return operation.receipt;
      const receipt = await reconcile(operation);
      requireValue(receipt, 'operation_uncertain', 'External write unconfirmed. No replay permitted', 409);
      this.save({ ...operation, state: 'recorded', receipt });
      return receipt;
    }
    operation = this.save({ id, request, marker: `herdr-relay:${id}`, state: 'uncertain' });
    const receipt = await send(operation);
    requireValue(receipt && typeof receipt === 'object', 'invalid_backend_response', 'External receipt required');
    this.save({ ...operation, state: 'recorded', receipt });
    return receipt;
  }
}
