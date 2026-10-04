import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { startService } from '../src/service.mjs';
import { executeRemote } from '../src/remote-adapter.mjs';
import { remoteCommand } from '../src/remote.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('SSH command quoting preserves literal arguments and rejects option injection', t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-quoting-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'argument probe.mjs');
  writeFileSync(cli, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const config = { host: 'relay-node', node: process.execPath, cli, contextFile: '/private/context.json' };
  const literal = "run'; exit 99; '";
  const args = remoteCommand(config, ['work', 'inspect', literal]);
  assert.equal(args.at(-2), 'relay-node');
  const output = execFileSync('/bin/sh', ['-c', args.at(-1)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), ['--context', config.contextFile, 'work', 'inspect', literal]);
  assert.throws(() => remoteCommand({ ...config, host: '-oProxyCommand=evil' }, []), { code: 'invalid_remote' });
});

test('remote adapter reconnects after transport loss without replaying native work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-remote-'));
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://paperclip.test', api: async () => ({}) });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  const configPath = join(root, 'node.json');
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  writeFileSync(configPath, JSON.stringify({ host: 'fixture', node: process.execPath, cli, contextFile: context }));
  let launches = 0;
  const spawnProcess = (command, args, options) => {
    assert.equal(command, 'ssh');
    assert.ok(!args.join(' ').includes('backend-secret'));
    launches++;
    // Real adapter child processes, deterministic SSH transport boundary.
    const child = spawn(process.execPath, [cli, 'adapter-stdio'], options);
    children.push(child);
    return child;
  };
  const promise = executeRemote({ runId: 'backend', agent: { id: 'agent', companyId: 'company' }, authToken: 'backend-secret',
    context: { taskId: 'task' }, config: { relayNodeFile: configPath, bindingId: 'worker' }, onLog: async () => {} }, { spawnProcess });
  for (let i = 0; i < 100 && !service.store.runs().length; i++) await delay(20);
  const run = service.store.runs()[0];
  assert.ok(run);
  children[0].kill('SIGKILL');
  for (let i = 0; i < 150 && launches < 2; i++) await delay(20);
  assert.equal(launches, 2);
  service.store.acknowledge(run.id);
  service.store.submit(run.id, { key: 'one', candidate: 'fixture', summary: 'Remote work' });
  service.store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  service.store.settle(run.id, { outcome: 'completed', evidence: 'Fixture native completion' });
  assert.equal((await promise).exitCode, 0);
  assert.equal(service.store.runs().length, 1);
});

test('remote cancellation waits for confirmed native settlement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-remote-cancel-'));
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://paperclip.test' });
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  const configPath = join(root, 'node.json');
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  writeFileSync(configPath, JSON.stringify({ host: 'fixture', node: process.execPath, cli, contextFile: context }));
  const abort = new AbortController();
  let finished = false;
  const promise = executeRemote({ runId: 'backend', agent: { id: 'agent', companyId: 'company' }, authToken: 'secret',
    context: { taskId: 'task' }, config: { relayNodeFile: configPath, bindingId: 'worker' }, signal: abort.signal, onLog: async () => {} }, {
    spawnProcess: (command, args, options) => child = spawn(process.execPath, [cli, 'adapter-stdio'], options),
  }).then(result => { finished = true; return result; });
  for (let i = 0; i < 100 && !service.store.runs().length; i++) await delay(20);
  const run = service.store.runs()[0];
  assert.ok(run);
  service.store.acknowledge(run.id);
  abort.abort();
  for (let i = 0; i < 100 && !service.store.run(run.id).cancellationRequested; i++) await delay(20);
  assert.equal(service.store.run(run.id).cancellationRequested, true);
  assert.equal(finished, false);
  service.store.settle(run.id, { outcome: 'cancelled', evidence: 'Verified remote fixture stopped' });
  assert.equal((await promise).exitCode, 1);
});

test('remote deadlines remain visible after reconnecting to the same backend run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-remote-deadline-'));
  const service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://paperclip.test' });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const context = join(root, 'operator.json');
  writeFileSync(context, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  const configPath = join(root, 'node.json');
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  writeFileSync(configPath, JSON.stringify({ host: 'fixture', node: process.execPath, cli, contextFile: context }));
  const promise = executeRemote({ runId: 'backend', agent: { id: 'agent', companyId: 'company' }, authToken: 'secret',
    context: { taskId: 'task' }, config: { relayNodeFile: configPath, bindingId: 'worker', timeoutSec: 0.2 }, onLog: async () => {} }, {
    spawnProcess: (command, args, options) => {
      const child = spawn(process.execPath, [cli, 'adapter-stdio'], options);
      children.push(child);
      return child;
    },
  });
  for (let i = 0; i < 100 && !service.store.runs().length; i++) await delay(10);
  const run = service.store.runs()[0];
  assert.ok(run);
  service.store.acknowledge(run.id);
  children[0].kill('SIGKILL');
  for (let i = 0; i < 150 && !service.store.run(run.id).cancellationRequested; i++) await delay(20);
  assert.equal(service.store.run(run.id).cancellationRequested, true);
  service.store.settle(run.id, { outcome: 'cancelled', evidence: 'Confirmed timed-out native fixture stopped' });
  const result = await promise;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 1);
  assert.equal(service.store.runs().length, 1);
});
