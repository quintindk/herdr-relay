import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { releaseVersion } from '../src/release-info.mjs';

const execute = promisify(execFile);
test('npm-style symlinked public executable runs the same native CLI', async t => {
  const directory = mkdtempSync('/tmp/opencode/relay-native-cli-link-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, 'herdr-relay'); symlinkSync(resolve('src/cli.mjs'), executable);
  assert.equal((await execute(executable, ['--version'])).stdout.trim(), releaseVersion);
  assert.match((await execute(executable, ['native', '--help'])).stdout, /execution handback/);
});
test('public CLI help documents only the native product and retired entrypoints fail before reading private state', async () => {
  const { stdout } = await execute(process.execPath, ['src/cli.mjs', '--help']);
  assert.match(stdout, /Native tasks/); assert.match(stdout, /execution handback/);
  assert.doesNotMatch(stdout, /paperclip|company provision|adapter-stdio|tasks export/i);
  for (const args of [['service', '--paperclip-url', 'http://127.0.0.1:1'], ['company', 'provision'], ['routine', 'run'], ['tasks', 'export'], ['task', 'create'], ['adapter-stdio']]) {
    await assert.rejects(execute(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env,
      RELAY_CONTEXT: '/private/must-not-read', RELAY_NATIVE_CONTEXT: '/private/must-not-read' } }), error => {
      assert.match(error.stderr, /unsupported_command/); assert.doesNotMatch(error.stderr, /ENOENT|ECONNREFUSED/); return true;
    });
  }
});

test('package and Herdr entrypoints cannot expose the retired service or development captures', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.exports, undefined);
  assert.equal(pkg.files.some(path => /paperclip|evaluation|evidence|archive/.test(path)), false);
  const manifest = readFileSync('herdr-plugin.toml', 'utf8');
  assert.doesNotMatch(manifest, /"board"|"observed"|"discover"/);
  for (const path of ['src/adapter.mjs', 'src/service.mjs', 'src/paperclip.mjs', 'src/provider-selection.mjs']) assert.equal(existsSync(path), false);
});
