import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { packageDirectory } from './release-info.mjs';
import { hashBytes } from './release-install.mjs';
import { requireValue } from './protocol.mjs';
import { writePrivateJson } from './private-files.mjs';
import { serviceLock } from './service-lock.mjs';

const names = ['herdr-relay', 'relay-work'];
const receiptName = '.herdr-relay-managed.json';
export const skillConfigDirectory = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
const regular = path => { const stat = lstatSync(path, { throwIfNoEntry: false }); return !stat || stat.isFile() && !stat.isSymbolicLink(); };
const directory = path => { const stat = lstatSync(path, { throwIfNoEntry: false }); return !stat || stat.isDirectory() && !stat.isSymbolicLink(); };

export function skillStatus({ sourceDirectory = packageDirectory, configDirectory = skillConfigDirectory() } = {}) {
  sourceDirectory = resolve(sourceDirectory); configDirectory = resolve(configDirectory);
  const version = JSON.parse(readFileSync(join(sourceDirectory, 'package.json'), 'utf8')).version;
  const skillsRoot = join(configDirectory, 'skills');
  requireValue(directory(configDirectory) && directory(skillsRoot), 'skill_path_conflict', 'OpenCode configuration/skills must be real directories, not symlinks');
  const skills = names.map(name => {
    const source = join(sourceDirectory, 'skills', name, 'SKILL.md'), targetDirectory = join(skillsRoot, name);
    const target = join(targetDirectory, 'SKILL.md'), receiptPath = join(targetDirectory, receiptName);
    requireValue(regular(source) && existsSync(source), 'skill_source_missing', 'Release must contain both shipped Relay skills');
    const sourceHash = hashBytes(readFileSync(source));
    if (!directory(targetDirectory) || !regular(target) || !regular(receiptPath)) return { name, path: target, state: 'conflict', reason: 'Symlink or non-regular skill path', replaceable: false };
    let receipt = null;
    if (existsSync(receiptPath)) {
      try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch {}
      if (receipt?.format !== 'herdr-relay-skill/1' || receipt.name !== name || !/^[a-f0-9]{64}$/.test(receipt.hash))
        return { name, path: target, state: 'conflict', reason: 'Invalid management receipt', replaceable: false };
    }
    const currentHash = existsSync(target) ? hashBytes(readFileSync(target)) : null;
    return { name, path: target, sourceHash, currentHash, installedVersion: receipt?.version ?? null,
      state: currentHash === null ? 'missing' : currentHash === sourceHash ? 'current' : receipt?.hash === currentHash ? 'outdated' : 'conflict',
      ...(currentHash && currentHash !== sourceHash && receipt?.hash !== currentHash ? { reason: receipt ? 'Installed skill was locally modified' : 'Unmanaged existing skill', replaceable: true } : {}) };
  });
  return { version, configDirectory, skills, conflicts: skills.filter(s => s.state === 'conflict').length, readOnly: true };
}

// Only the two shipped SKILL.md files and their ownership receipts are managed.
// Extra files/custom skills are never removed. Explicit replacement retains bytes.
export function installSkills({ sourceDirectory = packageDirectory, configDirectory = skillConfigDirectory(), replaceModified = false, dryRun = false } = {}) {
  let status = skillStatus({ sourceDirectory, configDirectory });
  if (dryRun) return { ...status, state: 'skill_plan', restartRequired: false };
  const lockDirectory = join(status.configDirectory, 'skills', '.herdr-relay-lock');
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const unlock = serviceLock(lockDirectory);
  try {
    status = skillStatus({ sourceDirectory, configDirectory });
    const changed = [], backups = [], conflicts = status.skills.filter(s => s.state === 'conflict' && !(replaceModified && s.replaceable));
    // A conflict prevents the whole skill update, not a partial replacement.
    if (conflicts.length) return { ...status, state: 'skill_conflict', changed, backups, restartRequired: false };
    for (const skill of status.skills) {
      const targetDirectory = join(status.configDirectory, 'skills', skill.name);
      mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
      const source = readFileSync(join(sourceDirectory, 'skills', skill.name, 'SKILL.md'));
      requireValue((existsSync(skill.path) ? hashBytes(readFileSync(skill.path)) : null) === skill.currentHash,
        'skill_conflict', 'Installed skill changed during update');
      if (skill.currentHash !== skill.sourceHash) {
        if (skill.currentHash) {
          const backup = `${skill.path}.relay-backup-${randomUUID()}`;
          writeFileSync(backup, readFileSync(skill.path), { mode: 0o600, flag: 'wx', flush: true }); backups.push(backup);
        }
        const temporary = `${skill.path}.relay-${randomUUID()}`;
        writeFileSync(temporary, source, { mode: 0o600, flag: 'wx', flush: true }); renameSync(temporary, skill.path); changed.push(skill.name);
      }
      const receipt = { format: 'herdr-relay-skill/1', name: skill.name, hash: skill.sourceHash, version: status.version };
      const path = join(targetDirectory, receiptName);
      if (!existsSync(path) || readFileSync(path, 'utf8') !== `${JSON.stringify(receipt, null, 2)}\n`) writePrivateJson(path, receipt);
    }
    return { version: status.version, state: changed.length ? 'skills_installed' : 'skills_current', changed, backups,
      conflicts: 0, restartRequired: changed.length > 0,
      instruction: changed.length ? 'Skill files updated. Start a fresh agent context or reload skills using the harness-supported interface. Running chats are not restarted.' : 'Installed Relay skills match this release.' };
  } finally { unlock(); }
}
