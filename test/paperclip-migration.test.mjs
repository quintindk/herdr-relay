import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { migrationDigest, planPaperclipImport, importPaperclipTasks, exportPaperclipTasks } from '../src/paperclip-migration.mjs';

function bundle() {
  const task = (id, extra = {}) => ({ task: { id, companyId: 'company', title: id, description: 'Full body', status: 'todo', priority: 'high',
    createdAt: '2026-01-01T00:00:00Z', labels: [{ id: 'label', name: 'Customer work' }], ...extra }, dependencies: [], comments: [], interactions: [] });
  const root = task('parent', { status: 'done' }), child = task('child', { parentId: 'parent', assigneeAgentId: 'legacy-agent', projectId: 'project' });
  child.dependencies = ['parent'];
  child.comments = [{ id: 'comment', companyId: 'company', issueId: 'child', body: 'Original comment', authorUserId: 'legacy-human', createdAt: '2026-01-01T00:00:00Z' }];
  child.interactions = [{ id: 'history', kind: 'question', status: 'answered', body: 'History', result: { body: 'Answer' } }];
  const result = { format: 'relay-paperclip-tasks/1', source: { provider: 'paperclip', url: 'http://127.0.0.1:3100', companyId: 'company' },
    exportedAt: '2026-10-20T00:00:00Z', coverage: { schedules: 'not_exported', localRelayState: 'not_exported' }, tasks: [child, root] };
  return { ...result, digest: migrationDigest(result) };
}

test('migration atomically preserves tasks, graphs, historical attribution and immutable source mappings without executing work', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token), input = bundle();
  const plan = planPaperclipImport(input);
  assert.equal(plan.ready, true);
  const receipt = importPaperclipTasks(store, owner, input);
  const child = store.get('task', receipt.mappings.child);
  assert.equal(child.parentId, receipt.mappings.parent);
  assert.deepEqual(child.dependencies, [receipt.mappings.parent]);
  assert.equal(child.source.metadata.assigneeAgentId, 'legacy-agent');
  assert.equal(child.source.interactions[0].status, 'answered');
  const comment = store.all('comment')[0];
  assert.equal(comment.author.type, 'external');
  assert.equal(comment.author.userId, 'legacy-human');
  assert.equal(comment.source.createdAt, '2026-01-01T00:00:00Z');
  assert.equal(store.all('execution').length, 0);
  assert.equal(store.all('schedule').length, 0);
  const count = store.events({ limit: 500 }).items.length;
  store.command(owner, { key: 'edit', action: 'task.update', payload: { id: child.id, expectedRevision: child.revision, changes: { title: 'Native edit' } } });
  assert.deepEqual(importPaperclipTasks(store, owner, input), receipt);
  assert.equal(store.get('task', child.id).title, 'Native edit');
  assert.equal(store.events({ limit: 500 }).items.length, count + 1);
});

test('migration refuses source obligations, changed exports, incomplete graphs and foreign comments without partial writes', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  for (const change of [b => { b.tasks[0].task.executionRunId = 'running'; }, b => { b.tasks[0].interactions[0].status = 'pending'; }]) {
    const input = bundle(); change(input); input.digest = migrationDigest(input);
    assert.equal(planPaperclipImport(input).ready, false);
    assert.throws(() => importPaperclipTasks(store, owner, input), { code: 'migration_blocked' });
  }
  const foreign = bundle(); foreign.tasks[0].comments[0].companyId = 'other'; foreign.digest = migrationDigest(foreign);
  assert.throws(() => importPaperclipTasks(store, owner, foreign), { code: 'invalid_migration' });
  assert.equal(store.all('task').length, 0);
  assert.equal(store.events().items.length, 0);
  const incomplete = bundle(); incomplete.tasks.pop(); incomplete.digest = migrationDigest(incomplete);
  assert.throws(() => planPaperclipImport(incomplete), { code: 'incomplete_graph' });
  const original = bundle(); importPaperclipTasks(store, owner, original);
  const changed = bundle(); changed.tasks[0].task.title = 'Changed'; changed.digest = migrationDigest(changed);
  assert.throws(() => importPaperclipTasks(store, owner, changed), { code: 'migration_conflict' });
  assert.throws(() => planPaperclipImport({ ...original, exportedAt: 'tampered' }), { code: 'invalid_migration' });
});

test('read-only export traverses company tasks and strips runtime configuration while retaining full task/comment text', async () => {
  const taskId = '00000000-0000-4000-8000-000000000001';
  const task = { id: taskId, companyId: 'company', title: 'Task', description: 'Full text', status: 'todo', priority: 'medium',
    adapterConfig: { secret: 'never-export' } };
  const api = async (method, path) => {
    assert.equal(method, 'GET');
    if (path.includes('/audit/')) return { accessTier: 'full', items: [] };
    if (path.includes('/comments?')) return [];
    if (path.endsWith('/interactions')) return [];
    if (path.startsWith('/api/companies/')) return [task];
    return task;
  };
  const result = await exportPaperclipTasks(api, { sourceUrl: 'http://127.0.0.1:3100', companyId: 'company' });
  assert.equal(result.tasks[0].task.description, 'Full text');
  assert.equal(JSON.stringify(result).includes('never-export'), false);
  assert.equal(planPaperclipImport(result).ready, true);
});

