import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { digest, canonical, requireValue } from './protocol.mjs';
import { writePrivateJson, createPrivateJson } from './private-files.mjs';
import { headlessSource } from './headless-capabilities.mjs';

const format = 'herdr-relay-headless-artifact/1';
const settled = r => ['applied', 'no_change', 'failed', 'blocked'].includes(r.status);
const safeName = name => typeof name === 'string' && name.length <= 192 && name.endsWith('.json') && !name.startsWith('.') && !/[\\/\x00-\x1f]/.test(name);
const hash = bytes => digest(bytes.toString('base64'));
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const get = (journal, key) => { const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
const put = (journal, key, value) => journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const records = (journal, prefix) => journal.db.prepare('SELECT value FROM settings WHERE key>=? AND key<? ORDER BY key').all(prefix, `${prefix}\uffff`).map(r => JSON.parse(r.value));
const syncDirectory = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

function ensureDirectory(root, relative, create) {
  let path = root;
  for (const part of relative.split('/').filter(Boolean)) {
    path = join(path, part); const info = lstatSync(path, { throwIfNoEntry: false });
    requireValue(!info || info.isDirectory() && !info.isSymbolicLink() && realpathSync(path) === path, 'headless_artifact_path_forbidden', 'Artifact directories must not follow symlinks');
    if (!info && create) mkdirSync(path, { mode: 0o700 });
  }
  return path;
}

function locations(journal, scope, create) {
  requireValue(scope.profile.artifacts, 'headless_artifact_not_authorised', 'Explicit artifact paths required', 403);
  const root = scope.directory;
  requireValue(realpathSync(root) === root && statSync(root).isDirectory(), 'headless_artifact_path_forbidden', 'Canonical workspace required');
  const stat = statSync(root), identity = { directory: root, dev: stat.dev, ino: stat.ino }, key = `headless-artifact-root:${scope.id}`, old = get(journal, key);
  requireValue(!old || canonical(old) === canonical(identity), 'headless_workspace_changed', 'Workspace identity changed');
  let paths = scope.profile.artifacts;
  if (scope.probeName) {
    requireValue(/^[a-f0-9]{64}$/.test(scope.probeName), 'headless_artifact_path_forbidden', 'Invalid internal probe scope');
    const base = `${paths.history}/.readiness/${scope.probeName}`;
    paths = { receipts: `${base}/receipts`, state: `${base}/state.json`, history: `${base}/history`, runs: `${base}/runs`, summaries: `${base}/summaries` };
  }
  const result = {};
  for (const name of ['receipts', 'history', 'runs']) result[name] = ensureDirectory(root, paths[name], create);
  ensureDirectory(root, dirname(paths.state) === '.' ? '' : dirname(paths.state), create); result.state = join(root, paths.state);
  result.summaries = paths.summaries === '/tmp/opencode' ? paths.summaries : ensureDirectory(root, paths.summaries, create);
  if (create && !old) put(journal, key, identity);
  return result;
}

function read(path) {
  const info = lstatSync(path, { throwIfNoEntry: false }); if (!info) return null;
  requireValue(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 262144, 'headless_artifact_file_forbidden', 'Artifact must be a bounded regular file, not a link');
  const raw = readFileSync(path); let value;
  try { value = JSON.parse(raw); } catch { requireValue(false, 'headless_artifact_json_invalid', 'Existing invalid JSON was not overwritten'); }
  return { value, hash: hash(raw), bytes: raw };
}

function legacyInventory(paths, own) {
  if (!existsSync(paths.receipts)) return [];
  const files = readdirSync(paths.receipts).filter(n => n.endsWith('.json')); let size = 0;
  requireValue(files.length <= 10000, 'headless_artifact_inventory_limit', 'Artifact inventory exceeds its explicit completeness bound');
  return files.filter(name => !own.some(r => `${r.document.id}.json` === name)).map(fileName => {
    requireValue(safeName(fileName), 'headless_artifact_path_forbidden', 'Unsupported receipt basename');
    const file = read(join(paths.receipts, fileName)); size += file.bytes.length;
    requireValue(size <= 32 * 1024 * 1024, 'headless_artifact_inventory_limit', 'Legacy inventory exceeds its byte bound');
    return { fileName, sha256: file.hash };
  });
}
const confirmed = r => r.state === 'published' && read(r.path)?.hash === r.hash;

function publish(journal, key, op, paths) {
  const projections = [{ path: op.path, document: op.document, beforeHash: op.beforeHash }, ...(op.summary ? [op.summary] : [])];
  for (const p of projections) { const current = read(p.path); requireValue((current?.hash ?? null) === p.beforeHash || current?.hash === hash(bytes(p.document)), 'headless_artifact_conflict', 'Artifact changed externally; refuse overwriting it'); }
  const history = join(paths.history, `${op.historyName}.json`); read(history); createPrivateJson(history, op.document);
  if (op.legacyBytes) {
    const path = join(paths.history, `legacy-state-${op.beforeHash}.json`);
    if (!existsSync(path)) { writeFileSync(path, Buffer.from(op.legacyBytes, 'base64'), { mode: 0o600, flag: 'wx', flush: true }); syncDirectory(paths.history); }
    else requireValue(read(path)?.hash === op.beforeHash, 'headless_artifact_conflict', 'Legacy backup changed');
  }
  for (const p of projections) { const wanted = hash(bytes(p.document)); if (read(p.path)?.hash !== wanted) writePrivateJson(p.path, p.document); requireValue(read(p.path)?.hash === wanted, 'headless_artifact_readback_failed', 'Durable artifact readback failed'); }
  const result = { ...op.result, projection: 'confirmed', sha256: hash(bytes(op.document)) };
  journal.transaction(() => {
    put(journal, op.entityKey, { document: op.document, path: op.path, hash: result.sha256, state: 'published', ...(op.summary ? { summary: { path: op.summary.path, hash: hash(bytes(op.summary.document)) } } : {}) });
    put(journal, key, { ...op, state: 'published', result });
  });
  return result;
}

function commit(journal, scope, input, paths, build, discriminator = '') {
  requireValue(typeof input.key === 'string' && /^[A-Za-z0-9:_.-]{1,128}$/.test(input.key), 'invalid_headless_artifact', 'Stable artifact operation key required');
  const key = `headless-artifact-op:${scope.id}:${digest([input.key, discriminator])}`, old = get(journal, key), requestHash = digest(input);
  if (old) { requireValue(old.requestHash === requestHash, 'operation_conflict', 'Artifact operation key payload changed'); return old.state === 'published' ? old.result : publish(journal, key, old, paths); }
  const op = { ...build(), requestHash, state: 'intent' };
  journal.transaction(() => { put(journal, key, op); put(journal, op.entityKey, { document: op.document, path: op.path, state: 'intent' }); });
  return publish(journal, key, op, paths);
}

export function headlessArtifactOperation(journal, scope, work, input) {
  requireValue(scope.profile.artifacts && input && typeof input === 'object' && !Array.isArray(input), 'headless_artifact_not_authorised', 'Explicit artifact capability required', 403);
  const allowed = { inventory: ['operation'], read: ['operation', 'id', 'legacyFile', 'revision'], state: ['operation'],
    receipt: ['operation', 'key', 'source', 'action', 'expectedRevision', 'status', 'data', 'legacyRefs'],
    checkpoint: ['operation', 'key', 'expectedRevision', 'data', 'receiptIds', 'observationIds'],
    run: ['operation', 'key', 'expectedRevision', 'status', 'summary', 'details', 'receiptIds'] }[input.operation];
  requireValue(allowed && Object.keys(input).every(k => allowed.includes(k)), 'invalid_headless_artifact', 'Unsupported artifact operation/fields');
  const paths = locations(journal, scope, ['receipt', 'checkpoint', 'run'].includes(input.operation)), prefix = `headless-receipt:${scope.id}:`, stateKey = `headless-checkpoint:${scope.id}`;
  if (input.operation === 'inventory') {
    const own = records(journal, prefix);
    return { receipts: own.map(r => ({ ...r.document, projection: confirmed(r) ? 'confirmed' : r.state === 'intent' ? 'pending' : 'conflict' })), legacyReceipts: legacyInventory(paths, own), complete: true, scope: 'approved_receipt_directory_top_level_json' };
  }
  if (input.operation === 'read') {
    requireValue(Boolean(input.id) !== Boolean(input.legacyFile), 'invalid_headless_artifact', 'Choose an exact managed ID or legacy basename');
    if (input.legacyFile) { requireValue(input.revision === undefined && safeName(input.legacyFile), 'headless_artifact_path_forbidden', 'Only approved-directory JSON basenames are supported'); const value = read(join(paths.receipts, input.legacyFile)); requireValue(value, 'not_found', 'Legacy receipt not found'); return { legacy: true, fileName: input.legacyFile, sha256: value.hash, document: value.value }; }
    requireValue(typeof input.id === 'string' && /^[a-f0-9]{64}$/.test(input.id), 'invalid_headless_artifact', 'Exact receipt ID required');
    const value = get(journal, `${prefix}${input.id}`); requireValue(value, 'not_found', 'Receipt not found');
    if (input.revision !== undefined) {
      requireValue(Number.isSafeInteger(input.revision) && input.revision > 0 && input.revision <= value.document.revision, 'invalid_headless_artifact', 'Existing receipt revision required');
      const historical = read(join(paths.history, `${input.id}-${input.revision}.json`));
      requireValue(historical?.value.setupId === scope.id && historical.value.id === input.id && historical.value.revision === input.revision, 'headless_artifact_history_conflict', 'History identity differs');
      return { ...historical.value, historical: true, sha256: historical.hash };
    }
    return { ...value.document, projection: confirmed(value) ? 'confirmed' : value.state === 'intent' ? 'pending' : 'conflict' };
  }
  const currentState = read(paths.state), stateRecord = get(journal, stateKey), managed = currentState?.value?._relayHeadless;
  if (input.operation === 'state') return { document: currentState?.value ?? {}, revision: managed?.revision ?? 0,
    projection: !stateRecord ? 'not_managed' : stateRecord.state === 'intent' ? 'pending' : currentState?.hash === stateRecord.hash ? 'confirmed' : 'conflict',
    sourceNamespaces: scope.profile.sourceNamespaces, observations: records(journal, `headless-observation:${scope.id}:${work.id}:${work.execution.runId}:`),
    businessPolicy: 'external_job_contract' };
  if (input.operation === 'receipt') {
    headlessSource(scope.profile, input.source);
    requireValue(typeof input.action === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/.test(input.action) && ['pending', 'uncertain', 'blocked', 'failed', 'applied', 'no_change'].includes(input.status) &&
      input.data && typeof input.data === 'object' && !Array.isArray(input.data) && JSON.stringify(input.data).length <= 65536, 'invalid_headless_artifact', 'Bounded structured outcome and source/action required');
    const id = digest([scope.id, input.source.namespace, input.source.externalId, input.action]), entityKey = `${prefix}${id}`;
    return commit(journal, scope, input, paths, () => {
      const previous = get(journal, entityKey), path = join(paths.receipts, `${id}.json`), existing = read(path);
      requireValue(!previous || previous.state === 'published', 'headless_projection_pending', 'Reconcile the original projection first');
      requireValue(input.expectedRevision === (previous?.document.revision ?? 0), 'stale_revision', 'Inspect the receipt revision');
      requireValue(previous ? existing?.hash === previous.hash : !existing, 'headless_artifact_conflict', 'Receipt has external edits or no matching journal');
      const legacyRefs = input.legacyRefs ?? [];
      requireValue(Array.isArray(legacyRefs) && legacyRefs.length <= 32, 'invalid_headless_artifact', 'Bounded legacy references required');
      for (const ref of legacyRefs) requireValue(ref && Object.keys(ref).every(k => ['fileName', 'sha256'].includes(k)) && safeName(ref.fileName) && read(join(paths.receipts, ref.fileName))?.hash === ref.sha256, 'headless_legacy_conflict', 'Legacy receipt changed or escaped approved paths');
      if (input.status === 'applied' && ['task.create', 'task.update', 'comment.create', 'reference.attach'].includes(input.action)) {
        const proof = get(journal, `headless-task-proof:${scope.id}:${input.data.operationId}`);
        requireValue(proof?.state === 'applied' && proof.operation === input.action && proof.source.namespace === input.source.namespace && proof.source.externalId === input.source.externalId, 'headless_outcome_unverified', 'Applied task outcomes require a matching confirmed backend receipt');
      }
      const document = { format, setupId: scope.id, id, revision: input.expectedRevision + 1, source: input.source, action: input.action, status: input.status, data: input.data, legacyRefs,
        executionId: work.id, runId: work.execution.runId, at: new Date().toISOString() };
      return { path, document, entityKey, beforeHash: existing?.hash ?? null, historyName: `${id}-${document.revision}`, result: { id, revision: document.revision, status: document.status } };
    });
  }
  if (input.operation === 'run') {
    requireValue(['complete', 'partial', 'blocked', 'failed'].includes(input.status) && typeof input.summary === 'string' && input.summary.trim() && input.summary.length <= 4000 && input.details && typeof input.details === 'object' && !Array.isArray(input.details) && JSON.stringify(input.details).length <= 65536 && Array.isArray(input.receiptIds) && input.receiptIds.length <= 10000,
      'invalid_headless_artifact', 'Bounded run details and explicit outcome required');
    const info = lstatSync(paths.summaries, { throwIfNoEntry: false });
    requireValue(!info || info.isDirectory() && !info.isSymbolicLink() && realpathSync(paths.summaries) === paths.summaries && info.uid === process.getuid(), 'headless_artifact_path_forbidden', 'Summary directory must be owned by this user and not be a link');
    if (!info) mkdirSync(paths.summaries, { mode: 0o700 });
    const id = digest([scope.id, work.id, work.execution.runId]), entityKey = `headless-run:${scope.id}:${id}`;
    return commit(journal, scope, input, paths, () => {
      const previous = get(journal, entityKey), path = join(paths.runs, `${id}.json`), existing = read(path), summaryPath = join(paths.summaries, `${id}.json`), summary = read(summaryPath);
      requireValue(!previous || previous.state === 'published', 'headless_projection_pending', 'Run projection is pending');
      requireValue(input.expectedRevision === (previous?.document.revision ?? 0), 'stale_revision', 'Inspect the run revision');
      requireValue(previous ? existing?.hash === previous.hash && summary?.hash === previous.summary?.hash : !existing && !summary, 'headless_artifact_conflict', 'Run/summary has external edits or no matching journal');
      requireValue(input.receiptIds.every(receiptId => { const r = get(journal, `${prefix}${receiptId}`); return r && confirmed(r); }), 'headless_receipts_unsettled', 'Run notes can reference only durable receipts');
      const document = { format, setupId: scope.id, id, revision: input.expectedRevision + 1, executionId: work.id, runId: work.execution.runId, status: input.status, summary: input.summary, details: input.details, receiptIds: input.receiptIds, at: new Date().toISOString() };
      return { path, document, entityKey, beforeHash: existing?.hash ?? null, historyName: `run-${id}-${document.revision}`, summary: { path: summaryPath, beforeHash: summary?.hash ?? null, document: { format, executionId: work.id, runId: work.execution.runId, status: input.status, summary: input.summary, revision: document.revision } }, result: { id, revision: document.revision, status: document.status } };
    }, id);
  }
  // A generic durability barrier. Cursor meanings, source coverage, reminder
  // horizons and business completeness are deliberately NOT interpreted here.
  return commit(journal, scope, input, paths, () => {
    const intents = records(journal, 'headless-task-intent:').filter(i => i.setupId === scope.id);
    requireValue(intents.every(i => { const r = journal.receipt(i.commandKey); return r?.state === 'recorded' || r?.state === 'superseded' && r.outcome === 'refused'; }), 'headless_operations_unsettled', 'Uncertain task operations prevent checkpoint commit');
    requireValue(input.data && typeof input.data === 'object' && !Array.isArray(input.data) && JSON.stringify(input.data).length <= 65536 && Array.isArray(input.receiptIds) && input.receiptIds.length <= 10000, 'invalid_headless_artifact', 'Structured job-defined checkpoint and receipt dependencies required');
    requireValue(!stateRecord || stateRecord.state === 'published', 'headless_projection_pending', 'Checkpoint projection is pending');
    requireValue(!currentState || currentState.value && typeof currentState.value === 'object' && !Array.isArray(currentState.value), 'headless_artifact_json_invalid', 'Existing state object was not overwritten');
    requireValue(!managed || managed.format === format && managed.setupId === scope.id && stateRecord, 'headless_state_recovery_required', 'Managed state requires its original matching journal');
    requireValue(!stateRecord || currentState?.hash === stateRecord.hash, 'headless_artifact_conflict', 'State was edited outside the service');
    requireValue(input.expectedRevision === (managed?.revision ?? 0), 'stale_revision', 'Inspect the current checkpoint revision');
    const all = records(journal, prefix);
    requireValue(all.every(r => confirmed(r) && settled(r.document)), 'headless_receipts_unsettled', 'Unknown, unpublished or edited outcomes prevent checkpoint commit');
    requireValue(legacyInventory(paths, all).every(ref => all.some(r => settled(r.document) && r.document.legacyRefs.some(old => old.fileName === ref.fileName && old.sha256 === ref.sha256))), 'headless_legacy_unreconciled', 'Legacy receipts must be explicitly reconciled without rewriting them');
    requireValue(input.receiptIds.every(id => all.some(r => r.document.id === id)) && all.filter(r => r.document.executionId === work.id && r.document.runId === work.execution.runId).every(r => input.receiptIds.includes(r.document.id)), 'headless_receipts_unsettled', 'Include every durable outcome written in this run');
    const observations = input.observationIds ?? [];
    requireValue(Array.isArray(observations) && observations.length <= 1000 && observations.every(id => get(journal, `headless-observation:${scope.id}:${work.id}:${work.execution.runId}:${id}`)), 'headless_observation_unverified', 'Only confirmed observations from this run may be referenced');
    const document = { ...(currentState?.value ?? {}), _relayHeadless: { format, setupId: scope.id, revision: input.expectedRevision + 1, data: input.data, receiptIds: input.receiptIds, observationIds: observations, executionId: work.id, runId: work.execution.runId, at: new Date().toISOString() } };
    return { path: paths.state, document, entityKey: stateKey, beforeHash: currentState?.hash ?? null, legacyBytes: currentState && !managed ? currentState.bytes.toString('base64') : null, historyName: `checkpoint-${document._relayHeadless.revision}`, result: { revision: document._relayHeadless.revision, businessPolicy: 'external_job_contract' } };
  });
}

export function recordHeadlessObservation(journal, scope, work, { id, namespace, inputDigest, outputDigest }) {
  requireValue(typeof id === 'string' && id.trim() && id.length <= 256 && !/[\x00-\x1f]/.test(id) && scope.profile.sourceNamespaces.includes(namespace) && /^[a-f0-9]{64}$/.test(inputDigest) && /^[a-f0-9]{64}$/.test(outputDigest), 'invalid_headless_observation', 'Exact call, source and digests required');
  const key = `headless-observation:${scope.id}:${work.id}:${work.execution.runId}:${id}`, observation = { id, namespace, inputDigest, outputDigest, confirmed: true }, old = get(journal, key);
  requireValue(!old || canonical(old) === canonical(observation), 'operation_conflict', 'Observation identity changed');
  put(journal, key, observation); return observation;
}

export function probeHeadlessArtifacts(journal, scope, work) {
  if (!scope.profile.artifacts) return { granted: false, digest: digest({ granted: false }) };
  const key = `headless-artifact-probe:${scope.id}:${work.id}:${work.execution.runId}`, previous = get(journal, key);
  if (previous?.complete) return previous.proof;
  const probe = { ...scope, id: `headless-probe:${digest([scope.id, work.id, work.execution.runId])}`, probeName: digest([work.id, work.execution.runId]) };
  const common = { source: { namespace: scope.profile.sourceNamespaces[0], externalId: `__relay_probe__${digest(work.id)}` }, action: 'capability', data: { canary: true } };
  const pending = headlessArtifactOperation(journal, probe, work, { ...common, operation: 'receipt', key: 'probe-pending', expectedRevision: 0, status: 'pending' });
  const checkpoint = { operation: 'checkpoint', key: 'probe-checkpoint', expectedRevision: 0, data: { canary: true }, receiptIds: [pending.id] };
  if (!get(journal, key)?.guarded) {
    let guarded = false; try { headlessArtifactOperation(journal, probe, work, { ...checkpoint, key: 'probe-guard' }); } catch (e) { guarded = e.code === 'headless_receipts_unsettled'; }
    requireValue(guarded, 'headless_probe_failed', 'Uncertain outcomes must block checkpoint commit'); put(journal, key, { guarded: true });
  }
  const applied = headlessArtifactOperation(journal, probe, work, { ...common, operation: 'receipt', key: 'probe-applied', expectedRevision: pending.revision, status: 'applied' });
  const paths = locations(journal, probe, true); if (!existsSync(paths.state)) writePrivateJson(paths.state, { legacyMarker: 'preserved' });
  const saved = headlessArtifactOperation(journal, probe, work, checkpoint);
  requireValue(saved.revision === 1 && read(paths.state)?.value.legacyMarker === 'preserved' && headlessArtifactOperation(journal, probe, work, { operation: 'read', id: applied.id }).projection === 'confirmed', 'headless_probe_failed', 'Artifact/checkpoint round trip failed');
  headlessArtifactOperation(journal, probe, work, { operation: 'run', key: 'probe-run', expectedRevision: 0, status: 'complete', summary: 'Artifact capability canary only; not job completion.', details: { canary: true }, receiptIds: [applied.id] });
  const value = { granted: true, durableReceipt: true, history: true, checkpointGuard: true, legacyStatePreserved: true, runSummary: true }, proof = { ...value, digest: digest(value) };
  put(journal, key, { complete: true, proof }); return proof;
}
