import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, digest, now, RelayError, requireValue, text } from './protocol.mjs';
import { nativeConfig } from './opencode.mjs';
import { hermesConfig } from './hermes.mjs';
import { questionPayload } from './work.mjs';
import { resultPolicy } from './task-policy.mjs';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 4) {
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
      CREATE TABLE IF NOT EXISTS backend_recoveries (
        backend_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, request TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // Schema 2 adds optional native fields. Schema 3 adds replacement backend
    // run mappings. Existing pull bindings and runs are retained unchanged.
    if (version < 4) this.transaction(() => this.db.exec('PRAGMA user_version = 4'));
  }

  close() { this.db.close(); }

  operation(id) {
    const row = this.db.prepare('SELECT data FROM operations WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  saveOperation(operation) {
    operation.updatedAt = now();
    this.db.prepare('INSERT INTO operations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(operation.id, operation.runId, JSON.stringify(operation));
    return operation;
  }

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
    if (input.lifetime !== undefined) {
      requireValue(['persistent', 'service', 'task'].includes(input.lifetime), 'invalid_lifetime', 'Use persistent, service or task lifetime');
      config.lifetime = input.lifetime;
    }
    if (input.controllerBindingId !== undefined) {
      config.controllerBindingId = text(input.controllerBindingId, 'controllerBindingId');
      requireValue(this.binding(config.controllerBindingId).config.companyId === config.companyId,
        'forbidden', 'Lifecycle controller must belong to the same company', 403);
    }
    if (config.lifetime === 'task') {
      config.taskId = text(input.taskId, 'taskId');
      requireValue(config.controllerBindingId, 'controller_required', 'Task-scoped bindings require a lifecycle controller');
    }
    if (input.worktreeKey !== undefined) config.worktreeKey = text(input.worktreeKey, 'worktreeKey');
    if (input.label !== undefined) config.label = text(input.label, 'label');
    if (input.capabilities !== undefined) {
      requireValue(Array.isArray(input.capabilities) && input.capabilities.length <= 64, 'invalid_capabilities', 'Capabilities must be an array of at most 64 labels');
      config.capabilities = [...new Set(input.capabilities.map(value => text(value, 'capability')))];
    }
    config.delivery = input.delivery ?? 'pull';
    requireValue(['pull', 'opencode', 'hermes'].includes(config.delivery), 'unsupported_delivery', 'Use pull, opencode or hermes delivery');
    if (config.delivery === 'opencode') {
      requireValue(config.harness === 'opencode', 'invalid_harness', 'Native OpenCode delivery requires an OpenCode binding');
      config.opencode = nativeConfig(input.opencode);
    }
    if (config.delivery === 'hermes') {
      requireValue(config.harness === 'hermes', 'invalid_harness', 'Native Hermes delivery requires a Hermes binding');
      config.hermes = hermesConfig(input.hermes);
    }
    const existing = this.binding(config.id, false);
    if (existing) {
      requireValue(canonical(existing.config) === canonical(config), 'binding_conflict', 'Binding exists with different configuration', 409);
      return { binding: existing, token: this.db.prepare('SELECT token FROM bindings WHERE id = ?').get(config.id).token, created: false };
    }
    const identity = canonical([config.companyId, config.agentId]);
    const conversation = config.delivery === 'opencode'
      ? canonical(['opencode', config.opencode.url, config.opencode.directory, config.conversationId])
      : config.delivery === 'hermes' ? canonical(['hermes', config.hermes.url, config.hermes.profile ?? '', config.conversationId])
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

  rotateCredential(id, key) {
    return this.transaction(() => {
      const binding = this.binding(id);
      requireValue(!binding.lifecycleState && !this.runs(id).some(run => run.nativeState !== 'settled'),
        'binding_busy', 'Credential rotation requires an active binding without unsettled work', 409);
      const operationId = `credential:${digest([id, text(key, 'key')])}`;
      const previous = this.operation(operationId);
      if (previous) {
        requireValue(binding.credentialGeneration === previous.generation, 'credential_rotation_superseded', 'A later rotation replaced this operation', 409);
        return { binding, token: this.db.prepare('SELECT token FROM bindings WHERE id = ?').get(id).token };
      }
      const token = randomBytes(32).toString('hex');
      binding.credentialGeneration = (binding.credentialGeneration ?? 0) + 1;
      this.db.prepare('UPDATE bindings SET token = ?, token_hash = ?, data = ? WHERE id = ?')
        .run(token, digest(token), JSON.stringify(binding), id);
      this.saveOperation({ id: operationId, runId: '', bindingId: id, generation: binding.credentialGeneration, state: 'recorded' });
      return { binding, token };
    });
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

  assertWorkerAdmission(bindingId) {
    const bridge = this.operation(`opencode-bridge:${bindingId}`);
    const grants = this.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%'").all()
      .map(row => JSON.parse(row.data)).filter(item => item.bindingId === bindingId ||
        (bridge && item.target?.observedId === bridge.identity.observedId));
    const current = grants.filter(item => !grants.some(next => next.id !== item.id &&
      next.supersedes?.includes(item.id) && item.state === 'blocked' && item.disarmed === true &&
      canonical(next.target) === canonical(item.target)));
    requireValue((!grants.length || current.length === 1) && current.every(item => item.state === 'armed' && bridge &&
      item.target?.conversationId === bridge.identity.conversationId &&
      item.target?.terminalId === bridge.identity.terminalId && item.target?.directory === bridge.identity.directory),
    'worker_grant_inactive', 'Worker preparation grant is not active for this exact conversation', 409);
  }

  dispatch(input) {
    const request = {};
    for (const key of ['bindingId', 'companyId', 'agentId', 'runId', 'taskId']) request[key] = text(input[key], key);
    requireValue(Number.isSafeInteger(input.bindingRevision) && input.bindingRevision > 0,
      'invalid_request', 'bindingRevision must be a positive integer');
    request.bindingRevision = input.bindingRevision;
    if (input.scheduleId !== undefined) request.scheduleId = text(input.scheduleId, 'scheduleId');
    const binding = this.binding(request.bindingId);
    requireValue(!binding.config.taskId || binding.config.taskId === request.taskId, 'task_scope_mismatch', 'Task-scoped binding belongs to another task', 409);
    requireValue(binding.revision === request.bindingRevision, 'stale_binding', 'Binding revision does not match', 409);
    requireValue(binding.config.companyId === request.companyId && binding.config.agentId === request.agentId,
      'identity_mismatch', 'Paperclip identity does not match binding', 409);
    return this.transaction(() => {
      const key = canonical([request.companyId, request.runId]);
      const recovery = this.db.prepare('SELECT * FROM backend_recoveries WHERE backend_key = ?').get(key);
      if (recovery) {
        requireValue(recovery.request === canonical(request), 'dispatch_conflict', 'Recovery replay has changed payload', 409);
        return this.run(recovery.run_id);
      }
      const row = this.db.prepare('SELECT data FROM runs WHERE backend_key = ?').get(key);
      if (row) {
        const existing = JSON.parse(row.data);
        requireValue(canonical(existing.request) === canonical(request), 'dispatch_conflict', 'Run replay has changed payload', 409);
        return existing;
      }
      const unresolvedReview = this.db.prepare("SELECT data FROM operations WHERE id LIKE 'harness-review:%'").all()
        .map(row => JSON.parse(row.data)).some(operation => {
          if (operation.state === 'recorded') return false;
          // Older persisted harness intents carry task identity only through runId.
          const scope = operation.request?.companyId && operation.request?.taskId
            ? operation.request : this.run(operation.runId).request;
          return scope.companyId === request.companyId && scope.taskId === request.taskId;
        });
      requireValue(!unresolvedReview, 'review_decision_uncertain', 'Task has an unresolved harness review decision', 409);
      // Paperclip filters custom wake payload fields in some adapter contexts.
      const uncertainCompletion = this.db.prepare("SELECT data FROM operations WHERE id LIKE 'completion:%' OR id LIKE 'no-review-completion:%'").all()
        .map(row => JSON.parse(row.data)).some(operation => operation.state === 'uncertain' &&
          operation.companyId === request.companyId && operation.taskId === request.taskId);
      requireValue(!uncertainCompletion, 'completion_uncertain', 'Task completion requires reconciliation before new work', 409);
      // Registered service schedules are therefore also resolved by exact
      // binding/task identity, rather than depending on that field surviving.
      const scheduled = this.db.prepare("SELECT data FROM operations WHERE id LIKE 'schedule:%' ORDER BY rowid DESC").all()
        .map(row => JSON.parse(row.data)).find(schedule => schedule.request.bindingId === binding.id && schedule.request.taskId === request.taskId);
      if (scheduled) {
        requireValue(scheduled.state === 'active' && Date.now() >= Date.parse(scheduled.request.startsAt) &&
          Date.now() < Date.parse(scheduled.request.endsAt), 'schedule_inactive', 'Registered monitoring window is not active', 409);
      }
      requireValue(!['retired', 'retiring'].includes(binding.lifecycleState), 'binding_retired', 'Binding is retiring or retired', 409);
      const observedPermit = this.operation(`observed-pull:${binding.id}`);
      const bridge = this.operation(`opencode-bridge:${binding.id}`);
      if (bridge) {
        this.assertWorkerAdmission(binding.id);
        const observed = this.operation(bridge.identity.observedId);
        requireValue(bridge.state === 'armed' && Date.now() - Date.parse(bridge.lastSeen) < 10000 &&
          observed?.availability === 'present' && !observed.error && Date.now() - Date.parse(observed.updatedAt) < 15000 &&
          observed.placement?.terminalId === bridge.identity.terminalId && observed.placement?.directory === bridge.identity.directory &&
          observed.identity.conversationId === bridge.identity.conversationId,
          'bridge_unavailable', 'A live armed bridge is required for dispatch', 409);
      } else if (observedPermit) {
        const observed = this.operation(observedPermit.request.observedId);
        requireValue(observedPermit.state === 'active' && Date.parse(observedPermit.expiresAt) > Date.now() &&
          observedPermit.request.taskId === request.taskId && !this.runs(binding.id).some(run => run.request.taskId === request.taskId),
        'observed_reservation_closed', 'Observed delivery is restricted to one run of the reserved task', 409);
        requireValue(observed?.availability === 'present' && !observed.error && Date.now() - Date.parse(observed.updatedAt) < 15000,
          'observed_agent_unavailable', 'A recent unique Herdr observation is required for dispatch', 409);
      }
      if (request.scheduleId) {
        const schedule = this.operation(request.scheduleId);
        requireValue(schedule?.request?.bindingId === binding.id && schedule.request.taskId === request.taskId,
          'schedule_identity_mismatch', 'Scheduled dispatch does not match its binding and task', 409);
        requireValue(schedule.state === 'active' && Date.now() >= Date.parse(schedule.request.startsAt) &&
          Date.now() < Date.parse(schedule.request.endsAt), 'schedule_inactive', 'Monitoring window is not active', 409);
      }
      const runtimeKey = (binding.config.opencode ?? binding.config.hermes)?.runtimeKey;
      if (runtimeKey) requireValue(this.operation(`runtime:${runtimeKey}`)?.state === 'ready',
        'runtime_not_ready', 'Owned native runtime is not available for dispatch', 409);
      const decision = this.operation(`review-decision:${digest([request.companyId, request.taskId])}`);
      requireValue(!decision || decision.state === 'recorded', 'review_decision_uncertain', 'Task has an unresolved candidate decision', 409);
      requireValue(!this.db.prepare('SELECT id FROM runs WHERE binding_id = ? AND active = 1').get(binding.id),
        'conversation_busy', 'Previous native work is not confirmed settled', 409);
      if (binding.config.lifetime === 'task') {
        const previous = this.runs(binding.id).find(run => run.result);
        requireValue(!previous || previous.review?.status === 'rejected', 'candidate_reserved', 'Task-scoped worker awaits candidate review or retirement', 409);
      }
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

  recover(id, input) {
    return this.transaction(() => {
      const run = this.run(id);
      const request = {};
      for (const key of ['bindingId', 'companyId', 'agentId', 'runId', 'taskId']) request[key] = text(input[key], key);
      request.bindingRevision = input.bindingRevision;
      requireValue(['bindingId', 'companyId', 'agentId', 'taskId', 'bindingRevision'].every(key => request[key] === run.request[key]),
        'recovery_identity_mismatch', 'Recovery must retain binding revision, company, agent and task', 409);
      requireValue(request.runId !== run.request.runId, 'invalid_recovery', 'Recovery needs a replacement backend run');
      const backendKey = canonical([request.companyId, request.runId]);
      const existing = this.db.prepare('SELECT * FROM backend_recoveries WHERE backend_key = ?').get(backendKey);
      if (existing) {
        requireValue(existing.run_id === id && existing.request === canonical(request), 'recovery_conflict', 'Replacement run already bound', 409);
        return run;
      }
      requireValue(!this.db.prepare('SELECT id FROM runs WHERE backend_key = ?').get(backendKey), 'recovery_conflict', 'Replacement run already dispatched', 409);
      this.db.prepare('INSERT INTO backend_recoveries VALUES (?, ?, ?)').run(backendKey, id, canonical(request));
      run.backendRunId = request.runId;
      run.recoveries = [...(run.recoveries ?? []), { runId: request.runId, at: now() }];
      return this.save(run, 'backend.recovered', { runId: request.runId });
    });
  }

  submit(id, input) {
    const result = { key: text(input.key, 'key'), summary: text(input.summary, 'summary'), candidate: text(input.candidate, 'candidate') };
    if (input.reviewDecision !== undefined) {
      resultPolicy(this, this.run(id), input);
      result.reviewDecision = { mode: input.reviewDecision.mode, reason: input.reviewDecision.reason };
    }
    if (input.deliverables !== undefined) {
      requireValue(Array.isArray(input.deliverables) && input.deliverables.length <= 128, 'invalid_evidence', 'Deliverables must be an array of at most 128 references');
      result.deliverables = input.deliverables.map(value => text(value, 'deliverable'));
    }
    if (input.checks !== undefined) {
      requireValue(Array.isArray(input.checks) && input.checks.length <= 128, 'invalid_evidence', 'Checks must be an array of at most 128 entries');
      result.checks = input.checks.map(check => {
        requireValue(check && ['passed', 'failed', 'not_run'].includes(check.outcome), 'invalid_evidence', 'Check outcome is required');
        return { command: text(check.command, 'check.command'), outcome: check.outcome,
          evidence: text(check.evidence, 'check.evidence'), source: 'worker_reported' };
      });
    }
    return this.transaction(() => {
      const run = this.run(id);
      if (run.result) {
        requireValue(canonical(run.result) === canonical(result), 'submission_conflict', 'Attempt already has a different result', 409);
        return run;
      }
      requireValue(run.nativeState === 'claimed' && !run.cancellationRequested,
        'invalid_submission', 'Acknowledge active work before submitting', 409);
      requireValue(!run.waiting && !run.dependency, 'work_waiting', 'This turn is already waiting', 409);
      resultPolicy(this, run, result);
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
    requireValue(['completed', 'cancelled', 'failed', 'waiting'].includes(settlement.outcome), 'invalid_outcome', 'Unknown settlement outcome');
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
      requireValue(settlement.outcome !== 'waiting' || (run.waiting?.state === 'recorded' && !run.cancellationRequested),
        'question_not_published', 'Waiting requires a published question and no cancellation', 409);
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

  beginNative(id, prompt, priorUserIds, eventCursor) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.invocation || run.cancellationRequested || run.nativeState === 'settled') return run;
      requireValue(['opencode', 'hermes'].includes(this.binding(run.request.bindingId).config.delivery) ||
        this.operation(`opencode-bridge:${run.request.bindingId}`)?.state === 'armed', 'invalid_delivery', 'Native binding required');
      const prefix = (BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0').slice(-12);
      run.invocation = { messageId: `msg_${prefix}${randomBytes(7).toString('hex')}`, prompt, priorUserIds, createdAt: now() };
      if (eventCursor !== undefined) run.invocation.eventCursor = eventCursor;
      run.native = { state: 'uncertain', reason: 'delivery_intent_persisted' };
      return this.save(run, 'native.delivery_intent', { messageId: run.invocation.messageId });
    });
  }

  nativeStatus(id, observation) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.nativeState === 'settled' || canonical(run.native) === canonical(observation)) return run;
      // Once conflicting input is observed, a later deletion must not erase it.
      if (['conflict', 'finished'].includes(run.native?.state)) return run;
      run.native = observation;
      return this.save(run, 'native.observed', observation);
    });
  }

  finishNative(id, observation) {
    return this.transaction(() => {
      const run = this.run(id);
      if (run.nativeState === 'settled' || run.native?.state === 'conflict') return run;
      requireValue(run.invocation && observation.state === 'finished' && canonical(run.native) === canonical(observation),
        'native_observation_required', 'Persisted terminal native response required');
      // An idle/finished turn without a submitted result remains unresolved.
      if (!run.cancellationRequested && !observation.error && !run.result && run.waiting?.state !== 'recorded' && !run.dependency) return run;
      run.nativeState = 'settled';
      run.settlement = {
        outcome: run.cancellationRequested ? 'cancelled' : observation.error ? 'failed' : run.waiting || run.dependency ? 'waiting' : 'completed',
        evidence: `${this.binding(run.request.bindingId).config.harness} response ${observation.messageId} to ${run.invocation.messageId} is terminal and the reserved session is idle`,
      };
      return this.save(run, 'native.settled', run.settlement);
    });
  }

  ask(id, input) {
    return this.transaction(() => {
      const run = this.run(id);
      const payload = questionPayload(run, input);
      if (run.waiting) {
        requireValue(canonical(run.waiting.payload) === canonical(payload), 'question_conflict', 'Turn already has a different question', 409);
        return run;
      }
      requireValue(run.nativeState === 'claimed' && !run.result && !run.dependency && !run.cancellationRequested,
        'invalid_question', 'Only acknowledged active work can ask before submission', 409);
      run.waiting = { payload, request: payload.request, state: 'pending' };
      return this.save(run, 'question.requested', { key: payload.key });
    });
  }

  waitForDependency(id, children) {
    const ids = typeof children === 'string' ? [children] : children;
    requireValue(Array.isArray(ids) && ids.length > 0 && ids.length <= 64,
      'invalid_request', 'Dependencies must contain between 1 and 64 task IDs');
    const taskIds = ids.map(value => text(value, 'taskId')).sort();
    requireValue(new Set(taskIds).size === taskIds.length && taskIds.every(value => value === value.trim()),
      'invalid_request', 'Task IDs must be unique and have no surrounding whitespace');
    const run = this.run(id);
    requireValue(run.nativeState === 'claimed' && !run.result && !run.waiting && !run.cancellationRequested,
      'work_inactive', 'Active acknowledged turn required', 409);
    requireValue(!run.dependency || canonical([...(run.dependency.taskIds ?? [run.dependency.childId])].sort()) === canonical(taskIds),
      'operation_conflict', 'Dependency changed', 409);
    if (run.dependency) return run;
    run.dependency = { ...(taskIds.length === 1 ? { childId: taskIds[0] } : { taskIds }), state: 'recorded' };
    return this.save(run, 'dependency.waiting', run.dependency);
  }

  progress(id, input) {
    return this.transaction(() => {
      const run = this.run(id);
      const entry = { key: text(input.key, 'key'), summary: text(input.summary, 'summary') };
      const previous = run.progress?.find(item => item.key === entry.key);
      if (previous) {
        requireValue(previous.summary === entry.summary, 'progress_conflict', 'Progress key has different content', 409);
        return run;
      }
      requireValue(run.nativeState === 'claimed' && !run.result && !run.waiting && !run.cancellationRequested,
        'work_inactive', 'Progress requires an active acknowledged turn', 409);
      run.progress = [...(run.progress ?? []), { ...entry, at: now() }];
      return this.save(run, 'work.progress', entry);
    });
  }

  reviewerEvidence(id, input, caller) {
    return this.transaction(() => {
      const run = this.run(id);
      requireValue(run.result && run.result.candidate === input.candidate, 'stale_candidate', 'Reviewer checks must name the exact candidate', 409);
      requireValue(caller.request.companyId === run.request.companyId && caller.request.agentId !== run.request.agentId,
        'self_review_forbidden', 'Independent same-company reviewer required', 403);
      const entry = { key: text(input.key, 'key'), candidate: input.candidate, reviewerAgentId: caller.request.agentId,
        command: text(input.command, 'command'), outcome: text(input.outcome, 'outcome'), evidence: text(input.evidence, 'evidence'), source: 'reviewer_reported' };
      requireValue(['passed', 'failed', 'not_run'].includes(entry.outcome), 'invalid_evidence', 'Invalid check outcome');
      const previous = run.reviewerChecks?.find(check => check.key === entry.key && check.reviewerAgentId === entry.reviewerAgentId);
      if (previous) {
        requireValue(canonical(previous) === canonical(entry), 'evidence_conflict', 'Reviewer evidence key changed', 409);
        return run;
      }
      run.reviewerChecks = [...(run.reviewerChecks ?? []), entry];
      return this.save(run, 'reviewer.check', entry);
    });
  }

  questionReceipt(id, receipt) {
    return this.transaction(() => {
      const run = this.run(id);
      requireValue(run.waiting, 'question_required', 'No question was requested');
      run.waiting = { ...run.waiting, ...receipt };
      return this.save(run, 'question.publication', receipt);
    });
  }

  recordReview(id, receipt) {
    return this.transaction(() => {
      const run = this.run(id);
      const decisionId = `review-decision:${digest([run.request.companyId, run.request.taskId])}`;
      const decision = this.operation(decisionId);
      if (decision?.state === 'uncertain' && decision.targetRunId === id &&
        receipt.status === (decision.action === 'accept' ? 'accepted' : 'rejected')) {
        this.saveOperation({ ...decision, state: 'recorded', interactionId: receipt.interactionId });
      }
      if (run.review && ['interactionId', 'candidate', 'status'].every(key => run.review[key] === receipt[key])) return run;
      run.review = receipt;
      return this.save(run, 'review.observed', receipt);
    });
  }

  interruptIntent(id) {
    return this.transaction(() => {
      const run = this.run(id);
      requireValue(run.cancellationRequested && run.invocation && run.native?.state === 'observed',
        'interruption_not_authorised', 'Observed owned invocation and cancellation required', 409);
      run.interruption = { state: 'uncertain', at: now(), messageId: run.invocation.messageId };
      return this.save(run, 'native.interrupt_intent', run.interruption);
    });
  }

  rebind(id, input, { managedContinuation = false } = {}) {
    return this.transaction(() => {
      const binding = this.binding(id);
      requireValue(input.revision === binding.revision, 'stale_binding', 'Binding revision changed', 409);
      requireValue(!this.runs(id).some(run => run.nativeState !== 'settled'), 'conversation_busy', 'Unsettled work prevents rebinding', 409);
      requireValue(!['retired', 'retiring'].includes(binding.lifecycleState), 'binding_retired', 'Retiring or retired binding cannot be rebound', 409);
      const config = binding.config;
      requireValue(input.conversationId === config.conversationId && input.harness === config.harness,
        'continuation_mismatch', 'Rebinding must preserve the exact stored conversation and harness', 409);
      const native = config.harness === 'opencode' ? nativeConfig(input.opencode) : hermesConfig(input.hermes);
      requireValue(config.delivery === config.harness, 'invalid_delivery', 'Rebinding requires native delivery', 409);
      requireValue(managedContinuation || (!(config.opencode ?? config.hermes)?.runtimeKey && !native.runtimeKey),
        'managed_rebind_unsupported', 'Managed runtime replacement requires lifecycle reconciliation', 409);
      const conversation = config.harness === 'opencode'
        ? canonical(['opencode', native.url, native.directory, config.conversationId])
        : canonical(['hermes', native.url, native.profile ?? '', config.conversationId]);
      requireValue(!this.db.prepare('SELECT id FROM bindings WHERE conversation = ? AND id != ?').get(conversation, id),
        'identity_conflict', 'Native conversation already bound', 409);
      binding.history = [...(binding.history ?? []), { revision: binding.revision, config, continuedAt: now() }];
      binding.config = { ...config, instanceId: text(input.instanceId, 'instanceId'), [config.harness]: native };
      binding.revision++;
      this.db.prepare('UPDATE bindings SET conversation = ?, data = ? WHERE id = ?').run(conversation, JSON.stringify(binding), id);
      return binding;
    });
  }

  retireBinding(id) {
    return this.transaction(() => {
      const binding = this.binding(id);
      requireValue(!this.runs(id).some(run => run.nativeState !== 'settled'), 'conversation_busy', 'Unsettled work prevents retirement', 409);
      binding.lifecycleState = 'retired';
      binding.retiredAt ??= now();
      this.db.prepare('UPDATE bindings SET data = ? WHERE id = ?').run(JSON.stringify(binding), id);
      return binding;
    });
  }

  transferController(id, input) {
    return this.transaction(() => {
      const binding = this.binding(id);
      requireValue(binding.revision === input.revision, 'stale_binding', 'Binding revision changed', 409);
      requireValue(!this.runs(id).some(run => run.nativeState !== 'settled'), 'conversation_busy', 'Unsettled work prevents controller transfer', 409);
      requireValue(!binding.lifecycleState, 'binding_retired', 'Retiring bindings cannot transfer lifecycle control', 409);
      const controller = this.binding(text(input.controllerBindingId, 'controllerBindingId'));
      requireValue(controller.id !== id && controller.config.companyId === binding.config.companyId && !controller.lifecycleState,
        'invalid_controller', 'Controller must be an active independent binding in the same company');
      binding.history = [...(binding.history ?? []), { revision: binding.revision, config: binding.config, transferredAt: now() }];
      binding.config = { ...binding.config, controllerBindingId: controller.id };
      binding.revision++;
      this.db.prepare('UPDATE bindings SET data = ? WHERE id = ?').run(JSON.stringify(binding), id);
      return binding;
    });
  }

  beginRetirement(id) {
    return this.transaction(() => {
      const binding = this.binding(id);
      requireValue(!this.runs(id).some(run => run.nativeState !== 'settled'), 'conversation_busy', 'Unsettled work prevents retirement', 409);
      if (binding.lifecycleState !== 'retired') binding.lifecycleState = 'retiring';
      this.db.prepare('UPDATE bindings SET data = ? WHERE id = ?').run(JSON.stringify(binding), id);
      return binding;
    });
  }
}
