import assert from 'node:assert/strict';
import test from 'node:test';
import { paperclipTasksProvider } from '../src/paperclip-provider.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ProviderJournal } from '../src/provider-journal.mjs';

test('Paperclip task compatibility has no heartbeat dependency and fences stale writes', async () => {
  const db = new DatabaseSync(':memory:');
  let issue = { id: 'task', companyId: 'company', title: 'Task', status: 'todo', priority: 'medium', description: '' };
  const calls = [];
  const provider = paperclipTasksProvider(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.includes('audit/')) return { accessTier: 'full' };
    if (path.includes('/companies/') && method === 'GET') return [issue];
    if (method === 'PATCH') issue = { ...issue, ...body };
    return issue;
  }, { companyId: 'company', journal: new ProviderJournal(db, 'paperclip:company') });
  const task = await provider.getTask('task');
  assert.equal((await provider.updateTask(task.id, { status: 'in_progress' }, { expectedRevision: task.revision, key: 'update' })).status, 'in_progress');
  await assert.rejects(provider.updateTask(task.id, { title: 'Stale' }, { expectedRevision: task.revision, key: 'stale' }), { code: 'stale_revision' });
  assert.equal((await provider.listTasks()).complete, true);
  assert.ok(calls.every(call => !call.path.includes('/heartbeat') && !call.path.includes('/agents')));
  db.close();
});
