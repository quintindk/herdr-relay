import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { requireValue } from './protocol.mjs';
import { packageDirectory, releaseInfo, releaseVersion } from './release-info.mjs';
import { installSkills } from './skill-install.mjs';
import { installHerdrPanel } from './herdr-install.mjs';

const execute = promisify(execFile);
const protocol = 1;

// The fixed entrypoint stays inside the fingerprint-verified package. A manifest
// cannot nominate an arbitrary executable or silently downgrade an unknown protocol.
export function releaseSetupCapability(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.relayInstaller === undefined) return null;
  requireValue(manifest.relayInstaller?.protocol === protocol, 'installer_protocol_unsupported',
    'This release needs a newer installer. Use its verified candidate CLI to complete installation.');
  const entrypoint = join(directory, 'src/release-setup.mjs');
  requireValue(lstatSync(entrypoint, { throwIfNoEntry: false })?.isFile(), 'installer_entrypoint_missing',
    'The release declares installer handover but does not contain its setup entrypoint');
  return { protocol, entrypoint };
}

function activeCli(cliPath, directory) {
  requireValue(typeof cliPath === 'string' && isAbsolute(cliPath) &&
    lstatSync(cliPath, { throwIfNoEntry: false })?.isSymbolicLink() &&
    realpathSync(cliPath) === join(realpathSync(directory), 'src/cli.mjs'), 'installer_activation_changed',
  'The public CLI no longer points to this release. Refuse configuring a different release.');
}

export async function setupReleaseLocally({ sourceDirectory, configDirectory, herdrConfig, skipHerdr }, dependencies = {}) {
  let skills, herdr;
  try { skills = (dependencies.installSkills ?? installSkills)({ sourceDirectory, configDirectory }); }
  catch (error) { skills = { state: 'skill_setup_failed', code: error.code ?? 'skill_setup_failed', message: error.message,
    instruction: 'Managed skill setup is incomplete. Resolve the reported error, then rerun release install. Running chats were not restarted.' }; }
  try { herdr = await (dependencies.installHerdrPanel ?? installHerdrPanel)({ sourceDirectory, herdrConfig, skip: skipHerdr }); }
  catch (error) { herdr = { state: 'herdr_setup_failed', complete: false, code: error.code ?? 'herdr_setup_failed', message: error.message,
    instruction: 'Herdr setup is incomplete. Resolve the reported error, then rerun release install. No services or existing panels were restarted.' }; }
  return { skills, herdr, complete: ['skills_installed', 'skills_current'].includes(skills?.state) && herdr?.complete === true };
}

