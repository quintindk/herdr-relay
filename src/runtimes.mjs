import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, digest, requireValue, text } from './protocol.mjs';

function processIdentity(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  }
  catch { return null; }
}

export function ownedRuntime(store, key) {
  const operation = store.operation(`runtime:${key}`);
  requireValue(operation?.state === 'ready', 'runtime_not_ready', 'Managed native runtime is not ready', 409);
  const descriptor = JSON.parse(readFileSync(join(operation.directory, 'runtime.json'), 'utf8'));
  requireValue(descriptor.nonce === operation.nonce && descriptor.state === 'running' &&
    processIdentity(descriptor.ownerPid) === descriptor.ownerStart && processIdentity(descriptor.childPid) === descriptor.childStart,
  'runtime_identity_mismatch', 'Managed native runtime identity changed', 409);
  return operation;
}

export async function launchRuntime(store, stateDirectory, input) {
  requireValue(process.platform === 'linux', 'unsupported_platform', 'Managed native runtimes currently require Linux');
  const key = text(input.key, 'key');
  const harness = input.harness ?? 'opencode';
  requireValue(['opencode', 'hermes'].includes(harness), 'invalid_harness', 'Managed runtime requires OpenCode or Hermes');
  const request = { directory: resolve(text(input.directory, 'directory')), executable: text(input.executable ?? harness, 'executable'),
    ...(harness === 'hermes' ? { harness } : {}) };
  const id = `runtime:${key}`;
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Runtime key configuration changed', 409);
    if (operation.state === 'ready') return ownedRuntime(store, key);
    requireValue(operation.state === 'launching', 'runtime_retired', 'Runtime cannot be relaunched under this identity', 409);
  } else {
    const directory = join(stateDirectory, 'runtimes', digest(key));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const nonce = randomBytes(24).toString('hex');
    const password = randomBytes(32).toString('hex');
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ username: 'opencode', password }), { flag: 'wx', mode: 0o600 });
    if (harness === 'hermes') writeFileSync(join(directory, 'gateway-token'), password, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...request, port, nonce }), { flag: 'wx', mode: 0o600 });
    operation = store.saveOperation({ id, runId: '', request, directory, port, nonce, state: 'launching' });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./runtime-host.mjs', import.meta.url)), directory], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
  const auth = JSON.parse(readFileSync(join(operation.directory, 'auth.json'), 'utf8'));
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(operation.directory, 'runtime.json'))) {
      const descriptor = JSON.parse(readFileSync(join(operation.directory, 'runtime.json'), 'utf8'));
      requireValue(descriptor.nonce === operation.nonce && !['failed', 'exited'].includes(descriptor.state),
        'runtime_launch_failed', 'Owned native runtime failed during startup', 409);
      try {
        const response = await fetch(`http://127.0.0.1:${operation.port}/${harness === 'hermes' ? 'api/health' : 'global/health'}`, {
          headers: { Authorization: `Basic ${Buffer.from(`opencode:${auth.password}`).toString('base64')}` }, signal: AbortSignal.timeout(500),
        });
        const health = response.ok ? await response.json() : {};
        if (health.healthy || health.ok) {
          store.saveOperation({ ...operation, state: 'ready' });
          return ownedRuntime(store, key);
        }
      } catch {}
    }
    await delay(100);
  }
  requireValue(false, 'runtime_launch_uncertain', 'Native launch requires inspection. Do not create another runtime key.', 409);
}

export async function stopRuntime(store, key) {
  const existing = store.operation(`runtime:${key}`);
  requireValue(existing, 'runtime_not_found', 'Unknown owned native runtime', 404);
  if (existing.state === 'retired') return existing;
  const operation = existing.state === 'stopping' ? existing : ownedRuntime(store, key);
  const bindings = store.bindings().filter(binding => (binding.config.opencode ?? binding.config.hermes)?.runtimeKey === key);
  requireValue(bindings.every(binding => !store.runs(binding.id).some(run => run.nativeState !== 'settled')),
    'runtime_busy', 'Managed runtime still has unsettled work', 409);
  const descriptor = JSON.parse(readFileSync(join(operation.directory, 'runtime.json'), 'utf8'));
  if (operation.state === 'stopping' && processIdentity(descriptor.childPid) !== descriptor.childStart) {
    return store.saveOperation({ ...operation, state: 'retired' });
  }
  requireValue(descriptor.nonce === operation.nonce && processIdentity(descriptor.ownerPid) === descriptor.ownerStart &&
    processIdentity(descriptor.childPid) === descriptor.childStart,
  'runtime_identity_mismatch', 'Managed process identity changed before shutdown', 409);
  store.saveOperation({ ...operation, state: 'stopping' });
  // The detached owner is the process-group leader. Signal its owned group so
  // executable wrappers cannot leave the actual native server running.
  process.kill(-descriptor.ownerPid, 'SIGTERM');
  for (let i = 0; i < 100; i++) {
    if (processIdentity(descriptor.childPid) !== descriptor.childStart) return store.saveOperation({ ...operation, state: 'retired' });
    await delay(100);
  }
  requireValue(false, 'runtime_stop_uncertain', 'Native process has not been verified stopped', 409);
}
