import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { startBackend } from '../src/backend-service.mjs';
import { nativeBackendClient } from '../src/backend-client.mjs';

test('local event effects and checkpoint survive restart and repeated events do not duplicate work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-node-'));
  const path = join(dir, 'node.sqlite');
  const identity = { nodeId: 'server', instanceId: 'backend' };
  const event = { id: 'event', type: 'execution.request', entityId: 'execution', revision: 1,
    data: { id: 'execution', targetNodeId: 'server', revision: 1 } };
  let journal = new NodeJournal(path, identity);
  try {
    journal.consume({ items: [event], cursor: 'cursor-1' });
    journal.close(); journal = new NodeJournal(path, identity);
    journal.consume({ items: [event], cursor: 'cursor-1' });
    assert.equal(journal.works().length, 1);
    assert.equal(journal.cursor(), 'cursor-1');
    assert.throws(() => journal.consume({ items: [{ ...event, revision: 2 }], cursor: 'cursor-bad' }), { code: 'event_conflict' });
    assert.equal(journal.cursor(), 'cursor-1');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('lost committed publication retries exact native command without creating another task', async () => {
  const backend = await startBackend({ database: ':memory:' });
  const journal = new NodeJournal(':memory:', { nodeId: 'desktop', instanceId: backend.store.instance });
  try {
    const api = nativeBackendClient({ url: backend.origin, token: backend.store.bootstrap().token });
    const command = { key: 'capture', action: 'task.create', payload: { id: 'task', title: 'Once' } };
    journal.queue(command);
    await assert.rejects(journal.flush(async (...args) => { await api(...args); throw new Error('lost response'); }), /lost response/);
    await journal.flush(api);
    assert.equal(backend.store.all('task').length, 1);
    assert.equal(backend.store.events().items.filter(e => e.type === 'task.create').length, 1);
    await journal.poll(api);
    assert.ok(journal.cursor());
    assert.throws(() => journal.queue({ ...command, payload: { ...command.payload, title: 'Changed' } }), { code: 'operation_conflict' });
  } finally { journal.close(); await backend.close(); }
});

test('bounded publication queue preserves existing evidence and refuses new operations at capacity', () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend', maxPending: 1 });
  try {
    const first = { key: 'one', action: 'task.create', payload: { id: 'one', title: 'One' } };
    journal.queue(first);
    journal.queue(first);
    assert.throws(() => journal.queue({ ...first, key: 'two' }), { code: 'outbox_full' });
    assert.equal(journal.receipt('one').state, 'pending');
    assert.equal(journal.receipt('two'), null);
  } finally { journal.close(); }
});

test('continuation history retains original exact invocation and refuses rewriting it', () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  const work = { id: 'execution', state: 'settled_waiting', execution: { runId: 'run-1' }, invocation: { messageId: 'message', prompt: 'Original' } };
  try {
    journal.archive(work); journal.archive(work);
    assert.equal(journal.db.prepare('SELECT COUNT(*) AS n FROM execution_history').get().n, 1);
    assert.throws(() => journal.archive({ ...work, invocation: { ...work.invocation, prompt: 'Changed' } }), { code: 'history_conflict' });
  } finally { journal.close(); }
});

test('snapshot recovery merges backend state without erasing an uncertain native invocation', () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  try {
    const execution = { id: 'execution', targetNodeId: 'node', revision: 1, state: 'accepted', runId: 'run' };
    journal.save({ id: execution.id, execution, state: 'uncertain', invocation: { messageId: 'message', prompt: 'Do work' } });
    journal.reconcileSnapshot({ instanceId: 'backend', protocol: 'relay/0.2', cursor: 'checkpoint',
      collections: { execution: [{ ...execution, revision: 2, cancellationRequested: true }] } });
    assert.equal(journal.work('execution').state, 'uncertain');
    assert.equal(journal.work('execution').invocation.messageId, 'message');
    assert.equal(journal.work('execution').execution.cancellationRequested, true);
    assert.equal(journal.cursor(), 'checkpoint');
  } finally { journal.close(); }
});
