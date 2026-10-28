import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test('explicit Herdr shortcut installer preserves preferences, is idempotent and refuses conflicts', t => {
  const root = mkdtempSync('/tmp/opencode/relay-shortcut-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'config.toml'), source = '# My preferences\n[theme]\nname = "one-dark"\n\n[[keys.command]]\nkey="prefix+e"\ntype="plugin_action"\ncommand="other.open"\n';
  writeFileSync(path, source);
  const run = (...args) => JSON.parse(execFileSync(process.execPath, ['src/cli.mjs', 'plugin', 'shortcut', '--herdr-config', path, ...args], { encoding: 'utf8' }));
  assert.equal(run('--dry-run').state, 'shortcut_preview'); assert.equal(readFileSync(path, 'utf8'), source); assert.equal(readdirSync(root).length, 1);
  const installed = run(); assert.equal(installed.state, 'installed'); assert.equal(readFileSync(installed.backup, 'utf8'), source);
  const after = readFileSync(path, 'utf8'); assert.ok(after.startsWith(source)); assert.match(after, /prefix\+t/);
  assert.equal(run().state, 'existing'); assert.equal(readFileSync(path, 'utf8'), after);
  writeFileSync(path, source + '\n[[keys.command]]\nkey="prefix+t"\ntype="plugin_action"\ncommand="other.toggle"\n');
  const before = readFileSync(path, 'utf8');
  const refused = spawnSync(process.execPath, ['src/cli.mjs', 'plugin', 'shortcut', '--herdr-config', path], { encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /already has another binding/); assert.equal(readFileSync(path, 'utf8'), before);
  const missing = join(root, 'not-created', 'config.toml');
  execFileSync(process.execPath, ['src/cli.mjs', 'plugin', 'shortcut', '--herdr-config', missing, '--dry-run']);
  assert.equal(existsSync(join(root, 'not-created')), false);
});
