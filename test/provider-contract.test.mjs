import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendStore } from '../src/backend-store.mjs';
import { nativeTasksProvider, githubTasksProvider } from '../src/tasks-provider.mjs';
import { paperclipTasksProvider } from '../src/paperclip-provider.mjs';

for (const kind of ['native', 'paperclip', 'github']) {
  test(`${kind} task provider exposes stable identity, content, status and explicit traversal completeness`, async () => {
    let store;
    let provider;
    const task = { id: 'task', companyId: 'company', title: 'Task', description: 'Full body', status: 'todo', priority: 'medium' };
    if (kind === 'native') {
      store = new BackendStore(':memory:');
      const actor = store.authenticate(store.bootstrap().token);
      store.command(actor, { key: 'task', action: 'task.create', payload: { id: task.id, title: task.title, description: task.description } });
      provider = nativeTasksProvider(async (_method, path) => path.includes('/tasks/') ? store.get('task', 'task') : store.query('task'));
    } else if (kind === 'paperclip') provider = paperclipTasksProvider(async (_method, path) =>
      path.includes('audit/') ? { accessTier: 'full' } : path.includes('/companies/') ? [task] : task, { companyId: 'company' });
    else provider = githubTasksProvider(async (_method, path) => {
      const issue = { id: 10, number: 1, title: task.title, body: task.description, state: 'open', labels: [], assignees: [], updated_at: 'r1' };
      return path.endsWith('/issues/1') ? issue : [issue];
    }, { owner: 'o', repo: 'r' });
    try {
      const item = await provider.getTask(kind === 'github' ? '1' : task.id);
      assert.equal(item.title, task.title);
      assert.equal(item.description, task.description);
      assert.equal(item.status, task.status);
      assert.ok(item.revision);
      const page = await provider.listTasks();
      assert.equal(page.items[0].id, item.id);
      assert.equal(page.complete, true);
      assert.equal(page.nextCursor, null);
      assert.equal(provider.describeCapabilities().tasks, true);
    } finally { store?.close(); }
  });
}
