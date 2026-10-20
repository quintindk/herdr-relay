import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { BackendStore } from '../src/backend-store.mjs';

test('online backup restores credentials, identities, receipts and events from a live WAL store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-backup-'));
  const source = join(directory, 'source.sqlite'), destination = join(directory, 'backup.sqlite');
  const store = new BackendStore(source);
  const token = store.bootstrap().token;
  const actor = store.authenticate(token);
  const command = { key: 'task', action: 'task.create', payload: { id: 'task', title: 'Task' } };
  store.command(actor, command);
  try {
    execFileSync(process.execPath, [resolve('src/backend-backup.mjs'), '--database', source, '--output', destination], { stdio: 'pipe' });
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    const restored = new BackendStore(destination);
    try {
      assert.equal(restored.instance, store.instance);
      assert.equal(restored.command(restored.authenticate(token), command).id, 'task');
      assert.equal(restored.events().items.length, 1);
    } finally { restored.close(); }
    assert.throws(() => execFileSync(process.execPath, [resolve('src/backend-backup.mjs'), '--database', source, '--output', destination], { stdio: 'pipe' }));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
