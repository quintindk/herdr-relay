import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { hashBytes } from '../src/release-install.mjs';
import { releaseInfo } from '../src/release-info.mjs';
import { requireValue } from '../src/protocol.mjs';

// Test-only, deliberately NOT shipped in the public package. Immutable baseline
// releases may acquire new advisories. Rehearse leaving RC4 without pretending
// they pass today's production gate. stageRelease's candidate audit stays strict.
export async function upgradeBaselineFixture({ directory }, dependencies = {}) {
  const version = '0.2.1-rc4';
  directory = resolve(directory);
  const root = dirname(directory);
  const scratch = resolve(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode');
  requireValue(dirname(root) === scratch && realpathSync(scratch) === scratch && basename(root).startsWith('relay-upgrade-smoke-') && basename(directory) === 'releases' && realpathSync(root) === root,
    'invalid_fixture_directory', 'The RC4 baseline may only be installed in a fresh isolated upgrade-smoke directory');
  const run = dependencies.run ?? promisify(execFile), fetcher = dependencies.fetch ?? fetch, pause = dependencies.delay ?? delay;
  const read = async (url, maximum) => {
    // Only read-only transient failures retry. Integrity and permanent refusals
    // still fail immediately, and no partial response survives another attempt.
    for (let attempt = 1; attempt <= 3; attempt++) {
      let response, transientHttp = false;
      try {
        response = await fetcher(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
        requireValue(new URL(response.url || url).protocol === 'https:', 'fixture_download_failed', 'RC4 asset redirect must remain HTTPS');
        transientHttp = [408, 429, 500, 502, 503, 504].includes(response.status);
        requireValue(response.ok, 'fixture_download_failed', `RC4 asset download failed (HTTP ${response.status}, attempt ${attempt}/3) for ${new URL(url).pathname}`);
        requireValue(response.body, 'fixture_download_failed', 'RC4 asset response has no body');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; requireValue(size <= maximum, 'fixture_too_large', 'RC4 asset exceeded its size bound'); chunks.push(chunk); }
        return Buffer.concat(chunks);
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        const transientTransport = ['AbortError', 'TimeoutError'].includes(error.name) ||
          error.name === 'TypeError' && ['fetch failed', 'terminated'].includes(error.message);
        if (!transientHttp && !transientTransport) throw error;
        if (attempt === 3) {
          if (!transientTransport) throw error;
          requireValue(false, 'fixture_download_failed', `RC4 asset download failed after 3 attempts (${error.name}) for ${new URL(url).pathname}`);
        }
        const retryAfter = Number(response?.headers.get('retry-after'));
        await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : attempt * 1000);
      }
    }
  };
  const name = `herdr-relay-${version}.tgz`, url = `https://github.com/quintindk/herdr-relay/releases/download/v${version}`;
  const sums = (await read(`${url}/SHA256SUMS`, 65536)).toString('utf8');
  const entries = sums.split('\n').flatMap(line => { const m = /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line); return m?.[2] === name ? [m[1]] : []; });
  requireValue(entries.length === 1, 'invalid_fixture_checksum', 'One exact RC4 checksum entry required');
  const bytes = await read(`${url}/${name}`, 16 * 1024 * 1024);
  requireValue(hashBytes(bytes) === entries[0], 'fixture_checksum_mismatch', 'RC4 release bytes differ from the published checksum');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = join(directory, `baseline-${version}`); mkdirSync(prefix, { mode: 0o700 });
  const artifact = join(prefix, 'package.tgz'); writeFileSync(artifact, bytes, { flag: 'wx', mode: 0o600 });
  await run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', artifact], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  const installed = releaseInfo(join(prefix, 'node_modules/herdr-relay'));
  requireValue(installed.version === version, 'fixture_version_mismatch', 'RC4 artifact version differs');
  let audit;
  try { audit = await run('npm', ['audit', '--omit=dev', '--json', '--fetch-retries=0', '--fetch-timeout=15000'], { cwd: prefix, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { audit = error; }
  let report; try { report = JSON.parse(audit.stdout); } catch {}
  requireValue(Number.isSafeInteger(report?.metadata?.vulnerabilities?.total), 'fixture_audit_unavailable', 'Baseline audit must return actual findings, not an assumed pass');
  return { ...installed, auditVerified: false, baselineFixtureOnly: true, productionActivationAllowed: false,
    sha256: entries[0], productionAuditFindings: report.metadata.vulnerabilities.total,
    advisories: [...new Set(Object.values(report.vulnerabilities ?? {}).flatMap(v => v.via.filter(item => typeof item === 'object').map(item => item.url)))] };
}