// The caller retains its installation lock while this setup-only child runs.
// It neither stages again nor acquires the parent's lock, and never administers
// backend/node services. Relative CLI options retain the original caller's cwd.
export async function finishReleaseSetup({ release, capability, cliPath, configDirectory, herdrConfig, skipHerdr }, dependencies = {}) {
  const installer = { mode: capability ? 'candidate' : 'legacy_compatibility', protocol: capability?.protocol ?? null,
    callerVersion: releaseVersion, version: capability ? release.version : releaseVersion };
  try {
    activeCli(cliPath, release.directory);
    let result;
    if (capability) {
      const request = { version: release.version, packageFingerprint: release.fingerprint, cliPath,
        ...(configDirectory !== undefined ? { configDirectory: resolve(configDirectory) } : {}),
        ...(herdrConfig !== undefined ? { herdrConfig: resolve(herdrConfig) } : {}),
        ...(skipHerdr !== undefined ? { skipHerdr } : {}) };
      const output = await (dependencies.runReleaseSetup ?? execute)(process.execPath, [capability.entrypoint, JSON.stringify(request)],
        { cwd: process.cwd(), timeout: dependencies.setupTimeoutMs ?? 120000, maxBuffer: 4 * 1024 * 1024 });
      try { result = JSON.parse(output.stdout); }
      catch { requireValue(false, 'invalid_installer_response', 'Candidate setup did not return valid JSON'); }
      requireValue(result?.protocol === protocol && result.installerVersion === release.version &&
        result.installation === realpathSync(release.directory) && result.packageFingerprint === release.fingerprint &&
        result.servicesChanged === false && typeof result.complete === 'boolean' &&
        result.skills && typeof result.skills === 'object' && result.herdr && typeof result.herdr === 'object' &&
        (!result.complete || ['skills_installed', 'skills_current'].includes(result.skills.state) && result.skills.version === release.version &&
          result.herdr.complete === true && (result.herdr.state === 'herdr_skipped' ||
            result.herdr.state === 'herdr_installed' && result.herdr.installation === result.installation)),
      'invalid_installer_response', 'Candidate setup did not confirm the expected release, scope and completion');
    } else result = await setupReleaseLocally({ sourceDirectory: release.directory, configDirectory, herdrConfig, skipHerdr }, dependencies);
    activeCli(cliPath, release.directory);
    requireValue(releaseInfo(release.directory).fingerprint === release.fingerprint, 'release_conflict',
      'Installed release content changed during setup');
    return { complete: result.complete, skills: result.skills, herdr: result.herdr,
      installer: { ...installer, state: result.complete ? 'complete' : 'incomplete' } };
  } catch (error) {
    let failure;
    for (const line of String(error.stderr ?? '').trim().split('\n').reverse()) {
      try { const value = JSON.parse(line); if (typeof value.code === 'string' && typeof value.message === 'string') { failure = value; break; } } catch {}
    }
    return { complete: false, skills: null, herdr: null, installer: { ...installer,
      ...(capability ? { version: null, expectedVersion: release.version } : {}), state: 'unconfirmed',
      code: failure?.code ?? (typeof error.code === 'string' ? error.code : 'candidate_setup_unconfirmed'),
      message: failure?.message ?? error.message,
      instruction: 'The verified CLI was activated, but setup completion was not confirmed. Inspect the error and rerun the same release install command. No service restart is required.' } };
  }
}

async function setupMain() {
  requireValue(process.argv.length === 3 && process.argv[2].length <= 32768, 'invalid_installer_request', 'One bounded installer handover request is required');
  const request = JSON.parse(process.argv[2]);
  const fields = ['version', 'packageFingerprint', 'cliPath', 'configDirectory', 'herdrConfig', 'skipHerdr'];
  requireValue(request && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).every(key => fields.includes(key)) &&
    request.version === releaseVersion && /^[a-f0-9]{64}$/.test(request.packageFingerprint ?? '') &&
    ['configDirectory', 'herdrConfig'].every(key => request[key] === undefined || typeof request[key] === 'string' && isAbsolute(request[key])) &&
    (request.skipHerdr === undefined || typeof request.skipHerdr === 'boolean'), 'invalid_installer_request', 'Invalid installer handover identity or options');
  const release = releaseInfo(packageDirectory);
  requireValue(releaseSetupCapability(packageDirectory)?.protocol === protocol, 'invalid_installer_request', 'This package does not declare the expected setup protocol');
  requireValue(release.fingerprint === request.packageFingerprint, 'release_conflict', 'Candidate setup package differs from the verified release');
  activeCli(request.cliPath, packageDirectory);
  const result = await setupReleaseLocally({ sourceDirectory: packageDirectory,
    configDirectory: request.configDirectory, herdrConfig: request.herdrConfig, skipHerdr: request.skipHerdr });
  activeCli(request.cliPath, packageDirectory);
  requireValue(releaseInfo(packageDirectory).fingerprint === request.packageFingerprint, 'release_conflict', 'Candidate package changed during setup');
  console.log(JSON.stringify({ protocol, installerVersion: releaseVersion, installation: realpathSync(packageDirectory),
    packageFingerprint: request.packageFingerprint, servicesChanged: false, ...result }));
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await setupMain(); }
  catch (error) { console.error(JSON.stringify({ code: error.code ?? 'candidate_setup_failed', message: error.message })); process.exitCode = 1; }
}
