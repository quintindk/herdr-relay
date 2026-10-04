import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const target = new URL('../docs/evidence/', import.meta.url);
fs.mkdirSync(target, { recursive: true });
const collected = {};
for (const [product, names] of Object.entries({
  paperclip: ['initial', 'runs', 'extra', 'staleness', 'recovery', 'worktree'],
  openrig: ['initial', 'deep', 'followup', 'recovery', 'retire', 'worktree'],
})) {
  for (const name of names) {
    const path = name === 'worktree' ? '/home/node/worktree-evidence.json' : `/home/node/${product}-${name}-evidence.json`;
    const raw = execFileSync('docker', ['exec', `retinue-eval-${product}`, 'node', '-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1], "utf8"))', path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(raw);
    // API secrets are never part of evidence. Defensively redact credential fields.
    const clean = JSON.parse(JSON.stringify(data, (key, value) => /^(token|apiKey|authToken|authorization|secretMaterial)$/i.test(key) ? '[redacted]' : value));
    fs.writeFileSync(new URL(`${product}-${name}.json`, target), JSON.stringify(clean, null, 2) + '\n');
    collected[`${product}-${name}`] = clean;
  }
}
const p = collected['paperclip-initial'];
assert.equal(p.find(x => x.label === 'S2.1 unrelated peer creates request (agent key)').status, 201);
assert.equal(p.find(x => x.label === 'S3.2 checkout with persistent agent key, no run').status, 401);
assert.equal(p.find(x => x.label === 'S0.3 unassigned backlog').response.status, 'backlog');
assert.equal(p.find(x => x.label === 'S0.3 human-owned work').response.assigneeUserId, 'local-board');
const run = collected['paperclip-runs'];
assert.equal(run.find(x => x.label === 'S3 accepted task').body.status, 'done');
assert.equal(run.find(x => x.label === 'S2 requester answers in own run').results.find(x => x.label === 'Answer specific question').status, 200);
const comments = collected['paperclip-extra'].find(x => x.label === 'S3 review history persisted').body;
for (const text of ['Candidate A:', 'Changes requested:', 'Candidate B:', 'Accepted candidate B']) assert(comments.some(c => c.body.startsWith(text)));
assert.equal(collected['paperclip-staleness'].find(x => x.label === 'S3 reject stale acceptance').status, 409);
const o = collected['openrig-initial'];
assert.equal(o.find(x => x.label === 'S0.3 unassigned backlog').status, 400);
assert.equal(o.find(x => x.label === 'S2.1 unrelated peer request across rigs').status, 201);
for (const label of ['S1.4 claim daily-a', 'S1.4 claim daily-b']) assert.equal(o.find(x => x.label === label).status, 200);
const f = collected['openrig-followup'];
assert.equal(f.find(x => x.label === 'S3 typed candidate candidate-a').body.error, 'acceptance_payload_mismatch');
assert.equal(f.find(x => x.label === 'S3 typed candidate candidate-b').body.instance.status, 'completed');
assert.equal(f.find(x => x.label === 'S1.7 stop monitoring schedule').body.state, 'stopped');
for (const product of ['paperclip', 'openrig']) {
  assert(collected[`${product}-recovery`].every(x => x.status === 200));
  const git = collected[`${product}-worktree`];
  assert.equal(git[1].commit, git[1].replayCommit);
  assert(git[2].blocked && git[2].filePreserved && git[3].worktreeRemoved && git[3].branchRetained);
}
const summary = { verifiedAt: new Date().toISOString(), evidenceFiles: Object.keys(collected), assertions: 'passed', scope: 'Deterministic API/process/stub tests and separately labelled Git fixture. Not native OpenCode/Hermes or production source integration.' };
fs.writeFileSync(new URL('verification.json', target), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
