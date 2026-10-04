import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, digest, now, RelayError, requireValue, text } from './protocol.mjs';
import { nativeConfig } from './opencode.mjs';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) {
      this.db.close();
      throw new RelayError('unsupported_schema', 'Database schema is newer than this Relay build');
    }
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bindings (
        id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE,
        conversation TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE, token TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, backend_key TEXT NOT NULL UNIQUE,
        binding_id TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_native_turn ON runs(binding_id) WHERE active = 1;
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY, run_id TEXT NOT NULL, at TEXT NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Schema 2 adds optional native invocation/observation fields to run JSON.
    // Existing schema-1 bindings and runs remain explicit pull records.
    if (version < 2) this.transaction(() => this.db.exec('PRAGMA user_version = 2'));
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  register(input) {
    const config = {};
    for (const key of ['id', 'companyId', 'agentId', 'harness', 'instanceId', 'conversationId']) {
      config[key] = text(input[key], key);
    }
    requireValue(['opencode', 'hermes'].includes(config.harness), 'invalid_harness', 'Use opencode or hermes');
    config.delivery = input.delivery ?? 'pull';
    requireValue(['pull', 'opencode'].includes(config.delivery), 'unsupported_delivery', 'Use pull or opencode delivery');
    if (config.delivery === 'opencode') {
      requireValue(config.harness === 'opencode', 'invalid_harness', 'Native OpenCode delivery requires an OpenCode binding');
      config.opencode = nativeConfig(input.opencode);
    }
    const existing = this.binding(config.id, false);
    if (existing) {
      requireValue(canonical(existing.config) === canonical(config), 'binding_conflict', 'Binding exists with different configuration', 409);
      return { binding: existing, token: this.db.prepare('SELECT token FROM bindings WHERE id = ?').get(config.id).token, created: false };
    }
    const identity = canonical([config.companyId, config.agentId]);
    const conversation = config.delivery === 'opencode'
      ? canonical(['opencode', config.opencode.url, config.opencode.directory, config.conversationId])
      : canonical([config.harness, config.instanceId, config.conversationId]);
    requireValue(!this.db.prepare('SELECT id FROM bindings WHERE identity = ? OR conversation = ?').get(identity, conversation),
      'identity_conflict', 'Agent or conversation already has a binding', 409);
    const token = randomBytes(32).toString('hex');
    const binding = { id: config.id, revision: 1, config, createdAt: now() };
    this.db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?)')
      .run(binding.id, identity, conversation, digest(token), token, JSON.stringify(binding));
    return { binding, token, created: true };
  }

  binding(id, required = true) {
    const row = this.db.prepare('SELECT data FROM bindings WHERE id = ?').get(id);
    if (!row && required) throw new RelayError('binding_not_found', 'Unknown binding', 404);
    return row ? JSON.parse(row.data) : null;
  }

  authenticate(token) {
    const row = this.db.prepare('SELECT id FROM bindings WHERE token_hash = ?').get(digest(token));
    return row?.id ?? null;
  }

  pinBackend(url) {
    const existing = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('paperclip');
    requireValue(!existing || existing.value === url, 'backend_mismatch', 'State directory belongs to a different Paperclip backend', 409);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('paperclip', url);
  }

  bindings() { return this.db.prepare('SELECT data FROM bindings ORDER BY id').all().map(row => JSON.parse(row.data)); }
  runs(bindingId) {
    const rows = bindingId
      ? this.db.prepare('SELECT data FROM runs WHERE binding_id = ? ORDER BY rowid DESC').all(bindingId)
      : this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC').all();
    return rows.map(row => JSON.parse(row.data));
  }

  run(id) {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    if (!row) throw new RelayError('run_not_found', 'Unknown Relay run', 404);
    return JSON.parse(row.data);
  }

  save(run, kind, detail = {}) {
    run.updatedAt = now();
    this.db.prepare('UPDATE runs SET active = ?, data = ? WHERE id = ?')
      .run(run.nativeState === 'settled' ? 0 : 1, JSON.stringify(run), run.id);
    this.db.prepare('INSERT INTO events(run_id, at, kind, data) VALUES (?, ?, ?, ?)')
      .run(run.id, run.updatedAt, kind, JSON.stringify(detail));
    return run;
  }

  dispatch(input) {
    const request = {};
    for (const key of ['bindingId', 'companyId', 'agentId', 'runId', 'taskId']) request[key] = text(input[key], key);
    requireValue(Number.isSafeInteger(input.bindingRevision) && input.bindingRevision > 0,
      'invalid_request', 'bindingRevision must be a positive integer');
    request.bindingRevision = input.bindingRevision;
    const binding = this.binding(request.bindingId);
    requireValue(binding.revision === request.bindingRevision, 'stale_binding', 'Binding revision does not match', 409);
    requireValue(binding.config.companyId === request.companyId && binding.config.agentId === request.agentId,
      'identity_mismatch', 'Paperclip identity does not match binding', 409);
    return this.transaction(() => {
      const key = canonical([request.companyId, request.runId]);
      const row = this.db.prepare('SELECT data FROM runs WHERE backend_key = ?').get(key);
      if (row) {
        const existing = JSON.parse(row.data);
        requireValue(canonical(existing.request) === canonical(request), 'dispatch_conflict', 'Run replay has changed payload', 409);
        return existing;
      }
      requireValue(!this.db.prepare('SELECT id FROM runs WHERE binding_id = ? AND active = 1').get(binding.id),
        'conversation_busy', 'Previous native work is not confirmed settled', 409);
      const run = {
        id: randomUUID(), request, conversationId: binding.config.conversationId,
        deliveryState: 'pending', nativeState: 'unclaimed', cancellationRequested: false,
        result: null, publication: { state: 'none' }, createdAt: now(), updatedAt: now(),
      };
      this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, 1, ?)').run(run.id, key, binding.id, JSON.stringify(run));
      return this.save(run, 'dispatch.persisted');
    });
  }

  acknowledge(id) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.deliveryState === 'acknowledged') return run;
      requireValue(!run.cancellationRequested && run.nativeState !== 'settled', 'work_cancelled', 'Work cannot be claimed', 409);
      run.deliveryState = 'acknowledged';
      run.nativeState = 'claimed';
      return this.save(run, 'delivery.acknowledged');
    });
  }

  submit(id, input) {
    const result = { key: text(input.key, 'key'), summary: text(input.summary, 'summary'), candidate: text(input.candidate, 'candidate') };
    return this.transaction(() => {
      const run = this.run(id);
      if (run.result) {
        requireValue(canonical(run.result) === canonical(result), 'submission_conflict', 'Attempt already has a different result', 409);
        return run;
      }
      requireValue(run.nativeState === 'claimed' && !run.cancellationRequested,
        'invalid_submission', 'Acknowledge active work before submitting', 409);
      run.result = result;
      run.publication = { state: 'pending' };
      return this.save(run, 'result.submitted', { digest: digest(result) });
    });
  }

  cancel(id) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.cancellationRequested || run.nativeState === 'settled') return run;
      run.cancellationRequested = true;
      if (run.nativeState === 'unclaimed' && !run.invocation) {
        run.nativeState = 'settled';
        run.settlement = { outcome: 'cancelled', evidence: 'Never acknowledged through the pull protocol' };
      }
      return this.save(run, 'cancellation.requested');
    });
  }

  settle(id, input) {
    requireValue(!this.run(id).invocation, 'native_observation_required', 'Native delivery requires verified native settlement', 409);
    const settlement = { outcome: text(input.outcome, 'outcome'), evidence: text(input.evidence, 'evidence') };
    requireValue(['completed', 'cancelled', 'failed'].includes(settlement.outcome), 'invalid_outcome', 'Unknown settlement outcome');
    return this.transaction(() => {
      const run = this.run(id);
      if (run.nativeState === 'settled') {
        requireValue(canonical(run.settlement) === canonical(settlement), 'settlement_conflict', 'Settlement already recorded', 409);
        return run;
      }
      requireValue(run.nativeState === 'claimed', 'not_claimed', 'Work has not been acknowledged', 409);
      requireValue(settlement.outcome !== 'completed' || (run.result && !run.cancellationRequested),
        'invalid_completion', 'Completion requires a result and no cancellation request', 409);
      requireValue(settlement.outcome !== 'cancelled' || run.cancellationRequested,
        'cancellation_required', 'Request cancellation first', 409);
      run.nativeState = 'settled';
      run.settlement = settlement;
      return this.save(run, 'native.settled', settlement);
    });
  }

  publication(id, publication) {
    return this.transaction(() => {
      const run = this.run(id);
      run.publication = publication;
      return this.save(run, 'publication.updated', publication);
    });
  }

  beginNative(id, prompt, priorUserIds) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.invocation || run.cancellationRequested || run.nativeState === 'settled') return run;
      requireValue(this.binding(run.request.bindingId).config.delivery === 'opencode', 'invalid_delivery', 'Native binding required');
      const prefix = (BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0').slice(-12);
      run.invocation = { messageId: `msg_${prefix}${randomBytes(7).toString('hex')}`, prompt, priorUserIds, createdAt: now() };
      run.native = { state: 'uncertain', reason: 'delivery_intent_persisted' };
      return this.save(run, 'native.delivery_intent', { messageId: run.invocation.messageId });
    });
  }

  nativeStatus(id, observation) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.nativeState === 'settled' || canonical(run.native) === canonical(observation)) return run;
      // Once conflicting input is observed, a later deletion must not erase it.
      if (run.native?.state === 'conflict') return run;
      run.native = observation;
      return this.save(run, 'native.observed', observation);
    });
  }

  finishNative(id, observation) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.nativeState === 'settled' || run.native?.state === 'conflict') return run;
      requireValue(run.invocation && observation.state === 'finished', 'native_observation_required', 'Terminal native response required');
      // An idle/finished turn without a submitted result remains unresolved.
      if (!run.cancellationRequested && !observation.error && !run.result) return run;
      run.nativeState = 'settled';
      run.settlement = {
        outcome: run.cancellationRequested ? 'cancelled' : observation.error ? 'failed' : 'completed',
        evidence: `OpenCode response ${observation.messageId} to ${run.invocation.messageId} is terminal and the reserved session is idle`,
      };
      return this.save(run, 'native.settled', run.settlement);
    });
  }
}
