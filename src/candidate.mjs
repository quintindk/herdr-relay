import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireValue } from './protocol.mjs';

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], { maxBuffer: 64 * 1024 * 1024 });
}

export function candidate(directory) {
  const root = git(directory, ['rev-parse', '--show-toplevel']).toString().trim();
  requireValue(resolve(directory) === root, 'invalid_candidate_root', 'Use the repository or worktree root');
  const before = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString().split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  const entries = [];
  for (const file of files) {
    const path = join(root, file);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    requireValue(stat.isFile() || stat.isSymbolicLink(), 'unsupported_candidate_entry', 'Submodules and special files require explicit candidate support');
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
    const contentDigest = createHash('sha256').update(content).digest('hex');
    hash.update(JSON.stringify([file, mode, content.length, contentDigest]) + '\n');
    entries.push({ path: file, mode, digest: contentDigest });
  }
  requireValue(before.equals(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])),
    'candidate_changed', 'Git status changed while capturing candidate', 409);
  return { id: `sha256:${hash.digest('hex')}`, root, entries };
}
