import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchOwnedV2 } from '../packages/opencode-relay/owned-runtime.mjs';
import { compatibility } from '../src/release-info.mjs';

test('a live owned process is reused during compatible Relay plugin changes; reload waits for idle/decisions and launch history stays immutable', async t => {
  const root = mkdtempSync('/tmp/opencode/owned-code-switch-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = version => {
    const path = join(root, version), plugin = join(path, 'packages/opencode-relay'); mkdirSync(plugin, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'herdr-relay', version, relayCompatibility: compatibility }));
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@herdr/relay-opencode', version })); return plugin;
  };
  const old = release('0.2.1-rc1'), next = release('0.2.1-rc2'), directory = join(root, 'runtime'), workspace = join(root, 'workspace');
  mkdirSync(workspace); const configDirectory = join(directory, 'home/.config/opencode'); mkdirSync(configDirectory, { recursive: true });
  const config = { model: 'fixture/model', plugins: [{ package: old, options: { workerContextFile: join(root, 'worker.json') } }] };
  const request = { executable: process.execPath, workspace, config };
  const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
  const descriptor = { state: 'ready', pid: process.pid, start, nonce: 'owned-fixture', origin: 'http://127.0.0.1:1', request, generation: 1 };
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify(descriptor)); writeFileSync(join(directory, 'auth.json'), '{"password":"disposable-fixture"}');
  writeFileSync(join(configDirectory, 'opencode.json'), JSON.stringify({ ...config, $schema: 'https://opencode.ai/config.json', update: 'disable', share: 'disabled' }));
  const newConfig = structuredClone(config); newConfig.plugins[0].package = next;
  const handle = await launchOwnedV2({ directory, executable: process.execPath, workspace, config: newConfig });
  assert.equal(handle.descriptor.pid, process.pid); assert.equal(handle.relayPluginUpdatePending, true);
  handle.client.session.active = async () => ({ busy: {} });
  assert.equal(await handle.tryRelayPluginUpdate(), false);
  assert.equal(JSON.parse(readFileSync(join(configDirectory, 'opencode.json'))).plugins[0].package, old);
  handle.client.session.active = async () => ({});
  handle.client.form.list = async () => ({ data: [{}] }); handle.client.permission.request.list = async () => ({ data: [] });
  assert.equal(await handle.tryRelayPluginUpdate(), false);
  handle.client.form.list = async () => ({ data: [] });
  assert.equal(await handle.tryRelayPluginUpdate(), true);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'runtime.json'))).request, descriptor.request, 'Launch request is historical evidence, not live config');
  assert.equal(JSON.parse(readFileSync(join(configDirectory, 'opencode.json'))).plugins[0].package, next);
  assert.equal((await launchOwnedV2({ directory, executable: process.execPath, workspace, config: newConfig })).descriptor.pid, process.pid);
  await assert.rejects(launchOwnedV2({ directory, executable: process.execPath, workspace, config: { ...newConfig, model: 'different/model' } }), { code: 'runtime_conflict' });
});
