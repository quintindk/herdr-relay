import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashBytes } from '../src/release-install.mjs';
import { releaseInfo } from '../src/release-info.mjs';
import { requireValue } from '../src/protocol.mjs';

// Test-only, deliberately NOT shipped in the public package. Old immutable
// releases may acquire new advisories. Rehearse leaving them without pretending
// they pass today's production gate. stageRelease's candidate audit stays strict.
export async function historicalUpgradeFixture({ version, directory }, dependencies = {}) {
  requireValue(['0.2.0-rc.4', '0.2.0-rc.5', '0.2.0-rc.6'].includes(version), 'invalid_fixture_baseline', 'Only explicit historical upgrade baselines are supported');
  directory = resolve(directory);
  const root = dirname(directory);
  requireValue(dirname(root) === '/tmp/opencode' && basename(root).startsWith('relay-upgrade-smoke-') && basename(directory) === 'releases' && realpathSync(root) === root,
    'invalid_fixture_directory', 'Historical releases may only be installed in a fresh isolated upgrade-smoke directory');
  const run = dependencies.run ?? promisify(execFile), fetcher = dependencies.fetch ?? fetch;
  const read = async (url, maximum) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
    requireValue(response.ok && new URL(response.url || url).protocol === 'https:', 'fixture_download_failed', 'Historical asset download failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; requireValue(size <= maximum, 'fixture_too_large', 'Historical asset exceeded its size bound'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const name = `herdr-relay-${version}.tgz`, url = `https://github.com/quintindk/herdr-relay/releases/download/v${version}`;
  const sums = (await read(`${url}/SHA256SUMS`, 65536)).toString('utf8');
  const entries = sums.split('\n').flatMap(line => { const m = /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line); return m?.[2] === name ? [m[1]] : []; });
  requireValue(entries.length === 1, 'invalid_fixture_checksum', 'One exact historical checksum entry required');
  const bytes = await read(`${url}/${name}`, 16 * 1024 * 1024);
  requireValue(hashBytes(bytes) === entries[0], 'fixture_checksum_mismatch', 'Historical release bytes differ from the published checksum');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = join(directory, `historical-${version}`); mkdirSync(prefix, { mode: 0o700 });
  const artifact = join(prefix, 'package.tgz'); writeFileSync(artifact, bytes, { flag: 'wx', mode: 0o600 });
  await run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const installed = releaseInfo(join(prefix, 'node_modules/herdr-relay'));
  requireValue(installed.version === version, 'fixture_version_mismatch', 'Historical artifact version differs');
  let audit;
  try { audit = await run('npm', ['audit', '--omit=dev', '--json', '--fetch-retries=0', '--fetch-timeout=15000'], { cwd: prefix, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { audit = error; }
  let report; try { report = JSON.parse(audit.stdout); } catch {}
  requireValue(Number.isSafeInteger(report?.metadata?.vulnerabilities?.total), 'fixture_audit_unavailable', 'Historical audit must return actual findings, not an assumed pass');
  return { ...installed, auditVerified: false, historicalFixtureOnly: true, productionActivationAllowed: false,
    sha256: entries[0], productionAuditFindings: report.metadata.vulnerabilities.total,
    advisories: [...new Set(Object.values(report.vulnerabilities ?? {}).flatMap(v => v.via.filter(item => typeof item === 'object').map(item => item.url)))] };
}
