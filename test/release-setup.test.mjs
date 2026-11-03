import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installCliRelease } from '../src/service-upgrade.mjs';
import { compatibility, releaseInfo, releaseVersion } from '../src/release-info.mjs';

const execute = promisify(execFile);
const pluginId = 'quintindk.herdr-relay';
const json = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t) {
  const root = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'release-handover-'));
  const candidate = join(root, 'candidate release'), previous = join(root, 'previous release'), bin = join(root, 'bin');
  const home = join(root, 'home'), caller = join(root, 'caller directory');
  for (const directory of [candidate, previous, bin, home, caller]) mkdirSync(directory);
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}\n');
  for (const directory of [candidate, previous]) mkdirSync(join(directory, 'src'));
  writeFileSync(join(previous, 'package.json'), JSON.stringify({ name: 'herdr-relay', version: '0.2.3', relayCompatibility: compatibility }));
  writeFileSync(join(previous, 'src/cli.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ name: 'herdr-relay', version: '0.2.5', relayCompatibility: compatibility, relayInstaller: { protocol: 1 } }));
  writeFileSync(join(candidate, 'src/cli.mjs'), '#!/usr/bin/env node\n');
  for (const file of ['release-setup.mjs', 'release-info.mjs', 'release-install.mjs', 'protocol.mjs', 'private-files.mjs',
    'service-lock.mjs', 'skill-install.mjs', 'herdr-install.mjs']) copyFileSync(new URL(`../src/${file}`, import.meta.url), join(candidate, 'src', file));
  mkdirSync(join(candidate, 'scripts'));
  copyFileSync(new URL('../scripts/install-herdr-shortcut.py', import.meta.url), join(candidate, 'scripts/install-herdr-shortcut.py'));
  for (const name of ['herdr-relay', 'relay-work']) {
    mkdirSync(join(candidate, 'skills', name), { recursive: true });
    writeFileSync(join(candidate, 'skills', name, 'SKILL.md'), `# ${name}\nCandidate-only fixture skill.\n`);
  }
  const probe = join(root, 'candidate-code.json');
  const skillFile = join(candidate, 'src/skill-install.mjs');
  writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace('  let status = skillStatus',
    `  writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ pid: process.pid, version: '0.2.5' }));\n  let status = skillStatus`));
  const herdrFile = join(candidate, 'src/herdr-install.mjs');
  writeFileSync(herdrFile, readFileSync(herdrFile, 'utf8').replace("return { state: 'herdr_installed', complete: true,",
    "return { candidateSetupProbe: true, state: 'herdr_installed', complete: true,"));
  const stateFile = join(root, 'herdr-state.json'), gate = join(root, 'herdr-gate'), entered = join(root, 'herdr-entered');
  writeFileSync(stateFile, JSON.stringify({ plugins: [], calls: [], sessions: [{ name: 'default', running: true }, { name: 'stopped', running: false }] }));
  const herdr = join(bin, 'herdr');
  writeFileSync(herdr, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const path=${JSON.stringify(stateFile)}, args=process.argv.slice(2), state=JSON.parse(readFileSync(path,'utf8'));
state.calls.push(args); writeFileSync(path,JSON.stringify(state));
let result;
if(args[0]==='plugin' && args[1]==='list') result={plugins:state.plugins};
else if(args[0]==='plugin' && args[1]==='link') {
  if(existsSync(${JSON.stringify(gate)})) {
    writeFileSync(${JSON.stringify(entered)},'entered');
    const until=Date.now()+10000;
    while(existsSync(${JSON.stringify(gate)}) && Date.now()<until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  }
  state.plugins=[...state.plugins.filter(plugin=>plugin.plugin_id!==${JSON.stringify(pluginId)}),{plugin_id:${JSON.stringify(pluginId)},plugin_root:args[2],enabled:true}];
  writeFileSync(path,JSON.stringify(state)); result={plugin:state.plugins.at(-1)};
}
else if(args[0]==='session' && args[1]==='list') result={sessions:state.sessions};
else if(args[0]==='--session' && args[1]==='default' && args.slice(2).join(' ')==='server reload-config') result={reloaded:true};
else {console.error(JSON.stringify({code:'unexpected_herdr_command',message:'Only registration and running-session reloads are allowed'}));process.exit(1);}
console.log(JSON.stringify({result}));
`, { mode: 0o700 });
  const config = join(caller, 'relative OpenCode'), herdrConfig = join(caller, 'relative Herdr/config.toml');
  mkdirSync(join(caller, 'relative Herdr'));
  const originalConfig = '# Preserve preferences\n[theme]\nname="one-dark"\n\n[[keys.command]]\nkey="prefix+e"\ntype="plugin_action"\ncommand="other.open"\n';
  writeFileSync(herdrConfig, originalConfig);
  const cli = join(bin, 'herdr-relay'); symlinkSync(join(previous, 'src/cli.mjs'), cli);
  const environment = { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), HERDR_BIN_PATH: herdr, HERDR_CONFIG_PATH: herdrConfig };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])), cwd = process.cwd();
  Object.assign(process.env, environment);
  t.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  const f = { root, candidate, previous, cli, bin, caller, config, herdrConfig, originalConfig, stateFile, probe, gate, entered };
  f.input = { version: '0.2.5', directory: join(root, 'upgrades'), binDirectory: bin, configDirectory: config, herdrConfig };
  f.dependencies = {
    stageRelease: async () => ({ ...releaseInfo(candidate), packageFingerprint: releaseInfo(candidate).fingerprint, auditVerified: true }),
    installSkills() { throw Error('The caller must not run candidate skill setup'); },
    installHerdrPanel() { throw Error('The caller must not run candidate Herdr setup'); },
  };
  f.install = (extra = {}) => installCliRelease({ ...f.input, ...extra }, f.dependencies);
  return f;
}

test('one invocation hands setup to the verified candidate process, including candidate-only code and a stale plugin link', async t => {
  const f = fixture(t), state = json(f.stateFile);
  state.plugins = [{ plugin_id: pluginId, plugin_root: f.previous, enabled: true }, { plugin_id: 'other.plugin', enabled: true }];
  writeFileSync(f.stateFile, JSON.stringify(state));
  const result = await f.install();
  assert.equal(result.complete, true); assert.equal(result.servicesChanged, false);
  assert.deepEqual(result.installer, { mode: 'candidate', protocol: 1, callerVersion: releaseVersion, version: '0.2.5', state: 'complete' });
  assert.equal(result.skills.version, '0.2.5'); assert.equal(result.herdr.candidateSetupProbe, true);
  assert.equal(result.herdr.shortcut.state, 'installed'); assert.deepEqual(result.herdr.configReload.sessions, ['default']);
  assert.notEqual(json(f.probe).pid, process.pid, 'Setup must run in another Node process, not the caller module cache');
  assert.equal(json(f.probe).version, '0.2.5');
  assert.equal(realpathSync(f.cli), join(f.candidate, 'src/cli.mjs'));
  assert.ok(readFileSync(f.herdrConfig, 'utf8').startsWith(f.originalConfig));
  assert.equal(json(f.stateFile).plugins.find(plugin => plugin.plugin_id === pluginId).plugin_root, f.candidate);
  assert.equal(json(f.stateFile).plugins.find(plugin => plugin.plugin_id === 'other.plugin').enabled, true);
  assert.equal(json(join(f.config, 'skills/herdr-relay/.herdr-relay-managed.json')).version, '0.2.5');
});

test('candidate handover keeps relative paths anchored at the original cwd and survives paths containing spaces', async t => {
  const f = fixture(t); process.chdir(f.caller);
  const result = await f.install({ configDirectory: 'relative OpenCode', herdrConfig: 'relative Herdr/config.toml' });
  assert.equal(result.complete, true); assert.equal(result.herdr.configPath, f.herdrConfig);
  assert.ok(existsSync(join(f.config, 'skills/herdr-relay/SKILL.md')));
  assert.equal(existsSync(join(f.candidate, 'relative OpenCode')), false);
  assert.equal(existsSync(join(f.candidate, 'relative Herdr')), false);
});

test('an exact retry uses candidate code again without duplicate bindings or extra configuration backups', async t => {
  const f = fixture(t); await f.install();
  const before = readFileSync(f.herdrConfig, 'utf8'), files = readdirSync(join(f.caller, 'relative Herdr'));
  const retry = await f.install();
  assert.equal(retry.complete, true); assert.equal(retry.skills.state, 'skills_current'); assert.equal(retry.herdr.shortcut.state, 'existing');
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), before);
  assert.deepEqual(readdirSync(join(f.caller, 'relative Herdr')), files);
});

test('relative environment configuration paths keep the caller cwd rather than moving into the candidate package', async t => {
  const f = fixture(t); process.chdir(f.caller);
  process.env.XDG_CONFIG_HOME = 'relative XDG'; process.env.HERDR_CONFIG_PATH = 'relative Herdr/config.toml';
  const result = await f.install({ configDirectory: undefined, herdrConfig: undefined });
  assert.equal(result.complete, true); assert.equal(result.herdr.configPath, f.herdrConfig);
  assert.ok(existsSync(join(f.caller, 'relative XDG/opencode/skills/herdr-relay/SKILL.md')));
  assert.equal(existsSync(join(f.candidate, 'relative XDG')), false);
});

test('--no-herdr is preserved across handover and never discovers, links or reloads Herdr', async t => {
  const f = fixture(t), result = await f.install({ skipHerdr: true });
  assert.equal(result.complete, true); assert.equal(result.herdr.reason, 'disabled_by_option');
  assert.deepEqual(json(f.stateFile).calls, []); assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.originalConfig);
});

test('candidate handover preserves an explicitly disabled plugin and reports absent Herdr without starting it', async t => {
  const f = fixture(t), state = json(f.stateFile);
  state.plugins = [{ plugin_id: pluginId, plugin_root: f.previous, enabled: false }];
  writeFileSync(f.stateFile, JSON.stringify(state));
  const disabled = await f.install();
  assert.equal(disabled.complete, true); assert.equal(disabled.herdr.reason, 'plugin_disabled');
  assert.deepEqual(json(f.stateFile).plugins, state.plugins); assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.originalConfig);
  process.env.HERDR_BIN_PATH = join(f.root, 'missing-herdr');
  const missing = await f.install();
  assert.equal(missing.complete, true); assert.equal(missing.herdr.reason, 'not_installed');
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.originalConfig);
});

test('candidate shortcut conflicts return incomplete setup while retaining activation and unrelated keys', async t => {
  const f = fixture(t), source = f.originalConfig + '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="other.toggle"\n';
  writeFileSync(f.herdrConfig, source);
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.installer.state, 'incomplete');
  assert.equal(result.herdr.phase, 'shortcut_preflight'); assert.equal(result.skills.version, '0.2.5');
  assert.equal(realpathSync(f.cli), join(f.candidate, 'src/cli.mjs')); assert.equal(readFileSync(f.herdrConfig, 'utf8'), source);
  assert.equal(json(f.stateFile).calls.some(args => args[1] === 'link' || args[2] === 'server'), false);
});

test('the parent installation lock remains held while the candidate process configures Herdr', async t => {
  const f = fixture(t); writeFileSync(f.gate, 'wait');
  const installing = f.install();
  try {
    const until = Date.now() + 5000;
    while (!existsSync(f.entered) && Date.now() < until) await delay(20);
    assert.ok(existsSync(f.entered), 'The candidate process must reach the native link command');
    assert.notEqual(json(f.probe).pid, process.pid);
    await assert.rejects(f.install(), { code: 'already_running' });
  } finally { rmSync(f.gate, { force: true }); await installing; }
});

test('lost setup acknowledgement never reports success and an idempotent retry reconciles the already-applied setup', async t => {
  const f = fixture(t);
  f.dependencies.runReleaseSetup = async (...args) => { await execute(...args); throw Object.assign(Error('Lost fixture acknowledgement'), { code: 'fixture_lost_ack' }); };
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.installer.state, 'unconfirmed'); assert.equal(result.installer.code, 'fixture_lost_ack');
  assert.equal(result.installer.version, null); assert.equal(result.installer.expectedVersion, '0.2.5');
  assert.equal(result.skills, null); assert.equal(result.herdr, null); assert.match(readFileSync(f.herdrConfig, 'utf8'), /quintindk\.herdr-relay\.toggle/);
  delete f.dependencies.runReleaseSetup;
  const retry = await f.install();
  assert.equal(retry.complete, true); assert.equal(retry.herdr.shortcut.state, 'existing');
});

test('a later CLI activation fences completion without reverting the later choice', async t => {
  const f = fixture(t);
  f.dependencies.runReleaseSetup = async (...args) => {
    const result = await execute(...args);
    rmSync(f.cli); symlinkSync(join(f.previous, 'src/cli.mjs'), f.cli);
    return result;
  };
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.installer.state, 'unconfirmed');
  assert.equal(result.installer.code, 'installer_activation_changed'); assert.equal(result.installer.version, null);
  assert.equal(realpathSync(f.cli), join(f.previous, 'src/cli.mjs'));
});

test('candidate source changes after its acknowledgement cannot be certified as completed setup', async t => {
  const f = fixture(t);
  f.dependencies.runReleaseSetup = async (...args) => {
    const result = await execute(...args);
    writeFileSync(join(f.candidate, 'src/cli.mjs'), '// Changed after setup\n');
    return result;
  };
  const result = await f.install();
  assert.equal(result.complete, false); assert.equal(result.installer.state, 'unconfirmed');
  assert.equal(result.installer.code, 'release_conflict'); assert.equal(result.installer.version, null);
});

test('unknown setup protocols and missing entrypoints fail before switching the CLI', async t => {
  const f = fixture(t), path = join(f.candidate, 'package.json'), manifest = json(path);
  writeFileSync(path, JSON.stringify({ ...manifest, relayInstaller: { protocol: 2 } }));
  await assert.rejects(f.install(), { code: 'installer_protocol_unsupported' });
  assert.equal(realpathSync(f.cli), join(f.previous, 'src/cli.mjs'));
  writeFileSync(path, JSON.stringify(manifest)); rmSync(join(f.candidate, 'src/release-setup.mjs'));
  await assert.rejects(f.install(), { code: 'installer_entrypoint_missing' });
  assert.equal(realpathSync(f.cli), join(f.previous, 'src/cli.mjs')); assert.deepEqual(json(f.stateFile).calls, []);
});

test('malformed, wrong-release and contradictory child receipts cannot claim setup completion', async t => {
  const f = fixture(t);
  for (const stdout of ['not json', JSON.stringify({ protocol: 1, installerVersion: '0.2.6', complete: true }), JSON.stringify({ protocol: 1, complete: true })]) {
    f.dependencies.runReleaseSetup = async () => ({ stdout });
    const result = await f.install();
    assert.equal(result.complete, false); assert.equal(result.installer.state, 'unconfirmed');
    assert.equal(result.installer.code, 'invalid_installer_response');
    assert.equal(realpathSync(f.cli), join(f.candidate, 'src/cli.mjs'));
  }
  for (const change of [{ servicesChanged: true }, { skills: { state: 'skill_conflict' } },
    { skills: { state: 'skills_current', version: '0.2.4' } }, { herdr: { complete: false } },
    { herdr: { state: 'herdr_installed', complete: true, installation: f.previous } }]) {
    f.dependencies.runReleaseSetup = async (_command, args) => {
      const request = JSON.parse(args[1]);
      return { stdout: JSON.stringify({ protocol: 1, installerVersion: request.version, installation: f.candidate,
        packageFingerprint: request.packageFingerprint, servicesChanged: false, complete: true,
        skills: { state: 'skills_current', version: request.version },
        herdr: { state: 'herdr_installed', complete: true, installation: f.candidate }, ...change }) };
    };
    const result = await f.install();
    assert.equal(result.complete, false); assert.equal(result.installer.code, 'invalid_installer_response');
  }
});

test('the standalone setup entrypoint rejects a different fingerprint or inactive CLI before any configuration writes', async t => {
  const f = fixture(t), entrypoint = join(f.candidate, 'src/release-setup.mjs');
  const request = { version: '0.2.5', packageFingerprint: releaseInfo(f.candidate).fingerprint, cliPath: f.cli, configDirectory: f.config, herdrConfig: f.herdrConfig };
  await assert.rejects(execute(process.execPath, [entrypoint, JSON.stringify({ ...request, packageFingerprint: '0'.repeat(64) })]), error => /release_conflict/.test(error.stderr));
  await assert.rejects(execute(process.execPath, [entrypoint, JSON.stringify(request)]), error => /installer_activation_changed/.test(error.stderr));
  assert.equal(existsSync(f.probe), false); assert.deepEqual(json(f.stateFile).calls, []);
  assert.equal(readFileSync(f.herdrConfig, 'utf8'), f.originalConfig);
});

test('pre-handover target releases keep an explicit legacy-compatibility path rather than pretending candidate code ran', async t => {
  const f = fixture(t), path = join(f.candidate, 'package.json'), manifest = json(path);
  delete manifest.relayInstaller; writeFileSync(path, JSON.stringify(manifest));
  delete f.dependencies.installSkills; delete f.dependencies.installHerdrPanel;
  const result = await f.install();
  assert.equal(result.complete, true); assert.equal(result.installer.mode, 'legacy_compatibility');
  assert.equal(result.installer.version, releaseVersion); assert.equal(result.installer.protocol, null);
  assert.equal(existsSync(f.probe), false); assert.equal(result.herdr.candidateSetupProbe, undefined);
});
