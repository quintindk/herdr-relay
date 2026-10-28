import { provisionWorktree, finaliseWorktree, retireWorktree } from './resources.mjs';
import { requireValue } from './protocol.mjs';

// Adapt the existing verified Git resource machinery to native node receipts.
// It retains native identities and never infers acceptance from status alone.
export function nodeResourceStore(journal) {
  journal.db.exec('CREATE TABLE IF NOT EXISTS resource_operations(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const run = work => ({ id: work.execution.runId, request: { bindingId: work.bindingId, taskId: work.execution.taskId },
    nativeState: ['native_finished', 'settled', 'settled_waiting'].includes(work.state) ? 'settled' : 'claimed',
    settlement: { outcome: work.observation?.outcome === 'succeeded' ? 'completed' : work.observation?.outcome },
    result: work.staged?.kind === 'result' ? work.staged.payload : work.execution.result });
  return {
    operation(id) { const row = journal.db.prepare('SELECT data FROM resource_operations WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; },
    saveOperation(operation) {
      journal.db.prepare('INSERT INTO resource_operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run(operation.id, JSON.stringify(operation)); return operation;
    },
    binding(id) { requireValue(journal.works().some(work => work.bindingId === id), 'binding_not_found', 'Known local binding required'); return { id }; },
    run(id) {
      const work = journal.works().find(work => work.execution.runId === id);
      requireValue(work, 'run_not_found', 'Exact local run required'); return run(work);
    },
    runs(bindingId) { return journal.works().filter(work => !bindingId || work.bindingId === bindingId).map(run); },
  };
}

export const provisionNodeWorktree = (journal, input) => provisionWorktree(nodeResourceStore(journal), input, { pendingBinding: true });
export const finaliseNodeWorktree = (journal, input) => finaliseWorktree(nodeResourceStore(journal), input);
export const retireNodeWorktree = (journal, api, input) => retireWorktree(nodeResourceStore(journal), input, async run => {
  const work = journal.works().find(work => work.execution.runId === run.id);
  const e = await api('GET', `/v1/executions/${encodeURIComponent(work.id)}`);
  requireValue(e.state === 'completed' && e.result?.candidate === input.candidate &&
    e.runId === run.id &&
    (e.reviewPolicy === 'none' || e.review?.decision === 'accept' && e.review.resultDigest === e.result.digest),
    'acceptance_required', 'Current native execution must confirm exact accepted candidate');
});
