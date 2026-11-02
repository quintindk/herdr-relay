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
    if (command[0] === 'release') { assert.match(stdout, /--no-herdr/); assert.match(stdout, /--herdr-config/); }
  }
});

test('unsupported maintenance fields, missing checksums and attempted service override fail before network/service actions', async () => {
  for (const args of [['node', 'upgrade', '--artifact', '/private/no-read'], ['backend', 'upgrade', '--version', '0.2.1', '--services', 'node'],
    ['upgrade', 'resume', '../not-an-operation', '--apply'], ['release', 'install', '--version', '0.2.1', '--apply'],
    ['upgrade', 'status', 'id', '--version', '0.2.1'], ['upgrade', '--version', '0.2.2', '--no-herdr'],
    ['release', 'install', '--version', '0.2.2', '--no-herdr', '--herdr-config', '/private/no-read']]) {
    await assert.rejects(execute(process.execPath, ['src/cli.mjs', ...args]), error => { assert.match(error.stderr, /invalid_request/); return true; });
  }
});

function releaseCommand({ extra = [], skills = 'skills_current', herdrComplete = true } = {}) {
  return execute(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { maintenanceCli } from './src/upgrade-cli.mjs';
    await maintenanceCli(${JSON.stringify(['release', 'install', '--version', '0.2.2', '--config-dir', '/fixture/opencode', ...extra])}, {
      installCliRelease: async input => {
        assert.equal(input.version, '0.2.2'); assert.equal(input.configDirectory, '/fixture/opencode');
        assert.equal(input.skipHerdr, ${extra.includes('--no-herdr') ? 'true' : 'undefined'});
        assert.equal(input.herdrConfig, ${extra.includes('--herdr-config') ? JSON.stringify(extra[extra.indexOf('--herdr-config') + 1]) : 'undefined'});
        return { state: 'cli_activated', servicesChanged: false, installation: '/fixture/verified release',
          complete: ${herdrComplete && skills !== 'skill_conflict'}, skills: { state: ${JSON.stringify(skills)} },
          herdr: { state: ${JSON.stringify(herdrComplete ? 'herdr_installed' : 'herdr_setup_failed')}, complete: ${herdrComplete} } };
      },
    });
  `]);
}

test('release install forwards local setup preferences and reports the verified activation result', async () => {
  const result = JSON.parse((await releaseCommand()).stdout);
  assert.equal(result.complete, true); assert.equal(result.servicesChanged, false); assert.equal(result.herdr.state, 'herdr_installed');
  await releaseCommand({ extra: ['--herdr-config', '/fixture/custom herdr.toml'] });
  await releaseCommand({ extra: ['--no-herdr'] });
});

test('release install reports activated CLI and incomplete setup with a non-zero exit for Herdr or skill conflicts', async () => {
  for (const options of [{ herdrComplete: false }, { skills: 'skill_conflict' }]) {
    await assert.rejects(releaseCommand(options), error => {
      assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.state, 'cli_activated'); assert.equal(result.complete, false); assert.equal(result.servicesChanged, false);
      return true;
    });
  }
});

test('retired migration verbs and flags are rejected without reading private state', async () => {
  for (const args of [['native', 'task', 'migrate-references', '--state-dir', '/private/must-not-read'],
    ['upgrade', '--version', '0.2.1', '--migrate-task-references']]) {
    await assert.rejects(execute(process.execPath, ['src/cli.mjs', ...args]), error => {
      assert.match(error.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/); assert.doesNotMatch(error.stderr, /ENOENT/); return true;
    });
  }
});
