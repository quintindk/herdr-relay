import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installSkills, skillStatus } from '../src/skill-install.mjs';

function fixture(t) {
  const root = mkdtempSync('/tmp/opencode/skill-install-'), sourceDirectory = join(root, 'release'), configDirectory = join(root, 'opencode');
  mkdirSync(sourceDirectory); mkdirSync(configDirectory);
  writeFileSync(join(sourceDirectory, 'package.json'), '{"version":"0.2.1"}');
  for (const name of ['herdr-relay', 'relay-work']) {
    mkdirSync(join(sourceDirectory, 'skills', name), { recursive: true });
    writeFileSync(join(sourceDirectory, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\nNative fixture.\n`);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sourceDirectory, configDirectory, target: name => join(configDirectory, 'skills', name, 'SKILL.md') };
}

test('skill status and dry run are read-only, first install is private, and retry leaves bytes unchanged', t => {
  const f = fixture(t), before = readdirSync(f.configDirectory);
  assert.ok(skillStatus(f).skills.every(s => s.state === 'missing'));
  assert.equal(installSkills({ ...f, dryRun: true }).state, 'skill_plan');
  assert.deepEqual(readdirSync(f.configDirectory), before);
  assert.equal(installSkills(f).state, 'skills_installed');
  const files = ['herdr-relay', 'relay-work'].map(name => readFileSync(f.target(name), 'utf8'));
  assert.equal(statSync(f.target('herdr-relay')).mode & 0o777, 0o600);
  assert.ok(skillStatus(f).skills.every(s => s.state === 'current'));
  assert.equal(installSkills(f).state, 'skills_current');
  assert.deepEqual(['herdr-relay', 'relay-work'].map(name => readFileSync(f.target(name), 'utf8')), files);
});

test('managed updates back up exact installed bytes and preserve unrelated skills and files', t => {
  const f = fixture(t); installSkills(f);
  const before = readFileSync(f.target('herdr-relay'), 'utf8');
  writeFileSync(join(f.configDirectory, 'skills', 'herdr-relay', 'custom.md'), 'Leave this alone');
  mkdirSync(join(f.configDirectory, 'skills', 'other')); writeFileSync(join(f.configDirectory, 'skills', 'other', 'SKILL.md'), 'Other skill');
  writeFileSync(join(f.sourceDirectory, 'skills', 'herdr-relay', 'SKILL.md'), 'Updated native fixture');
  assert.equal(skillStatus(f).skills[0].state, 'outdated');
  const result = installSkills(f); assert.deepEqual(result.changed, ['herdr-relay']);
  assert.equal(readFileSync(result.backups[0], 'utf8'), before);
  assert.equal(readFileSync(join(f.configDirectory, 'skills', 'herdr-relay', 'custom.md'), 'utf8'), 'Leave this alone');
  assert.equal(readFileSync(join(f.configDirectory, 'skills', 'other', 'SKILL.md'), 'utf8'), 'Other skill');
});

test('local and unmanaged edits refuse the whole update unless explicitly replaced, retaining private backups', t => {
  const f = fixture(t); installSkills(f);
  writeFileSync(f.target('herdr-relay'), 'Private custom instructions');
  writeFileSync(join(f.sourceDirectory, 'skills', 'relay-work', 'SKILL.md'), 'Updated work skill');
  const workBefore = readFileSync(f.target('relay-work'), 'utf8');
  assert.equal(installSkills(f).state, 'skill_conflict');
  assert.equal(readFileSync(f.target('herdr-relay'), 'utf8'), 'Private custom instructions');
  assert.equal(readFileSync(f.target('relay-work'), 'utf8'), workBefore);
  const result = installSkills({ ...f, replaceModified: true });
  assert.equal(result.state, 'skills_installed');
  assert.ok(result.backups.some(path => readFileSync(path, 'utf8') === 'Private custom instructions'));
  assert.ok(result.backups.every(path => (statSync(path).mode & 0o777) === 0o600));
  rmSync(join(f.configDirectory, 'skills', 'herdr-relay', '.herdr-relay-managed.json'));
  writeFileSync(f.target('herdr-relay'), 'Unmanaged instructions');
  assert.equal(installSkills(f).state, 'skill_conflict');
  assert.equal(installSkills({ ...f, replaceModified: true }).state, 'skills_installed');
});

test('skill symlinks and invalid receipts are never replaced, even with explicit replacement', t => {
  const f = fixture(t); installSkills(f);
  const target = f.target('herdr-relay'), elsewhere = join(f.root, 'outside'); writeFileSync(elsewhere, 'External instructions');
  rmSync(target); symlinkSync(elsewhere, target);
  assert.equal(installSkills({ ...f, replaceModified: true }).state, 'skill_conflict');
  assert.equal(readFileSync(elsewhere, 'utf8'), 'External instructions');
  rmSync(target); writeFileSync(target, 'Local instructions');
  writeFileSync(join(f.configDirectory, 'skills', 'herdr-relay', '.herdr-relay-managed.json'), '{}');
  assert.equal(installSkills({ ...f, replaceModified: true }).state, 'skill_conflict');
});

test('public skills CLI uses the selected config directory and node install syncs skills without real systemd', t => {
  const f = fixture(t), cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'skills', 'status', '--config-dir', f.configDirectory], { encoding: 'utf8' }));
  assert.ok(status.skills.every(s => s.state === 'missing'));
  const installed = JSON.parse(execFileSync(process.execPath, [cli, 'skills', 'install', '--config-dir', f.configDirectory], { encoding: 'utf8' }));
  assert.equal(installed.state, 'skills_installed');
  assert.match(readFileSync(f.target('herdr-relay'), 'utf8'), /Relay uses its native task backend/);
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const nodeConfig = join(f.root, 'node.json'); writeFileSync(nodeConfig, '{"nodeId":"fixture"}');
  const result = JSON.parse(execFileSync(process.execPath, [cli, 'node', 'install', '--config', nodeConfig], {
    encoding: 'utf8', env: { ...process.env, HOME: f.root, XDG_CONFIG_HOME: join(f.root, 'config'), PATH: `${bin}:${process.env.PATH}` },
  }));
  assert.equal(result.skills.state, 'skills_installed');
  assert.match(readFileSync(join(f.root, 'config/opencode/skills/herdr-relay/SKILL.md'), 'utf8'), /Relay uses its native task backend/);
});
