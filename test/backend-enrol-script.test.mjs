import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startBackend } from '../src/backend-service.mjs';

test('enrolment uses local owner transport and writes a repeatable remote shim configuration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-enrol-'));
  const backend = await startBackend({ database: ':memory:' });
  t.after(async () => { await backend.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerFile = join(directory, 'owner.json'), output = join(directory, 'node.json');
  writeFileSync(ownerFile, JSON.stringify({ token: backend.store.bootstrap().token }), { mode: 0o600 });
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/enrol-native-node.mjs', '--owner', ownerFile, '--output', output,
      '--id', 'remote', '--name', 'Remote', '--state-dir', '/home/remote/.local/state/relay',
      '--backend-url', backend.origin, '--url', 'http://relay.shim:3999', '--trusted-http-proxy-origin', 'http://relay.shim:3999']);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  const first = await run();
  assert.equal(first.code, 0, first.stderr);
  const config = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(config.backend.url, 'http://relay.shim:3999');
  assert.equal(config.backend.trustedHttpProxyOrigin, config.backend.url);
  assert.equal(backend.store.authenticate(config.backend.token).type, 'node');
  assert.equal(first.stdout.includes(config.backend.token), false);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal((await run()).code, 0);
  assert.equal(backend.store.all('node').length, 1);
});
