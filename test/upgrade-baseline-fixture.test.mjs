import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { upgradeBaselineFixture } from '../scripts/upgrade-baseline-fixture.mjs';
import { hashBytes } from '../src/release-install.mjs';

function fixtureDirectory(t) {
  const root = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'relay-upgrade-smoke-baseline-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'releases');
}

function fixtureRun(calls) {
  return async (command, args) => {
    assert.equal(command, 'npm'); calls.push(args[0]);
    if (args[0] === 'install') {
      const pkg = join(args[2], 'node_modules/herdr-relay'); mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'herdr-relay', version: '0.2.1-rc4',
        relayCompatibility: { protocol: 'relay/0.2', backendSchema: 2, nodeSchema: 1 } }));
    }
    return { stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} }) };
  };
}

test('RC4 fixture verifies immutable bytes, reports actual advisory counts and never claims production approval', async t => {
  const root = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'relay-upgrade-smoke-baseline-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('fixture artifact'), sha = hashBytes(bytes), version = '0.2.1-rc4';
  const calls = [];
  const dependencies = {
    fetch: async url => new Response(url.endsWith('SHA256SUMS') ? `${sha}  herdr-relay-${version}.tgz\n` : bytes),
    run: async (command, args) => {
      calls.push(args);
      if (args[0] === 'install') {
        assert.ok(args.includes('--ignore-scripts'));
        const pkg = join(args[2], 'node_modules/herdr-relay'); mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'herdr-relay', version, relayCompatibility: { protocol: 'relay/0.2', backendSchema: 2, nodeSchema: 1 } }));
        return { stdout: '' };
      }
      throw Object.assign(Error('audit findings'), { stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 4 } }, vulnerabilities: {
        toml: { via: [{ url: 'https://github.com/advisories/GHSA-9qmh-m7c6-f92p' }] },
      } }) });
    },
  };
  const result = await upgradeBaselineFixture({ directory: join(root, 'releases') }, dependencies);
  assert.equal(result.baselineFixtureOnly, true); assert.equal(result.auditVerified, false);
  assert.equal(result.productionActivationAllowed, false); assert.equal(result.productionAuditFindings, 4);
  assert.ok(calls.some(args => args[0] === 'audit'));
  await assert.rejects(upgradeBaselineFixture({ directory: '/private/real-release-store' }, dependencies), { code: 'invalid_fixture_directory' });
});

test('RC4 fixture retries transient asset responses within a fixed bound and installs only verified complete bytes', async t => {
  const directory = fixtureDirectory(t), bytes = Buffer.from('verified fixture'), sha = hashBytes(bytes);
  const calls = [], waits = [], attempts = new Map();
  const result = await upgradeBaselineFixture({ directory }, {
    fetch: async (url, options) => {
      assert.equal(options.redirect, 'follow'); assert.ok(options.signal instanceof AbortSignal);
      const attempt = (attempts.get(url) ?? 0) + 1; attempts.set(url, attempt);
      if (attempt === 1) return new Response('Unavailable', { status: url.endsWith('SHA256SUMS') ? 503 : 429,
        headers: { 'retry-after': '3600' } });
      return new Response(url.endsWith('SHA256SUMS') ? `${sha}  herdr-relay-0.2.1-rc4.tgz\n` : bytes);
    },
    delay: async ms => waits.push(ms), run: fixtureRun(calls),
  });
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.deepEqual(waits, [5000, 5000]); assert.deepEqual(calls, ['install', 'audit']);
  assert.equal(result.sha256, sha); assert.equal(result.productionActivationAllowed, false);
});

test('RC4 fixture retries interrupted requests and discards an incomplete response before retrying', async t => {
  const directory = fixtureDirectory(t), bytes = Buffer.from('complete fixture'), sha = hashBytes(bytes);
  const calls = [], waits = []; let requests = 0;
  const result = await upgradeBaselineFixture({ directory }, {
    fetch: async url => {
      requests++;
      if (requests === 1) throw new TypeError('fetch failed');
      if (requests === 2) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from('partial checksum')); },
        pull(controller) { controller.error(new TypeError('terminated')); },
      }));
      return new Response(url.endsWith('SHA256SUMS') ? `${sha}  herdr-relay-0.2.1-rc4.tgz\n` : bytes);
    },
    delay: async ms => waits.push(ms), run: fixtureRun(calls),
  });
  assert.equal(requests, 4); assert.deepEqual(waits, [1000, 2000]);
  assert.equal(result.sha256, sha); assert.deepEqual(calls, ['install', 'audit']);
});

