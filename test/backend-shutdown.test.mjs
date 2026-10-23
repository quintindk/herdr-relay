import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startBackend } from '../src/backend-service.mjs';

test('backend shutdown bounds a stalled partial request and preserves committed data', async t => {
  const root = mkdtempSync('/tmp/opencode/backend-shutdown-'), database = join(root, 'backend.sqlite');
  const backend = await startBackend({ database });
  const token = backend.store.bootstrap().token, owner = backend.store.authenticate(token);
  const task = backend.store.command(owner, { key: 'preserved', action: 'task.create', payload: { title: 'Preserve committed task' } });
  const socket = connect(Number(new URL(backend.origin).port), '127.0.0.1'); socket.on('error', () => {});
  t.after(async () => { socket.destroy(); await backend.close(); rmSync(root, { recursive: true, force: true }); });
  await once(socket, 'connect');
  socket.write(`POST /v1/commands HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Length: 10000\r\n\r\n{`);
  await setImmediate();
  let deadline;
  try { await Promise.race([backend.close(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Shutdown remained blocked by a partial request')), 4000); })]); }
  finally { clearTimeout(deadline); }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    assert.equal(JSON.parse(db.prepare("SELECT data FROM entities WHERE kind='task' AND id=?").get(task.id).data).reference, task.reference);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count, 1);
  } finally { db.close(); }
});
