import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceLock } from '../src/service-lock.mjs';

test('native service lock admits one process and releases ownership on crash', async t => {
  const directory = mkdtempSync('/tmp/opencode/relay-lock-'), children = [];
  serviceLock(directory)();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const start = () => {
    const source = `import {serviceLock} from ${JSON.stringify(new URL('../src/service-lock.mjs', import.meta.url).href)};
      try {globalThis.unlock=serviceLock(${JSON.stringify(directory)});console.log(JSON.stringify({state:'owned'}));setInterval(()=>{},1000);}
      catch(error){console.log(JSON.stringify({code:error.code}));process.exitCode=1;}`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); return { child, output: () => output };
  };
  const entries = [start(), start()];
  for (let i = 0; i < 150 && entries.some(e => !e.output().includes('\n')); i++) await delay(20);
  const results = entries.map(e => ({ ...e, result: JSON.parse(e.output()) }));
  const winner = results.find(e => e.result.state === 'owned'); assert.ok(winner);
  assert.ok(results.some(e => e.result.code === 'already_running'), JSON.stringify(results.map(e => e.result)));
  const exited = once(winner.child, 'exit'); winner.child.kill('SIGKILL'); await exited;
  const unlock = serviceLock(directory); unlock();
});
