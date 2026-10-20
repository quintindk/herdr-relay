import assert from 'node:assert/strict';
import test from 'node:test';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { nativeBoard } from '../src/native-board.mjs';

test('native board traverses collections and updates status through current backend revisions', async () => {
  const backend = await startBackend({ database: ':memory:' });
  try {
    const api = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
    await api('POST', '/v1/commands', { key: 'create', action: 'task.create', payload: { id: 'task', title: 'Task' } });
    const board = nativeBoard(api);
    assert.equal((await board.read()).tasks[0].companyId, 'native');
    const inspected = await board.inspectTask({ taskId: 'task' });
    const changed = await board.statusTask({ taskId: 'task', expectedRevision: inspected.revision, key: 'edit', payload: { status: 'in_progress' } });
    assert.equal(changed.state, 'recorded');
    assert.equal(changed.outcome.confirmed, true);
    assert.equal((await board.detailTask({ taskId: 'task' })).task.status, 'in_progress');
    await board.statusTask({ taskId: 'task', expectedRevision: changed.revision, key: 'comment', payload: { status: 'done', comment: 'Checked' } });
    assert.equal((await board.detailTask({ taskId: 'task' })).comments[0].body, 'Checked');
  } finally { await backend.close(); }
});
