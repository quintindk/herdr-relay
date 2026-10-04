import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { ownedRuntime, stopRuntime, processGroupMembers } from '../src/runtimes.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('owned runtime verification rejects replaced process identity before any stop', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  const descriptor = { ownerPid: process.pid, ownerStart: start, childPid: process.pid, childStart: start, nonce: 'nonce', state: 'running' };
  writeFileSync(join(root, 'runtime.json'), JSON.stringify(descriptor));
  store.saveOperation({ id: 'runtime:owned', runId: '', directory: root, nonce: 'nonce', state: 'ready' });
  assert.equal(ownedRuntime(store, 'owned').nonce, 'nonce');
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ ...descriptor, childStart: 'stale-start' }));
  assert.throws(() => ownedRuntime(store, 'owned'), { code: 'runtime_identity_mismatch' });
  await assert.rejects(stopRuntime(store, 'owned'), { code: 'runtime_identity_mismatch' });
  store.saveOperation({ id: 'runtime:owned', runId: '', directory: root, nonce: 'nonce', state: 'retired' });
  assert.equal((await stopRuntime(store, 'owned')).state, 'retired');
});

test('owned process-group inspection sees the exact child and rejects invalid group targets', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGTERM'); await exited;
  });
  assert.ok(processGroupMembers(child.pid).some(member => member.pid === child.pid));
  assert.throws(() => processGroupMembers(0), { code: 'runtime_identity_mismatch' });
});
