import assert from 'node:assert/strict';
import test from 'node:test';
import { githubTasksProvider, nativeTasksProvider } from '../src/tasks-provider.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ProviderJournal } from '../src/provider-journal.mjs';

test('native task provider preserves revisions, relationships and scoped traversal', async () => {
  const store = new BackendStore(':memory:');
  const owner = store.authenticate(store.bootstrap().token);
  const api = async (method, path, body) => {
    if (method === 'POST') return store.command(owner, body);
    const url = new URL(path, 'http://backend');
    if (/\/tasks\//.test(path)) return store.get('task', path.split('/').at(-1));
    return store.query('task', Object.fromEntries(url.searchParams));
  };
  try {
    const provider = nativeTasksProvider(api);
    const task = await provider.createTask({ id: 'task', title: 'Task' }, { key: 'create' });
    const changed = await provider.updateTask(task.id, { status: 'in_progress' }, { key: 'edit', expectedRevision: task.revision });
    assert.equal(changed.revision, 2);
    assert.deepEqual(await provider.listRelations(task.id), { parentId: null, dependencies: [] });
    assert.equal((await provider.listTasks()).items.length, 1);
  } finally { store.close(); }
});

test('GitHub maps status/priority while preserving unrelated labels and rejecting stale writes', async () => {
  const db = new DatabaseSync(':memory:');
  const issue = { id: 100, number: 1, html_url: 'https://github.com/o/r/issues/1', title: 'Issue', body: 'Text', state: 'open',
    updated_at: 'revision-1', labels: [{ name: 'customer' }, { name: 'relay:status:todo' }], assignees: [] };
  const calls = [];
  const provider = githubTasksProvider(async (method, path, body) => {
    calls.push({ method, path, body });
    return method === 'PATCH' ? { ...issue, ...body, updated_at: 'revision-2' } : issue;
  }, { owner: 'o', repo: 'r', journal: new ProviderJournal(db, 'github:o/r') });
  const changed = await provider.updateTask('1', { status: 'blocked', priority: 'high' }, { expectedRevision: 'revision-1', key: 'update' });
  assert.equal(changed.status, 'blocked');
  assert.deepEqual(calls[1].body.labels, ['customer', 'relay:status:blocked', 'relay:priority:high']);
  await assert.rejects(provider.updateTask('1', { title: 'Changed' }, { expectedRevision: 'stale', key: 'stale' }), { code: 'stale_revision' });
  assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
  assert.equal(provider.describeCapabilities().collaboration, false);
  await assert.rejects(provider.createTask(), { code: 'invalid_request' });
  db.close();
});
