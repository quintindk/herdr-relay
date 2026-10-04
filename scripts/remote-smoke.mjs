import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../src/service.mjs';
import { remoteCommand } from '../src/remote.mjs';
import { executeRemote } from '../src/remote-adapter.mjs';

const root = mkdtempSync('/tmp/opencode/relay-ssh-smoke-');
let daemon, service;
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
try {
  for (const key of ['host', 'client']) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, key)]);
  writeFileSync(join(root, 'authorized_keys'), readFileSync(join(root, 'client.pub')), { mode: 0o600 });
  const publicHost = readFileSync(join(root, 'host.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
  const knownHosts = join(root, 'known_hosts');
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${publicHost}\n`, { mode: 0o600 });
  const configPath = join(root, 'sshd_config');
  writeFileSync(join(root, 'sshd.pid'), '', { mode: 0o600 });
  // StrictModes checks every ancestor and rejects /tmp. This isolated test uses
  // its freshly created 0700 directory and private keys, with no system config.
  writeFileSync(configPath, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root, 'host')}\nPidFile ${join(root, 'sshd.pid')}\nAuthorizedKeysFile ${join(root, 'authorized_keys')}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`);
  // A uniquely configured test daemon. No system SSH configuration is changed.
  daemon = spawn('sudo', ['-n', '/usr/sbin/sshd', '-D', '-e', '-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  let clientError = '';
  daemon.stderr.on('data', chunk => { errors += chunk; });
  service = await startService({ directory: join(root, 'relay'), paperclipUrl: 'http://paperclip.test' });
  const contextFile = join(root, 'operator.json');
  writeFileSync(contextFile, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  const nodeConfig = { host: `${userInfo().username}@127.0.0.1`, port, node: process.execPath,
    cli: fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), contextFile,
    identityFile: join(root, 'client'), knownHostsFile: knownHosts };
  let status;
  for (let i = 0; i < 30; i++) {
    if (daemon.exitCode !== null) throw new Error(`Isolated sshd exited: ${errors}`);
    try { status = JSON.parse((await promisify(execFile)('ssh', remoteCommand(nodeConfig, ['status']), { timeout: 15000 })).stdout); break; }
    catch (error) { clientError = String(error.stderr ?? error.message); await delay(100); }
  }
  assert.equal(status?.status, 'ok', `${errors}\n${clientError}`);
  service.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  const nodeFile = join(root, 'node.json');
  writeFileSync(nodeFile, JSON.stringify(nodeConfig));
  const result = executeRemote({ agent: { id: 'agent', companyId: 'company' }, runId: 'backend', authToken: 'fixture-secret',
    config: { relayNodeFile: nodeFile, bindingId: 'worker' }, context: { taskId: 'task' }, onLog: async () => {} });
  for (let i = 0; i < 100 && !service.store.runs().length; i++) await delay(50);
  const run = service.store.runs()[0];
  assert.ok(run);
  service.store.acknowledge(run.id);
  service.store.submit(run.id, { key: 'one', summary: 'SSH adapter fixture', candidate: 'fixture:ssh' });
  service.store.publication(run.id, { state: 'recorded', commentId: 'receipt' });
  service.store.settle(run.id, { outcome: 'completed', evidence: 'Deterministic native fixture ended' });
  assert.equal((await result).exitCode, 0);
  console.log(JSON.stringify({ actualSshTransport: true, isolatedHostKey: true, remoteStatus: true,
    adapterStdioExecution: true, sameRelayRun: true, nativeHarness: false }, null, 2));
} catch (error) {
  console.error(error.message);
  throw error;
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, 'exit');
    const pid = Number(readFileSync(join(root, 'sshd.pid'), 'utf8').trim());
    execFileSync('sudo', ['-n', 'kill', '-TERM', String(pid)]);
    await exited;
  }
  await service?.close();
  rmSync(root, { recursive: true, force: true });
}
