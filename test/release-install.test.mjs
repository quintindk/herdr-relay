import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stageRelease, hashBytes } from '../src/release-install.mjs';
import { compatibility, assertSupportedRelease } from '../src/release-info.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/release-stage-'), artifact = join(root, 'fixture.tgz'), bytes = Buffer.from('fixture package bytes');
  writeFileSync(artifact, bytes); const f = { root, artifact, bytes, installs: 0, audits: 0, version: '0.2.1' };
  f.input = { artifact, sha256: hashBytes(bytes), directory: join(root, 'releases') };
  f.run = async (command, args, options) => {
    assert.equal(command, 'npm');
    if (args[0] === 'install') {
      f.installs++; assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--omit=dev'));
      const prefix = args[args.indexOf('--prefix') + 1], path = join(prefix, 'node_modules/herdr-relay');
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'herdr-relay', version: f.version, relayCompatibility: f.contract ?? compatibility }));
      return { stdout: '' };
    }
    assert.equal(args[0], 'audit'); assert.ok(options.cwd); f.audits++;
    if (f.auditUnavailable) throw Error('Registry unavailable');
    return { stdout: JSON.stringify({ metadata: { vulnerabilities: { total: f.vulnerabilities ?? 0 } } }) };
  };
  t.after(() => rmSync(root, { recursive: true, force: true })); return f;
}

test('verified artifact stages side-by-side with ignored scripts and a fresh audit, and exact retries never overwrite it', async t => {
  const f = fixture(t), result = await stageRelease(f.input, { run: f.run });
  assert.equal(result.version, '0.2.1'); assert.equal(result.auditVerified, true); assert.equal(result.reused, false);
  const original = readFileSync(join(result.directory, 'package.json'), 'utf8');
  const retry = await stageRelease({ ...f.input, version: result.version }, { run: f.run });
  assert.equal(retry.reused, true); assert.equal(f.installs, 1); assert.equal(f.audits, 2);
  assert.equal(readFileSync(join(result.directory, 'package.json'), 'utf8'), original);
  writeFileSync(f.artifact, 'changed bytes');
  await assert.rejects(stageRelease({ ...f.input, version: result.version, sha256: hashBytes(Buffer.from('changed bytes')) }, { run: f.run }), { code: 'release_conflict' });
});

test('checksum mismatch, audit findings/outage and incompatible schemas fail before returning an installable release', async t => {
  const f = fixture(t);
  await assert.rejects(stageRelease({ ...f.input, sha256: '0'.repeat(64) }, { run: f.run }), { code: 'release_checksum_mismatch' });
  assert.equal(f.installs, 0);
  f.vulnerabilities = 1;
  await assert.rejects(stageRelease(f.input, { run: f.run }), { code: 'release_audit_failed' });
  assert.equal(existsSync(join(f.input.directory, f.version)), false);
  f.vulnerabilities = 0; f.auditUnavailable = true;
  await assert.rejects(stageRelease(f.input, { run: f.run }), /Registry unavailable/);
  f.auditUnavailable = false; f.contract = { ...compatibility, backendSchema: 3 };
  await assert.rejects(stageRelease(f.input, { run: f.run }), { code: 'upgrade_incompatible' });
});

test('a cached package changed after verification is rejected before activation or another install', async t => {
  const f = fixture(t), result = await stageRelease(f.input, { run: f.run });
  const path = join(result.directory, 'package.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
  await assert.rejects(stageRelease({ ...f.input, version: result.version }, { run: f.run }), { code: 'release_conflict' });
  assert.equal(f.installs, 1);
});

test('version downloads verify the exact GitHub checksum asset and refuse malformed versions or redirects to HTTP', async t => {
  const f = fixture(t), urls = [];
  const fetcher = async url => {
    urls.push(url); assert.match(url, /^https:\/\/github.com\/quintindk\/herdr-relay\/releases\/download\/v0\.2\.1\//);
    return new Response(url.endsWith('SHA256SUMS') ? `${hashBytes(f.bytes)}  herdr-relay-${f.version}.tgz\n` : f.bytes);
  };
  const result = await stageRelease({ version: f.version, directory: f.input.directory }, { run: f.run, fetch: fetcher });
  assert.equal(result.sha256, f.input.sha256); assert.equal(urls.length, 2);
  await assert.rejects(stageRelease({ version: '../latest' }, { run: f.run, fetch: fetcher }), { code: 'invalid_release' });
  await assert.rejects(stageRelease({ version: f.version, directory: f.input.directory }, { run: f.run, fetch: async () => {
    const response = new Response(''); Object.defineProperty(response, 'url', { value: 'http://untrusted/' }); return response;
  } }), { code: 'release_download_failed' });
});

test('RC4 is the minimum release and older versions fail before any download or installation', async t => {
  for (const version of ['0.2.1-rc4', '0.2.1-rc10', '0.2.1', '0.2.2', '0.3.0', '1.0.0']) assert.doesNotThrow(() => assertSupportedRelease(version));
  for (const version of ['0.1.99', '0.2.0', '0.2.1-rc1', '0.2.1-rc3', '0.2.1-rc.4', '0.2.1-beta', 'invalid']) assert.throws(() => assertSupportedRelease(version), { code: 'upgrade_incompatible' });
  const f = fixture(t);
  await assert.rejects(stageRelease({ version: '0.2.1-rc3', directory: f.input.directory }, { run: f.run, fetch: () => { throw Error('Must not download'); } }), { code: 'upgrade_incompatible' });
  assert.equal(f.installs, 0); assert.equal(existsSync(f.input.directory), false);
});
