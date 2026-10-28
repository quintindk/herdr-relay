import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeTasksProvider } from '../src/tasks-provider.mjs';
import { BackendStore } from '../src/backend-store.mjs';

test('native task adapter preserves revisions, relationships and scoped traversal', async () => {
  const store = new BackendStore(':memory:'), owner = store.authenticate(store.bootstrap().token);
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
    assert.equal(provider.describeCapabilities().conditionalWrites, 'atomic');
  } finally { store.close(); }
});