test('migration cannot use a node credential and cycles never reach native writes', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  store.command(owner, { key: 'node', action: 'node.enrol', payload: { id: 'node', name: 'Node' } });
  const node = store.authenticate(store.enrolCredential(owner, 'node', 'credential').token);
  assert.throws(() => importPaperclipTasks(store, node, bundle()), { code: 'forbidden' });
  const cyclic = bundle(); cyclic.tasks[1].task.parentId = 'child'; cyclic.digest = migrationDigest(cyclic);
  assert.throws(() => planPaperclipImport(cyclic), { code: 'invalid_graph' });
  assert.equal(store.all('task').length, 0);
});

test('parent waiting on child imports both graphs without a false combined cycle', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token);
  const input = bundle();
  input.tasks[0].dependencies = [];
  input.tasks[1].task.status = 'blocked';
  input.tasks[1].dependencies = ['child'];
  input.digest = migrationDigest(input);
  assert.equal(planPaperclipImport(input).ready, true);
  const receipt = importPaperclipTasks(store, owner, input);
  assert.deepEqual(store.get('task', receipt.mappings.parent).dependencies, [receipt.mappings.child]);
  assert.equal(store.get('task', receipt.mappings.child).parentId, receipt.mappings.parent);
});

test('empty review attention and expired interactions are historical while real attention and active work still block', () => {
  for (const attention of [{}, [], null, false, { state: 'none', paths: [], reason: null }]) {
    const input = bundle();
    input.tasks[0].task.reviewAttention = attention;
    input.tasks[0].interactions[0].status = 'expired';
    input.digest = migrationDigest(input);
    assert.equal(planPaperclipImport(input).ready, true);
  }
  for (const value of [{ pending: true }, ['review'], { status: 'pending' },
    { state: 'pending', paths: [], reason: null }, { state: 'none', paths: ['candidate'], reason: null },
    { state: 'none', paths: [], reason: 'Requires review' }, { state: 'none', paths: [], reason: null, pending: true },
    { state: 'none', paths: null, reason: null }]) {
    const input = bundle(); input.tasks[0].task.reviewAttention = value; input.digest = migrationDigest(input);
    assert.equal(planPaperclipImport(input).blockers[0].field, 'reviewAttention');
  }
  const input = bundle(); input.tasks[0].task.status = 'in_progress'; input.tasks[0].task.executionBlocker = { reason: 'recovery' };
  input.digest = migrationDigest(input);
  const plan = planPaperclipImport(input);
  assert.equal(plan.ready, true);
  assert.equal(plan.dispositions[0].toStatus, 'todo');
  assert.deepEqual(plan.dispositions[0].retiredExecutionFields, ['executionBlocker']);
});

test('true dependency cycles are rejected independently of parentage', () => {
  const input = bundle(); input.tasks[1].dependencies = ['child']; input.digest = migrationDigest(input);
  assert.throws(() => planPaperclipImport(input), { code: 'invalid_graph' });
});

test('explicit human-work disposition imports todo for the owner and preserves original progress as history', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token), input = bundle();
  input.tasks[0].task.status = 'in_progress';
  input.digest = migrationDigest(input);
  const plan = planPaperclipImport(input);
  assert.equal(plan.ready, true);
  assert.equal(plan.dispositions.length, 1);
  const receipt = importPaperclipTasks(store, owner, input);
  const task = store.get('task', receipt.mappings.child);
  assert.equal(task.status, 'todo');
  assert.equal(task.responsibleUserId, owner.id);
  assert.equal(task.source.metadata.status, 'in_progress');
  assert.equal(task.source.metadata.assigneeAgentId, 'legacy-agent');
  assert.equal(task.migrationDisposition.authorisedBy, owner.id);
  assert.equal(receipt.dispositionDigest, plan.dispositionDigest);
  assert.equal(store.all('execution').length, 0);
  assert.deepEqual(importPaperclipTasks(store, owner, input), receipt);
});

test('personal board migration archives recovery metadata but never clears active runs or pending reviews', () => {
  const input = bundle();
  input.tasks[0].task.status = 'in_progress';
  input.tasks[0].task.executionBlocker = { reason: 'recovery' };
  input.tasks[0].task.executionRunId = 'active-run';
  input.tasks[0].interactions[0].status = 'pending';
  input.digest = migrationDigest(input);
  const plan = planPaperclipImport(input);
  assert.equal(plan.ready, false);
  assert.equal(plan.blockers.some(item => item.field === 'status'), false);
  assert.equal(plan.blockers.some(item => item.field === 'executionBlocker'), false);
  assert.equal(plan.blockers.some(item => item.field === 'executionRunId'), true);
  assert.equal(plan.blockers.some(item => item.field === 'interactions'), true);
});

test('default import retains recovery evidence without creating native execution obligations', t => {
  const store = new BackendStore(':memory:');
  t.after(() => store.close());
  const owner = store.authenticate(store.bootstrap().token), input = bundle();
  input.tasks[0].task.executionBlocker = { reason: 'legacy-recovery', runId: 'historical' };
  input.tasks[0].task.executionState = 'recovery_required';
  input.digest = migrationDigest(input);
  const receipt = importPaperclipTasks(store, owner, input);
  const task = store.get('task', receipt.mappings.child);
  assert.equal(task.responsibleUserId, owner.id);
  assert.equal(task.executionBlocker, undefined);
  assert.deepEqual(task.source.metadata.executionBlocker, input.tasks[0].task.executionBlocker);
  assert.deepEqual(task.migrationDisposition.retiredExecutionFields, ['executionBlocker', 'executionState']);
  assert.equal(store.all('execution').length, 0);
});