test('RC4 fixture reports the HTTP status after exhausting transient read retries', async t => {
  const directory = fixtureDirectory(t), calls = [], waits = []; let requests = 0;
  await assert.rejects(upgradeBaselineFixture({ directory }, {
    fetch: async () => { requests++; return new Response('Unavailable', { status: 502 }); },
    delay: async ms => waits.push(ms), run: fixtureRun(calls),
  }), error => error.code === 'fixture_download_failed' && /HTTP 502/.test(error.message) && /attempt 3\/3/.test(error.message) && /SHA256SUMS/.test(error.message));
  assert.equal(requests, 3); assert.deepEqual(waits, [1000, 2000]); assert.deepEqual(calls, []);
});

test('RC4 fixture bounds transport timeouts and reports their failure without installing', async t => {
  const directory = fixtureDirectory(t), calls = [], waits = []; let requests = 0;
  await assert.rejects(upgradeBaselineFixture({ directory }, {
    fetch: async () => { requests++; throw new DOMException('Timed out', 'TimeoutError'); },
    delay: async ms => waits.push(ms), run: fixtureRun(calls),
  }), error => error.code === 'fixture_download_failed' && /3 attempts/.test(error.message) && /TimeoutError/.test(error.message));
  assert.equal(requests, 3); assert.deepEqual(waits, [1000, 2000]); assert.deepEqual(calls, []);
});

test('RC4 fixture does not retry permanent HTTP refusals or weaken HTTPS, size and checksum checks', async t => {
  const bytes = Buffer.from('fixture'), sha = hashBytes(bytes);
  for (const status of [400, 401, 403, 404]) {
    let requests = 0; const calls = [], waits = [];
    await assert.rejects(upgradeBaselineFixture({ directory: fixtureDirectory(t) }, {
      fetch: async () => { requests++; return new Response('Refused', { status }); },
      delay: async ms => waits.push(ms), run: fixtureRun(calls),
    }), error => error.code === 'fixture_download_failed' && error.message.includes(`HTTP ${status}`));
    assert.equal(requests, 1); assert.deepEqual(waits, []); assert.deepEqual(calls, []);
  }
  for (const [code, response] of [
    ['fixture_download_failed', () => Object.defineProperty(new Response('Unavailable', { status: 503 }), 'url', { value: 'http://example.invalid/asset' })],
    ['fixture_too_large', () => new Response(Buffer.alloc(65537))],
    ['invalid_fixture_checksum', () => new Response('not a checksum')],
    ['fixture_checksum_mismatch', url => new Response(url.endsWith('SHA256SUMS') ? `${sha}  herdr-relay-0.2.1-rc4.tgz\n` : 'different bytes')],
  ]) {
    const calls = [], waits = [];
    await assert.rejects(upgradeBaselineFixture({ directory: fixtureDirectory(t) }, {
      fetch: async url => response(url), delay: async ms => waits.push(ms), run: fixtureRun(calls),
    }), { code });
    assert.deepEqual(waits, []); assert.deepEqual(calls, []);
  }
});

test('RC4 fixture accepts only the explicitly selected canonical scratch root', async t => {
  const scratch = mkdtempSync('/tmp/opencode/relay-fixture-scratch-');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = mkdtempSync(join(scratch, 'relay-upgrade-smoke-'));
  const input = { directory: join(root, 'releases') };
  const dependencies = { fetch: async () => { throw Object.assign(Error('Fixture fetch reached'), { code: 'fixture_fetch_reached' }); } };
  await assert.rejects(upgradeBaselineFixture(input, dependencies), { code: 'invalid_fixture_directory' });
  const previous = process.env.RELAY_TEST_SCRATCH;
  try {
    process.env.RELAY_TEST_SCRATCH = scratch;
    await assert.rejects(upgradeBaselineFixture(input, dependencies), { code: 'fixture_fetch_reached' });
    await assert.rejects(upgradeBaselineFixture({ ...input, directory: '/private/real-release-store' }, dependencies), { code: 'invalid_fixture_directory' });
  } finally {
    if (previous === undefined) delete process.env.RELAY_TEST_SCRATCH;
    else process.env.RELAY_TEST_SCRATCH = previous;
  }
});
