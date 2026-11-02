import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { nativeDoctor } from '../src/native-doctor.mjs';

function fixture(t) {
  const root = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'doctor-hosts-'));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return async version => {
    const calls = [];
    const result = await nativeDoctor({ configFile: join(root, 'missing-node.json'), contextFile: join(root, 'missing-context.json') }, {
      run(command, args) {
        calls.push([command, args]);
        return command === 'herdr' ? 'herdr 0.9.3' : '';
      },
      native: async () => ({ client: { server: { info: async () => ({ version }) } } }),
    });
    assert.deepEqual(calls, [['systemctl', ['--user', 'show-environment']], ['herdr', ['--version']]],
      'Doctor must not start or upgrade a service');
    return result;
  };
}

test('doctor recognises all three CI-certified OpenCode hosts without changing services', async t => {
  const inspect = fixture(t);
  for (const version of ['2.1.0', '2.1.2', '2.2.5']) {
    const result = await inspect(version), check = result.checks.find(check => check.name === 'opencode');
    assert.deepEqual(check, { name: 'opencode', status: 'passed', version, releaseCertified: true });
    assert.equal(result.readOnly, true); assert.equal(result.servicesStarted, false); assert.equal(result.destructiveChanges, false);
  }
});

test('doctor does not turn other admitted patches or prereleases into release certification', async t => {
  const inspect = fixture(t);
  for (const version of ['2.2.4', '2.2.6', '2.2.5-beta.1', '2.2.5+build.1']) {
    const result = await inspect(version), check = result.checks.find(check => check.name === 'opencode');
    assert.equal(check.status, 'passed'); assert.equal(check.releaseCertified, false);
    assert.match(check.warning, /not a certified patch release/);
  }
});
