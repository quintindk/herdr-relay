import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseVersion } from '../src/release-info.mjs';

const execute = promisify(execFile);
test('public CLI exposes native backend/node maintenance and version reporting without private runtime paths', async () => {
  assert.equal((await execute(process.execPath, ['src/cli.mjs', '--version'])).stdout.trim(), releaseVersion);
  for (const command of [['upgrade', '--help'], ['node', 'upgrade', '--help'], ['backend', 'upgrade', '--help'], ['release', 'install', '--help']]) {
    const { stdout } = await execute(process.execPath, ['src/cli.mjs', ...command]);
    assert.match(stdout, /upgrade rollback/); assert.match(stdout, /nodejs/);
    assert.doesNotMatch(stdout, /\/home\/|node-worker-cli/);
  }
});

test('unsupported maintenance fields, missing checksums and attempted service override fail before network/service actions', async () => {
  for (const args of [['node', 'upgrade', '--artifact', '/private/no-read'], ['backend', 'upgrade', '--version', '0.2.0-rc.5', '--services', 'node'],
    ['upgrade', 'resume', '../not-an-operation', '--apply'], ['release', 'install', '--version', '0.2.0-rc.5', '--apply'],
    ['upgrade', 'status', 'id', '--version', '0.2.0-rc.5']]) {
    await assert.rejects(execute(process.execPath, ['src/cli.mjs', ...args]), error => { assert.match(error.stderr, /invalid_request/); return true; });
  }
});
