import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { requireValue } from './protocol.mjs';
import { writePrivateJson, readPrivateJson } from './private-files.mjs';
import { releaseInfo } from './release-info.mjs';

export const releasesDirectory = () => join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'herdr-relay/releases');
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);
const validVersion = version => typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version);

async function download(url, maximum, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
  requireValue(response.ok && new URL(response.url || url).protocol === 'https:', 'release_download_failed', 'Release asset download failed');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; requireValue(size <= maximum, 'release_too_large', 'Release asset exceeds its size bound'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function stageRelease({ version, artifact, sha256, directory = releasesDirectory() }, dependencies = {}) {
  directory = resolve(directory);
  const execute = dependencies.run ?? run, fetcher = dependencies.fetch ?? fetch;
  requireValue(artifact ? typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256) : validVersion(version) && !sha256,
    'invalid_release', 'Choose --version VERSION or --artifact TGZ --sha256 TRUSTED_DIGEST');
  if (version !== undefined) requireValue(validVersion(version), 'invalid_release', 'Exact release version required, not latest');
  let bytes;
  if (artifact) bytes = readFileSync(resolve(artifact));
  else {
    const name = `herdr-relay-${version}.tgz`, origin = `https://github.com/quintindk/herdr-relay/releases/download/v${version}`;
    const sums = (await download(`${origin}/SHA256SUMS`, 65536, fetcher)).toString('utf8');
    const matches = sums.split('\n').flatMap(line => { const m = /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line); return m?.[2] === name ? [m[1]] : []; });
    requireValue(matches.length === 1, 'invalid_release', 'Release checksum asset must contain one exact package entry');
    sha256 = matches[0]; bytes = await download(`${origin}/${name}`, 16 * 1024 * 1024, fetcher);
  }
  requireValue(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024 && hashBytes(bytes) === sha256, 'release_checksum_mismatch', 'Artifact checksum does not match the trusted release checksum');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const auditAt = async cwd => {
    const audit = await execute('npm', ['audit', '--omit=dev', '--json', '--fetch-retries=0', '--fetch-timeout=15000'], { cwd, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    requireValue(JSON.parse(audit.stdout).metadata?.vulnerabilities?.total === 0, 'release_audit_failed', 'A fresh zero-finding production audit is required');
  };
  if (version && existsSync(join(directory, version))) {
    const receiptPath = join(directory, version, 'relay-release.json');
    requireValue(existsSync(receiptPath), 'release_conflict', 'Existing version directory has no verified receipt. Refuse overwriting or silently adopting it');
    const receipt = readPrivateJson(receiptPath);
    requireValue(receipt.sha256 === sha256 && receipt.version === version && receipt.auditVerified, 'release_conflict', 'Different artifact bytes already occupy this release version');
    const installed = releaseInfo(join(directory, version, 'node_modules/herdr-relay'));
    requireValue(installed.version === version && installed.fingerprint === receipt.packageFingerprint, 'release_conflict', 'Installed package content changed since verification');
    await auditAt(join(directory, version));
    return { ...receipt, directory: installed.directory, reused: true };
  }
  const stage = join(directory, `.stage-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 });
  const tarball = join(stage, 'package.tgz'); writeFileSync(tarball, bytes, { flag: 'wx', mode: 0o600 });
  // npm ignores dependency lifecycle scripts here. No service is stopped until
  // installation, compatibility checks and a fresh production audit succeed.
  await execute('npm', ['install', '--prefix', stage, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const installed = releaseInfo(join(stage, 'node_modules/herdr-relay'));
  requireValue(!version || installed.version === version, 'release_version_mismatch', 'Downloaded package version does not match the requested version');
  version = installed.version;
  await auditAt(stage);
  const destination = join(directory, version), receiptPath = join(destination, 'relay-release.json');
  if (existsSync(destination)) {
    requireValue(existsSync(receiptPath), 'release_conflict', 'Existing version directory has no verified receipt. Refuse overwriting or silently adopting it');
    const receipt = readPrivateJson(receiptPath);
    requireValue(receipt.sha256 === sha256 && receipt.version === version && receipt.auditVerified, 'release_conflict', 'Different artifact bytes already occupy this release version');
    requireValue(releaseInfo(join(destination, 'node_modules/herdr-relay')).fingerprint === receipt.packageFingerprint, 'release_conflict', 'Installed package content changed since verification');
    rmSync(stage, { recursive: true }); // This invocation's own private staging directory only.
    return { ...receipt, directory: join(destination, 'node_modules/herdr-relay'), reused: true };
  }
  const receipt = { version, sha256, compatibility: installed.compatibility, packageFingerprint: installed.fingerprint, auditVerified: true, verifiedAt: new Date().toISOString() };
  writePrivateJson(join(stage, 'relay-release.json'), receipt);
  renameSync(stage, destination); chmodSync(destination, 0o700);
  return { ...receipt, directory: join(destination, 'node_modules/herdr-relay'), reused: false };
}
