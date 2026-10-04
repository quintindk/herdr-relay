import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';

test('concurrent service starters cannot unlink the winning socket and a crash releases ownership', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-lock-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const start = () => {
    const source = `import { startService } from ${JSON.stringify(new URL('../src/service.mjs', import.meta.url).href)};
      try { const service = await startService({directory:${JSON.stringify(directory)}, paperclipUrl:'http://paperclip.test'});
      console.log(JSON.stringify({socketPath:service.socketPath, token:service.token})); }
      catch(error) { console.log(JSON.stringify({code:error.code})); process.exitCode=1; }`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    return { child, output: () => output };
  };
  const first = start(), second = start();
  for (let i = 0; i < 100 && (!first.output().includes('\n') || !second.output().includes('\n')); i++) await delay(20);
  const entries = [first, second].map(item => ({ ...item, result: JSON.parse(item.output()) }));
  const winner = entries.find(item => item.result.socketPath);
  const loser = entries.find(item => item.result.code);
  assert.ok(winner, JSON.stringify(entries.map(entry => entry.result)));
  assert.equal(loser.result.code, 'already_running');
  assert.equal((await call(winner.result, 'GET', '/health')).status, 'ok');
  const exited = once(winner.child, 'exit'); winner.child.kill('SIGKILL'); await exited;
  const restarted = await startService({ directory, paperclipUrl: 'http://paperclip.test' });
  assert.equal((await call({ socketPath: restarted.socketPath, token: restarted.token }, 'GET', '/health')).status, 'ok');
  await restarted.close();
});
