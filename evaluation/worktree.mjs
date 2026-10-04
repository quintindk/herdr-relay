// Common finalisation fixture. Git operations are performed by the evaluation
// coordinator, NOT attributed to either product's native cleanup implementation.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = '/home/node/graph-fixture';
const repo = `${root}/repo`, worktree = `${root}/worker`;
fs.mkdirSync(repo, { recursive: true });
const env = { ...process.env, GIT_AUTHOR_NAME: 'Evaluation', GIT_AUTHOR_EMAIL: 'evaluation@example.invalid', GIT_COMMITTER_NAME: 'Evaluation', GIT_COMMITTER_EMAIL: 'evaluation@example.invalid' };
function git(cwd, ...args) { return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const evidence = [];
if (fs.existsSync('/home/node/worktree-evidence.json') && !fs.existsSync(worktree)) {
  const saved = JSON.parse(fs.readFileSync('/home/node/worktree-evidence.json', 'utf8'));
  if (git(repo, 'rev-parse', 'graph-worker') !== saved[1].commit) throw new Error('Saved branch changed');
  console.log(JSON.stringify({ replay: true, evidence: saved }, null, 2));
  process.exit(0);
}
if (!fs.existsSync(`${repo}/.git`)) {
  git(repo, 'init'); fs.writeFileSync(`${repo}/graph.json`, '{"nodes":[]}\n');
  git(repo, 'add', 'graph.json'); git(repo, 'commit', '-m', 'fixture: initial graph');
}
if (!fs.existsSync(worktree)) git(repo, 'worktree', 'add', '-b', 'graph-worker', worktree);
const digest = () => createHash('sha256').update(fs.readFileSync(`${worktree}/graph.json`)).digest('hex');
fs.writeFileSync(`${worktree}/graph.json`, '{"nodes":["app"]}\n');
const candidateA = digest();
fs.writeFileSync(`${worktree}/graph.json`, '{"nodes":["app"],"version":1}\n');
const candidateB = digest();
evidence.push({ label: 'S3.3 candidate changed after correction', candidateA, candidateB, staleCandidateRejected: candidateA !== digest() });
const graph = JSON.parse(fs.readFileSync(`${worktree}/graph.json`, 'utf8'));
if (graph.version !== 1 || graph.nodes[0] !== 'app') throw new Error('Graph validation failed');
git(worktree, 'add', 'graph.json'); git(worktree, 'commit', '-m', 'fixture: update graph');
const commit = git(worktree, 'rev-parse', 'HEAD');
const count = git(worktree, 'rev-list', '--count', 'HEAD');
// Simulated lost response: reconcile the existing commit rather than commit again.
if (git(worktree, 'status', '--porcelain') !== '' || digest() !== candidateB) throw new Error('Candidate changed');
evidence.push({ label: 'S3.4/S3.6 reviewed commit and retry reconciliation', commit, commitCount: count, replayCommit: git(worktree, 'rev-parse', 'HEAD') });
fs.writeFileSync(`${worktree}/untracked.txt`, 'preserve me\n');
let blocked = false;
try { git(repo, 'worktree', 'remove', worktree); } catch { blocked = true; }
evidence.push({ label: 'S3.7 dirty cleanup refused', blocked, filePreserved: fs.existsSync(`${worktree}/untracked.txt`) });
if (!blocked) throw new Error('Cleanup unexpectedly succeeded');
// Resolve only this fixture's own file, then retry ordinary removal.
fs.unlinkSync(`${worktree}/untracked.txt`);
git(repo, 'worktree', 'remove', worktree);
evidence.push({ label: 'S3.7 clean retry', worktreeRemoved: !fs.existsSync(worktree), branchRetained: git(repo, 'rev-parse', 'graph-worker') === commit });
fs.writeFileSync('/home/node/worktree-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
