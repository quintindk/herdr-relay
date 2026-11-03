// Packed-package process regression only. Legacy releases and the synthetic
// future package stay inside fresh fixtures; none is a production activation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBytes } from '../src/release-install.mjs';
import { releaseInfo } from '../src/release-info.mjs';

const execute = promisify(execFile);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const pluginId = 'quintindk.herdr-relay';
const binding = '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="quintindk.herdr-relay.toggle"\n';

export async function verifyInstallerHandover({ artifact, packageDirectory }) {
  artifact = resolve(artifact); packageDirectory = realpathSync(packageDirectory);
  const manifest = json(join(packageDirectory, 'package.json')), version = manifest.version;
  assert.equal(manifest.relayInstaller?.protocol, 1, 'The packed candidate must declare its setup protocol');
  const scratch = resolve(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode'); mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, 'relay-installer-handover-')), tools = join(root, 'tools'); mkdirSync(tools);
  writeFileSync(join(tools, 'package.json'), '{"type":"module"}\n');
  const cache = resolve(process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? join(homedir(), '.npm'));
  const environment = home => ({ PATH: `${tools}:${process.env.PATH}`, HOME: home, TERM: 'xterm-256color', SHELL: '/bin/sh',
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), npm_config_cache: cache, TMPDIR: process.env.TMPDIR ?? scratch });
  const baseHome = join(root, 'build-home'); mkdirSync(baseHome);
  const baseEnv = environment(baseHome), serviceLog = join(root, 'forbidden-service-calls.jsonl');
  writeFileSync(join(tools, 'systemctl'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(serviceLog)},JSON.stringify(process.argv.slice(2))+'\\n');
process.exit(97);
`, { mode: 0o700 });
  const herdr = join(tools, 'herdr.mjs');
  writeFileSync(herdr, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const path=process.env.RELAY_HANDOVER_FIXTURE_STATE;
if(!path?.startsWith(${JSON.stringify(root + sep)})) throw Error('A private fixture state path is required');
const state=JSON.parse(readFileSync(path,'utf8')), args=process.argv.slice(2);
state.calls.push(args); let result;
if(args[0]==='plugin' && args[1]==='list') result={plugins:state.plugins};
else if(args[0]==='plugin' && args[1]==='link') {
  state.plugins=[...state.plugins.filter(plugin=>plugin.plugin_id!==${JSON.stringify(pluginId)}),{plugin_id:${JSON.stringify(pluginId)},plugin_root:args[2],enabled:true}];
  result={plugin:state.plugins.at(-1)};
}
else if(args[0]==='session' && args[1]==='list') result={sessions:[{name:'default',running:true},{name:'stopped',running:false}]};
else if(args.join(' ')==='--session default server reload-config') result={reloaded:true};
else {console.error(JSON.stringify({code:'unexpected_fixture_command',message:'Only plugin registration and configuration reload are allowed'}));process.exit(1);}
writeFileSync(path,JSON.stringify(state)); console.log(JSON.stringify({result}));
`, { mode: 0o700 });
  const run = (command, args, options = {}) => execute(command, args, { env: baseEnv, timeout: 240000, maxBuffer: 8 * 1024 * 1024, ...options });
  const audit = async cwd => {
    let output;
    try { output = await run('npm', ['audit', '--omit=dev', '--json', '--fetch-retries=0', '--fetch-timeout=15000'], { cwd, timeout: 30000 }); }
    catch (error) { output = error; }
    const report = JSON.parse(output.stdout);
    assert.ok(Number.isSafeInteger(report.metadata?.vulnerabilities?.total), 'An actual audit result is required');
    return report.metadata.vulnerabilities.total;
  };
  const legacy = async legacyVersion => {
    const prefix = join(root, `legacy-${legacyVersion}`); mkdirSync(prefix);
    const name = `herdr-relay-${legacyVersion}.tgz`, origin = `https://github.com/quintindk/herdr-relay/releases/download/v${legacyVersion}`;
    const download = async (url, maximum) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
      assert.ok(response.ok && new URL(response.url || url).protocol === 'https:', 'Legacy fixture download must use HTTPS');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= maximum); chunks.push(chunk); }
      return Buffer.concat(chunks);
    };
    const sums = (await download(`${origin}/SHA256SUMS`, 65536)).toString('utf8');
    const entries = sums.split('\n').flatMap(line => { const match = /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line); return match?.[2] === name ? [match[1]] : []; });
    assert.equal(entries.length, 1);
    const bytes = await download(`${origin}/${name}`, 16 * 1024 * 1024); assert.equal(hashBytes(bytes), entries[0]);
    const tarball = join(prefix, 'fixture.tgz'); writeFileSync(tarball, bytes, { flag: 'wx', mode: 0o600 });
    await run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
    const directory = join(prefix, 'node_modules/herdr-relay'); assert.equal(json(join(directory, 'package.json')).version, legacyVersion);
    return { directory, auditFindings: await audit(prefix), baselineFixtureOnly: true, productionActivationAllowed: false };
  };
  const makeCase = (name, initial, { existingBinding = false, conflict = false } = {}) => {
    const directory = join(root, name), home = join(directory, 'home'), bin = join(directory, 'bin');
    for (const path of [home, bin, join(directory, 'herdr')]) mkdirSync(path, { recursive: true });
    const config = join(directory, 'opencode'), herdrConfig = join(directory, 'herdr/config.toml'), state = join(directory, 'herdr-state.json');
    const original = '# Keep preferences\n[theme]\nname="one-dark"\n\n[[keys.command]]\nkey="prefix+e"\ntype="plugin_action"\ncommand="other.open"\n' +
      (conflict ? '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="other.toggle"\n' : existingBinding ? binding : '');
    writeFileSync(herdrConfig, original);
    writeFileSync(state, JSON.stringify({ calls: [], plugins: [{ plugin_id: 'other.plugin', enabled: true },
      { plugin_id: pluginId, enabled: true, plugin_root: initial }] }));
    const cli = join(bin, 'herdr-relay'); symlinkSync(join(initial, 'src/cli.mjs'), cli);
    return { directory, bin, cli, config, herdrConfig, original, state,
      env: { ...environment(home), PATH: `${bin}:${tools}:${process.env.PATH}`, HERDR_BIN_PATH: herdr,
        HERDR_CONFIG_PATH: herdrConfig, RELAY_HANDOVER_FIXTURE_STATE: state } };
  };
  const argumentsFor = (fixture, tarball) => ['release', 'install', '--artifact', tarball, '--sha256', hashBytes(readFileSync(tarball)),
    '--releases-dir', join(fixture.directory, 'releases'), '--upgrade-dir', join(fixture.directory, 'upgrades'),
    '--bin-dir', fixture.bin, '--config-dir', fixture.config];
  const cli = async (fixture, entrypoint, args) => {
    const running = run(process.execPath, [entrypoint, ...args], { cwd: fixture.directory, env: fixture.env });
    const pid = running.child.pid;
    let output, exitCode = 0;
    try { output = await running; }
    catch (error) { if (typeof error.code !== 'number') throw error; output = error; exitCode = error.code; }
    let value;
    try { value = JSON.parse(output.stdout); }
    catch { throw Error(`Installer fixture did not return JSON: ${output.stderr}. Fixture: ${fixture.directory}`); }
    return { value, exitCode, pid };
  };
  let candidateAudits = 0;
  const staged = (fixture, targetVersion, tarball) => {
    const prefix = join(fixture.directory, 'releases', targetVersion), receipt = json(join(prefix, 'relay-release.json'));
    const directory = join(prefix, 'node_modules/herdr-relay');
    assert.equal(receipt.version, targetVersion); assert.equal(receipt.sha256, hashBytes(readFileSync(tarball)));
    assert.equal(receipt.auditVerified, true); assert.equal(receipt.packageFingerprint, releaseInfo(directory).fingerprint);
    assert.equal(realpathSync(fixture.cli), join(directory, 'src/cli.mjs')); candidateAudits++;
    return directory;
  };
  const completed = (fixture, result, targetVersion, tarball) => {
    assert.equal(result.exitCode, 0); assert.equal(result.value.complete, true); assert.equal(result.value.servicesChanged, false);
    assert.equal(result.value.version, targetVersion); assert.equal(result.value.skills.version, targetVersion);
    assert.equal(result.value.herdr.state, 'herdr_installed'); assert.deepEqual(result.value.herdr.configReload.sessions, ['default']);
    const directory = staged(fixture, targetVersion, tarball);
    assert.equal(result.value.herdr.installation, directory);
    assert.equal(json(fixture.state).plugins.find(plugin => plugin.plugin_id === pluginId).plugin_root, directory);
    assert.equal(json(fixture.state).plugins.find(plugin => plugin.plugin_id === 'other.plugin').enabled, true);
    const source = readFileSync(fixture.herdrConfig, 'utf8'); assert.ok(source.startsWith(fixture.original));
    assert.equal((source.match(/key\s*=\s*"prefix\+t"/g) ?? []).length, 1);
    assert.equal(json(join(fixture.config, 'skills/herdr-relay/.herdr-relay-managed.json')).version, targetVersion);
  };
  let success = false;
  try {
    const old = await legacy('0.2.2'), previous = await legacy('0.2.3');
    const direct = makeCase('legacy direct is explicitly unsupported', old.directory);
    assert.equal((await run(process.execPath, [direct.cli, '--version'], { cwd: direct.directory, env: direct.env })).stdout.trim(), '0.2.2');
    const unsupported = await cli(direct, direct.cli, argumentsFor(direct, artifact));
    assert.equal(unsupported.exitCode, 0); assert.equal(unsupported.value.state, 'cli_activated');
    assert.notEqual(unsupported.value.complete, true, 'An immutable old process cannot gain the new setup implementation');
    assert.equal(readFileSync(direct.herdrConfig, 'utf8'), direct.original); assert.deepEqual(json(direct.state).calls, []);
    staged(direct, version, artifact);

    const bootstrap = makeCase('legacy candidate first bootstrap', old.directory);
    const bootstrapped = await cli(bootstrap, join(packageDirectory, 'src/cli.mjs'), argumentsFor(bootstrap, artifact));
    completed(bootstrap, bootstrapped, version, artifact);
    assert.equal(bootstrapped.value.installer.mode, 'candidate'); assert.equal(bootstrapped.value.installer.version, version);

    const released = makeCase('released 0.2.3 compatibility', previous.directory);
    const fromPrevious = await cli(released, released.cli, argumentsFor(released, artifact));
    completed(released, fromPrevious, version, artifact);
    assert.equal(fromPrevious.value.installer, undefined, 'Do not pretend the released 0.2.3 caller acquired handover');

    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version); assert.ok(match);
    const futureVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
    const future = join(root, 'synthetic future package'), futureArtifacts = join(root, 'future-artifacts'); mkdirSync(futureArtifacts);
    cpSync(packageDirectory, future, { recursive: true, filter: path => !relative(packageDirectory, path).split(sep).includes('node_modules') });
    for (const file of ['package.json', 'packages/opencode-relay/package.json', 'packages/opencode-relay/package-lock.json']) {
      const path = join(future, file), value = json(path); value.version = futureVersion;
      if (value.packages?.['']) value.packages[''].version = futureVersion;
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
    }
    const pluginManifest = join(future, 'herdr-plugin.toml');
    writeFileSync(pluginManifest, readFileSync(pluginManifest, 'utf8').replace(/^version = "[^"]+"$/m, `version = "${futureVersion}"`));
    const probe = join(root, 'candidate-process.json'), setupFile = join(future, 'src/release-setup.mjs');
    writeFileSync(setupFile, readFileSync(setupFile, 'utf8').replace('import { existsSync,', 'import { writeFileSync, existsSync,')
      .replace('async function setupMain() {', `async function setupMain() {\n  writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, version: releaseVersion }));`));
    const skillFile = join(future, 'src/skill-install.mjs');
    writeFileSync(skillFile, readFileSync(skillFile, 'utf8').replace('return { version: status.version, state:', 'return { fixtureCandidateCode: true, version: status.version, state:'));
    const herdrFile = join(future, 'src/herdr-install.mjs');
    writeFileSync(herdrFile, readFileSync(herdrFile, 'utf8').replace("return { state: 'herdr_installed', complete: true,", "return { fixtureCandidateCode: true, state: 'herdr_installed', complete: true,"));
    const [packed] = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', futureArtifacts], { cwd: future })).stdout);
    const futureArtifact = join(futureArtifacts, packed.filename);

    const handover = makeCase('current caller to future candidate', packageDirectory, { existingBinding: true });
    const handed = await cli(handover, handover.cli, argumentsFor(handover, futureArtifact));
    completed(handover, handed, futureVersion, futureArtifact);
    assert.equal(handed.value.installer.callerVersion, version); assert.equal(handed.value.installer.version, futureVersion);
    assert.equal(handed.value.installer.mode, 'candidate');
    assert.equal(handed.value.skills.fixtureCandidateCode, true); assert.equal(handed.value.herdr.fixtureCandidateCode, true);
    assert.notEqual(json(probe).pid, handed.pid); assert.equal(json(probe).parentPid, handed.pid); assert.equal(json(probe).version, futureVersion);
    const before = readFileSync(handover.herdrConfig, 'utf8'), files = readdirSync(join(handover.directory, 'herdr'));
    const retried = await cli(handover, handover.cli, argumentsFor(handover, futureArtifact));
    completed(handover, retried, futureVersion, futureArtifact);
    assert.equal(retried.value.skills.state, 'skills_current'); assert.equal(retried.value.herdr.shortcut.state, 'existing');
    assert.equal(readFileSync(handover.herdrConfig, 'utf8'), before); assert.deepEqual(readdirSync(join(handover.directory, 'herdr')), files);

    const conflict = makeCase('candidate shortcut conflict', packageDirectory, { conflict: true });
    const refused = await cli(conflict, conflict.cli, argumentsFor(conflict, futureArtifact));
    assert.equal(refused.exitCode, 1); assert.equal(refused.value.complete, false); assert.equal(refused.value.servicesChanged, false);
    assert.equal(refused.value.installer.version, futureVersion); assert.equal(refused.value.installer.state, 'incomplete');
    assert.equal(refused.value.herdr.phase, 'shortcut_preflight'); assert.equal(readFileSync(conflict.herdrConfig, 'utf8'), conflict.original);
    assert.equal(json(conflict.state).calls.some(args => args[1] === 'link' || args[2] === 'server'), false);
    staged(conflict, futureVersion, futureArtifact);
    assert.equal(existsSync(serviceLog), false, 'No fixture installer may administer a service');
    assert.equal(candidateAudits, 6);
    success = true;
    return { passed: true, version, candidateProcessVerified: true, candidateOnlySetupExecuted: true,
      legacyBootstrapVerified: true, immutable022LimitationVerified: true, released023SinglePass: true,
      retryIdempotent: true, conflictRefused: true, allCandidateAuditsVerified: true, candidateAuditChecks: candidateAudits,
      legacyFixtureAuditFindings: { '0.2.2': old.auditFindings, '0.2.3': previous.auditFindings },
      legacyProductionActivationAllowed: false, futureFixtureVersion: futureVersion, syntheticFutureRelease: true,
      userServicesTouched: false, credentialsCopied: false };
  } catch (error) { console.error(`Installer regression fixture retained at ${root}`); throw error; }
  finally { if (success) rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { artifact: { type: 'string' }, package: { type: 'string' } } });
  assert.ok(values.artifact && values.package, '--artifact and --package must identify the packed production installation');
  console.log(JSON.stringify(await verifyInstallerHandover({ artifact: values.artifact, packageDirectory: values.package }), null, 2));
}
