import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeJournal } from '../src/node-journal.mjs';
import { candidate } from '../src/candidate.mjs';
import { provisionNodeWorktree, finaliseNodeWorktree, retireNodeWorktree } from '../src/node-resources.mjs';

test('native resource adapter preserves exact candidate, commit and dirty-cleanup guards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-native-resource-'));
  const repo = join(root, 'repo'), worktree = join(root, 'worker');
  const git = (...args) => execFileSync('git', args, { env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, stdio: 'pipe' });
  git('init', repo); writeFileSync(join(repo, 'file.txt'), 'initial'); git('-C', repo, 'add', '.'); git('-C', repo, 'commit', '-m', 'fixture');
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  try {
    provisionNodeWorktree(journal, { key: 'worker', repository: repo, path: worktree, branch: 'worker', bindingId: 'binding' });
    writeFileSync(join(worktree, 'file.txt'), 'changed');
    const identity = candidate(worktree).id;
    journal.save({ id: 'execution', bindingId: 'binding', state: 'native_finished', observation: { outcome: 'succeeded' },
      execution: { runId: 'run', taskId: 'task', state: 'completed' }, staged: { kind: 'result', payload: { candidate: identity, summary: 'Changed' } } });
    const input = { key: 'worker', runId: 'run', candidate: identity, message: 'Result' };
    finaliseNodeWorktree(journal, input); finaliseNodeWorktree(journal, input);
    const api = async () => ({ state: 'completed', runId: 'run', reviewPolicy: 'human', result: { candidate: identity, digest: 'digest' },
      review: { decision: 'accept', resultDigest: 'digest' } });
    writeFileSync(join(worktree, 'dirty'), 'do not delete');
    await assert.rejects(retireNodeWorktree(journal, api, input), { code: 'dirty_cleanup_blocked' });
    assert.ok(existsSync(worktree));
    rmSync(join(worktree, 'dirty'));
    await retireNodeWorktree(journal, api, input);
    assert.equal(existsSync(worktree), false);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});
