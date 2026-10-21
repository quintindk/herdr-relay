import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/client';
import { processGroupMembers } from '../../src/runtimes.mjs';
import { requireValue, canonical } from '../../src/protocol.mjs';
import { checkV2Version } from './native.mjs';

const startIdentity = pid => {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch { return null; }
};

// Linux-only dedicated serve instance. The journal precedes spawn, and uncertain
// starts are fenced. A general OpenCode shared/background service is never adopted.
export async function launchOwnedV2({ directory, executable, workspace, config, timeoutMs = 30000, resume = false }) {
  requireValue(process.platform === 'linux', 'unsupported_platform', 'Owned v2 process identity requires Linux');
  directory = resolve(directory); workspace = resolve(workspace);
  const descriptorPath = join(directory, 'runtime.json');
  const request = { executable: resolve(executable), workspace, config };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let previous;
  if (existsSync(descriptorPath)) {
    const existing = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    requireValue(canonical(existing.request) === canonical(request), 'runtime_conflict', 'Runtime configuration changed');
    if (existing.state === 'ready' && startIdentity(existing.pid) === existing.start) return ownedV2Handle(descriptorPath, existing);
    requireValue(resume && Number.isSafeInteger(existing.pid) && existing.start && startIdentity(existing.pid) !== existing.start &&
      processGroupMembers(existing.pid).length === 0, 'runtime_launch_uncertain', 'Explicit resume requires the prior process group to be proven gone');
    previous = existing;
  }
  const home = join(directory, 'home');
  const configDirectory = join(home, '.config/opencode');
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(configDirectory, 'opencode.json');
  const configuration = JSON.stringify({ ...config, $schema: 'https://opencode.ai/config.json', update: 'disable', share: 'disabled' });
  if (previous) requireValue(readFileSync(configPath, 'utf8') === configuration, 'runtime_conflict', 'Private runtime config changed before resume');
  else writeFileSync(configPath, configuration, { flag: 'wx', mode: 0o600 });
  let descriptor = { request, nonce: randomBytes(24).toString('hex'), state: 'launching', generation: (previous?.generation ?? 0) + 1,
    history: previous ? [...(previous.history ?? []), { pid: previous.pid, start: previous.start, nonce: previous.nonce, state: previous.state }] : [] };
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { flag: previous ? 'w' : 'wx', mode: 0o600 });
  const child = spawn(request.executable, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    },
  });
  let log = '', failure;
  child.once('error', error => { failure = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data).slice(-16000); });
  const deadline = Date.now() + timeoutMs;
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    descriptor = { ...descriptor, pid: child.pid, start: startIdentity(child.pid) };
    writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null) throw new Error('Dedicated v2 runtime failed during startup');
      const origin = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      const password = log.match(/server password (\S+)/)?.[1];
      if (origin && password) {
        const start = startIdentity(child.pid);
        requireValue(start && processGroupMembers(child.pid).some(member => member.pid === child.pid), 'runtime_identity_mismatch', 'Dedicated process group missing');
        const ready = { ...descriptor, state: 'ready', pid: child.pid, start, origin };
        writeFileSync(join(directory, 'auth.json'), JSON.stringify({ password }), { flag: previous ? 'w' : 'wx', mode: 0o600 });
        const client = OpenCode.make({ baseUrl: origin, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
        const info = await client.server.info({ signal: AbortSignal.timeout(5000) });
        checkV2Version(info.version);
        requireValue(info.pid === child.pid || processGroupMembers(child.pid).some(member => member.pid === info.pid),
          'runtime_identity_mismatch', 'API server is not inside the owned native process group');
        writeFileSync(descriptorPath, JSON.stringify(ready), { mode: 0o600 });
        child.stdout.unref(); child.stderr.unref(); child.unref();
        return ownedV2Handle(descriptorPath, ready);
      }
      await delay(100);
    }
    throw new Error('Dedicated v2 runtime readiness timed out');
  } catch (error) {
    // This child is our own unexposed launch. Cleanup is not execution settlement.
    if (child.pid && startIdentity(child.pid)) {
      const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGTERM');
      await Promise.race([exited, delay(5000)]);
      if (startIdentity(child.pid)) process.kill(-child.pid, 'SIGKILL');
    }
    writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, state: 'failed' }), { mode: 0o600 });
    throw error;
  }
}

function ownedV2Handle(descriptorPath, descriptor) {
  const directory = join(descriptorPath, '..');
  const password = JSON.parse(readFileSync(join(directory, 'auth.json'), 'utf8')).password;
  const client = OpenCode.make({ baseUrl: descriptor.origin,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
  const verify = () => {
    const current = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    requireValue(current.nonce === descriptor.nonce && current.pid === descriptor.pid && current.start === descriptor.start &&
      startIdentity(current.pid) === current.start, 'runtime_identity_mismatch', 'Owned runtime process identity changed');
  };
  return { descriptor, client, verify,
    async interrupt(sessionId) {
      verify();
      const session = await client.session.get({ sessionID: sessionId });
      requireValue(session.location.directory === descriptor.request.workspace, 'native_identity_mismatch', 'Session location changed');
      verify();
      // The response requests interruption. Caller must observe terminal evidence.
      return client.session.interrupt({ sessionID: sessionId });
    },
    async stop() {
      const current = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      if (current.state === 'stopped') return;
      if (current.state === 'stopping' && current.nonce === descriptor.nonce && startIdentity(descriptor.pid) !== descriptor.start &&
        processGroupMembers(descriptor.pid).length === 0) {
        writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, state: 'stopped' }), { mode: 0o600 }); return;
      }
      verify();
      const active = await client.session.active();
      requireValue(Object.keys(active).length === 0, 'runtime_busy', 'Dedicated runtime still has active sessions');
      verify();
      // Do not signal a reused PID, even during a retry of stopping.
      writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, state: 'stopping' }), { mode: 0o600 });
      process.kill(-descriptor.pid, 'SIGTERM');
      for (let i = 0; i < 100; i++) {
        if (startIdentity(descriptor.pid) !== descriptor.start && processGroupMembers(descriptor.pid).length === 0) {
          writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, state: 'stopped' }), { mode: 0o600 }); return;
        }
        await delay(100);
      }
      requireValue(false, 'runtime_stop_uncertain', 'Owned process group has not stopped');
    },
  };
}
