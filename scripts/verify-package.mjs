import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

// A local RC artifact only. This never publishes npm packages, Git tags or a
// GitHub release, and never uses the user's native services or credentials.
const root = mkdtempSync('/tmp/opencode/relay-package-check-');
const { values } = parseArgs({ options: { output: { type: 'string' }, 'skip-audit': { type: 'boolean' } } });
const artifactDirectory = resolve(values.output ?? join(root, 'artifacts'));
mkdirSync(artifactDirectory, { recursive: true });
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', artifactDirectory], { encoding: 'utf8' }));
assert.ok(!packed.files.some(f => /(^|\/)(\.env|owner\.json|node_modules|\.firecrawl|\.git)(\/|$)/.test(f.path)), 'Package contains private or development files');
for (const path of ['src/node-interactive.mjs', 'src/interactive-contract.mjs', 'scripts/install-native-backend.mjs',
  'scripts/install-native-node.mjs', 'packages/opencode-relay/server.mjs', 'packages/opencode-relay/tui.mjs']) assert.ok(packed.files.some(f => f.path === path), `Missing runtime file: ${path}`);
const artifact = join(artifactDirectory, packed.filename), consumer = join(root, 'consumer');
mkdirSync(consumer);
execFileSync('npm', ['install', '--prefix', consumer, '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit',
  ...(values['skip-audit'] ? ['--offline'] : []), artifact], { stdio: 'pipe' });
const installed = join(consumer, 'node_modules/herdr-relay');
const help = execFileSync(join(consumer, 'node_modules/.bin/herdr-relay'), ['native', '--help'], { encoding: 'utf8', cwd: consumer });
assert.match(help, /interactive grant\|request\|dispatch/);
execFileSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  await import('./packages/opencode-relay/server.mjs');
  await import('./packages/opencode-relay/tui.mjs');
  await import('@opencode/client/service');
  const {startBackend}=await import('./src/backend-service.mjs');
  const backend=await startBackend({database:':memory:'});
  try { const token=backend.store.bootstrap().token; const response=await fetch(backend.origin+'/v1/info',{headers:{authorization:'Bearer '+token}});
    assert.equal((await response.json()).features.interactiveProvisioning,true); }
  finally { await backend.close(); }
`], { cwd: installed, stdio: 'pipe' });
const audit = values['skip-audit'] ? null : JSON.parse(execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: consumer, encoding: 'utf8' }));
if (audit) assert.equal(audit.metadata.vulnerabilities.total, 0);
const result = { version: packed.version, artifact, sha256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
  cleanProductionInstall: true, cliEntrypointPassed: true, serverAndTuiImportsPassed: true, nativeBackendStarted: true,
  auditVerified: Boolean(audit), vulnerabilities: audit?.metadata.vulnerabilities ?? null, published: false, gitTagCreated: false };
writeFileSync(join(artifactDirectory, `${packed.filename}.verification.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
