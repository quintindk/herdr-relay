import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processGroupMembers } from '../src/process-identity.mjs';

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
