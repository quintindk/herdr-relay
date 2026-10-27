import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { readPrivateJson, writePrivateJson } from './private-files.mjs';
import { nativeBackendClient } from './backend-client.mjs';
import { NodeJournal } from './node-journal.mjs';
import { definitivePublicationRefusal } from './publication-outcomes.mjs';
import { defaultNodeConfig } from './native-onboarding.mjs';
import { serviceLock } from './service-lock.mjs';
import { upgradeDirectory } from './service-upgrade.mjs';

const terminal = ['completed', 'cancelled', 'failed', 'rejected'];
const revisionFencedActions = new Set(['execution.admit', 'execution.continue', 'execution.submit', 'execution.wait_children', 'execution.delay', 'question.ask']);
function view(path, config) {
  requireValue(existsSync(path), 'recovery_state_missing', 'Existing node journal required');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    requireValue(db.prepare('PRAGMA user_version').get().user_version === 1, 'unsupported_schema', 'Unsupported node journal schema');
    const identity = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='identity'").get().value);
    requireValue(identity.nodeId === config.nodeId && identity.instanceId, 'node_identity_mismatch', 'Node configuration and journal must match');
    return { db, identity, work: id => { const row = db.prepare('SELECT data FROM work WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; } };
  } catch (error) { db.close(); throw error; }
}

export function recoveryInventory(journal) {
  return { complete: true, work: journal.db.prepare("SELECT id,state,data FROM work WHERE state NOT IN ('settled','native_finished','settled_waiting','pending')").all().map(row => {
    const w = JSON.parse(row.data); return { id: row.id, state: row.state, backendStateCached: w.execution?.state,
      invocationMessageId: w.invocation?.messageId ?? null, observationReason: w.observation?.reason ?? null,
      disposition: w.administrativeDisposition?.kind ?? null };
  }), publications: journal.db.prepare("SELECT key,hash,state,data FROM outbox WHERE state NOT IN ('recorded','superseded','administratively_abandoned')").all().map(row => {
    const item = JSON.parse(row.data); return { key: row.key, state: row.state, action: item.command?.action, error: item.error,
      outcome: item.outcome ?? null, definitivelyRejected: Boolean(definitivePublicationRefusal(row)) };
  }) };
}

async function workProof(journal, id, api, nodeId) {
  const work = journal.work(id);
  requireValue(work, 'not_found', 'Unknown local work');
  let execution;
  try { execution = await api('GET', `/v1/executions/${encodeURIComponent(id)}`); }
  catch (error) { if (error.status !== 404 || !work.execution.localOccurrence) throw error; }
  if (execution) {
    requireValue(execution.targetNodeId === nodeId && terminal.includes(execution.state) && execution.revision >= work.execution.revision &&
      (!work.invocation || execution.runId === work.execution.runId && execution.bindingId === work.bindingId),
    'recovery_ineligible', 'Withdraw the active backend assignment with native execution handback, or inspect mismatched run/binding evidence first');
    return { executionId: id, nodeId, terminalBackend: true, backendState: execution.state, backendRevision: execution.revision,
      cancellationRequested: execution.cancellationRequested };
  }
  const row = journal.db.prepare('SELECT data FROM occurrences WHERE id=?').get(id);
  requireValue(row, 'recovery_ineligible', 'Local-only occurrence evidence missing');
  const occurrence = JSON.parse(row.data), schedule = await api('GET', `/v1/schedules/${encodeURIComponent(occurrence.scheduleId)}`);
  requireValue(schedule.cancelled === true && schedule.definition.enabled === false && schedule.definition.nodeId === nodeId &&
    schedule.definition.targetAgentId === work.execution.targetAgentId,
  'recovery_ineligible', 'A local-only occurrence requires its exact cancelled schedule before administrative abandonment');
  return { executionId: id, nodeId, terminalBackend: false, cancelledLocalSchedule: true, backendExecutionAbsent: true,
    scheduleId: schedule.id, scheduleRevision: schedule.revision, scheduleCancelled: true };
}

export async function nodeRecovery(input, dependencies = {}) {
  const configFile = resolve(input.configFile ?? defaultNodeConfig()), config = readPrivateJson(configFile);
  requireValue(config.identityVersion === 2 && config.nodeId && resolve(config.stateDirectory) === config.stateDirectory,
    'recovery_ineligible', 'Existing stable local node configuration required');
  const database = join(config.stateDirectory, 'node.sqlite'), journal = view(database, config);
  const root = resolve(input.directory ?? upgradeDirectory());
  let unlock;
  try {
    if (input.kind === 'list') return recoveryInventory(journal);
    requireValue(['work', 'publication'].includes(input.kind) && typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 512 &&
      typeof input.key === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(input.key) && typeof input.reason === 'string' && input.reason.trim() && input.reason.length <= 2000,
    'invalid_request', 'Exact work/publication, immutable key and bounded reason required');
    const operation = join(root, 'recoveries', `recovery_${digest([config.nodeId, input.key])}`), headerPath = join(operation, 'request.json');
    const inputHash = digest({ configFile, kind: input.kind, id: input.id, key: input.key, reason: input.reason, previewHash: input.previewHash ?? null });
    if (input.apply) {
      mkdirSync(root, { recursive: true, mode: 0o700 }); unlock = serviceLock(root);
      const operations = join(root, 'operations');
      requireValue(!existsSync(operations) || !readdirSync(operations).some(name => {
        const path = join(operations, name, 'operation.json');
        return existsSync(path) && !['committed', 'rolled_back'].includes(readPrivateJson(path).phase);
      }), 'upgrade_in_progress', 'Finish or reconcile the existing service upgrade before changing local recovery records');
      if (existsSync(headerPath)) {
        requireValue(readPrivateJson(headerPath).inputHash === inputHash, 'operation_conflict', 'Recovery key belongs to another preview');
        const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`recovery:${digest(input.key)}`);
        if (row) return { ...JSON.parse(row.value).receipt, replayed: true };
      }
    }
    let record, proof;
    if (input.kind === 'publication') {
      const row = journal.db.prepare('SELECT key,hash,state,data FROM outbox WHERE key=?').get(input.id);
      requireValue(row, 'not_found', 'Unknown local publication');
      record = JSON.parse(row.data); proof = definitivePublicationRefusal(row);
      if (!proof && revisionFencedActions.has(record.command?.action) && row.hash === digest(record.command) && !record.receipt &&
        record.applied !== true && Number.isSafeInteger(record.command.payload?.expectedRevision)) {
        const api = dependencies.api ?? nativeBackendClient(config.backend), info = await api('GET', '/v1/info');
        requireValue(info.instanceId === journal.identity.instanceId && info.protocol === 'relay/0.2', 'backend_identity_mismatch', 'Pinned backend required');
        const executionId = record.command.payload.executionId ?? record.command.payload.id;
        const observed = await api('GET', `/v1/command-receipts/${encodeURIComponent(input.id)}?executionId=${encodeURIComponent(executionId)}`);
        if (observed.state === 'absent' && observed.execution?.targetNodeId === config.nodeId && observed.execution.id === executionId &&
          observed.execution.revision !== record.command.payload.expectedRevision)
          proof = { kind: 'backend_revision_fence', nodeId: config.nodeId, executionId, commandHash: row.hash, receiptAbsent: true,
            expectedRevision: record.command.payload.expectedRevision, currentRevision: observed.execution.revision };
      }
      requireValue(proof, 'publication_ineligible', 'This is not a proven transactional validation refusal. Uncertain outcomes, operation-key collisions and revision conflicts require reconciliation, not abandonment');
    } else {
      const api = dependencies.api ?? nativeBackendClient(config.backend);
      const info = await api('GET', '/v1/info');
      requireValue(info.instanceId === journal.identity.instanceId && info.protocol === 'relay/0.2', 'backend_identity_mismatch', 'Pinned backend identity required for work recovery');
      record = journal.work(input.id); proof = await workProof(journal, input.id, api, config.nodeId);
    }
    const recordDigest = digest(record), previewHash = digest({ kind: input.kind, id: input.id, key: input.key, reason: input.reason, recordDigest, proof });
    const preview = { state: 'recovery_preview', kind: input.kind, id: input.id, key: input.key, reason: input.reason, previewHash, recordDigest, proof,
      originalState: record.state, invocationMessageId: record.invocation?.messageId ?? null,
      nativeSettlementClaimed: false, nativeProcessTerminationClaimed: false, successfulCompletionClaimed: false,
      warning: 'Administrative abandonment prevents Relay replay. It does not stop native processes or undo effects already dispatched.' };
    if (!input.apply) return preview;
    requireValue(input.previewHash === previewHash, 'stale_recovery_preview', 'Exact unchanged recovery preview required');
    mkdirSync(operation, { recursive: true, mode: 0o700 });
    if (!existsSync(headerPath)) writePrivateJson(headerPath, { inputHash, preview });
    const backup = join(operation, 'node-before.sqlite');
    if (!existsSync(backup)) { await (dependencies.backup ?? sqliteBackup)(journal.db, backup); chmodSync(backup, 0o600); }
    const checked = new DatabaseSync(backup, { readOnly: true });
    try { requireValue(checked.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'recovery_backup_invalid', 'Recovery backup integrity check failed'); }
    finally { checked.close(); }
    if (input.kind === 'work') {
      const api = dependencies.api ?? nativeBackendClient(config.backend);
      requireValue(digest(await workProof(journal, input.id, api, config.nodeId)) === digest(proof), 'stale_recovery_preview', 'Backend ownership changed during backup; inspect it again');
    }
    const writable = new NodeJournal(database, { nodeId: config.nodeId, instanceId: journal.identity.instanceId });
    try {
      const options = { key: input.key, reason: input.reason, expectedDigest: recordDigest, proof, backup,
        actor: `local_operator:os-user-${process.getuid?.() ?? 'unknown'}` };
      const receipt = input.kind === 'work' ? writable.abandonWork(input.id, options) : writable.abandonPublication(input.id, options);
      writePrivateJson(join(operation, 'receipt.json'), receipt);
      return { ...receipt, replayed: false };
    } finally { writable.close(); }
  } finally { journal.db.close(); unlock?.(); }
}
