import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { historicalUpgradeFixture } from '../scripts/historical-upgrade-fixture.mjs';
import { hashBytes } from '../src/release-install.mjs';

test('historical fixture verifies immutable bytes, reports actual advisory counts and never claims production approval', async t => {
  const root = mkdtempSync('/tmp/opencode/relay-upgrade-smoke-baseline-test-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('fixture artifact'), sha = hashBytes(bytes), version = '0.2.0-rc.6';
  const calls = [];
  const dependencies = {
    fetch: async url => new Response(url.endsWith('SHA256SUMS') ? `${sha}  herdr-relay-${version}.tgz\n` : bytes),
    run: async (command, args) => {
      calls.push(args);
      if (args[0] === 'install') {
        assert.ok(args.includes('--ignore-scripts'));
        const pkg = join(args[2], 'node_modules/herdr-relay'); mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'herdr-relay', version, relayCompatibility: { protocol: 'relay/0.2', backendSchema: 1, nodeSchema: 1 } }));
        return { stdout: '' };
      }
      throw Object.assign(Error('audit findings'), { stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 4 } }, vulnerabilities: {
        toml: { via: [{ url: 'https://github.com/advisories/GHSA-9qmh-m7c6-f92p' }] },
      } }) });
    },
  };
  const result = await historicalUpgradeFixture({ version, directory: join(root, 'releases') }, dependencies);
  assert.equal(result.historicalFixtureOnly, true); assert.equal(result.auditVerified, false);
  assert.equal(result.productionActivationAllowed, false); assert.equal(result.productionAuditFindings, 4);
  assert.ok(calls.some(args => args[0] === 'audit'));
  await assert.rejects(historicalUpgradeFixture({ version: '0.2.0-rc.8', directory: join(root, 'releases') }, dependencies), { code: 'invalid_fixture_baseline' });
  await assert.rejects(historicalUpgradeFixture({ version, directory: '/private/real-release-store' }, dependencies), { code: 'invalid_fixture_directory' });
});
