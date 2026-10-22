import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execute, createServerAdapter } from '../src/adapter.mjs';

test('retired SSH configurations fail closed instead of falling back to local delivery or reading credentials', async () => {
  await assert.rejects(execute({ config: { relayNodeFile: '/must/not/read.json' } }), { code: 'legacy_remote_retired' });
  const result = await createServerAdapter().testEnvironment({ config: { relayNodeFile: '/must/not/read.json' } });
  assert.equal(result.status, 'fail'); assert.equal(result.checks[0].code, 'legacy_remote_retired');
  await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.mjs', 'adapter-stdio']), error => {
    assert.match(error.stderr, /legacy_remote_retired/); return true;
  });
});

test('only one public CLI is packaged and SSH execution modules are absent', () => {
  assert.deepEqual(Object.keys(JSON.parse(readFileSync('package.json')).bin), ['herdr-relay']);
  for (const file of ['src/remote.mjs', 'src/remote-adapter.mjs', 'scripts/remote-smoke.mjs']) assert.equal(existsSync(file), false);
});
