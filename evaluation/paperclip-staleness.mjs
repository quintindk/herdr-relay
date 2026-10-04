import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('/home/node/paperclip-probe.json', 'utf8'));
const evidence = [];
async function api(label, method, path, body) {
  const r = await fetch('http://127.0.0.1:3100' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); evidence.push({ label, status: r.status, body: data }); return data;
}
const task = await api('S3 candidate review task', 'POST', `/api/companies/${s.company}/issues`, { title: `Staleness test ${Date.now()}`, assigneeUserId: 'local-board' });
const path = `/api/issues/${task.id}`;
const a = await api('S3 candidate revision A', 'PUT', `${path}/documents/candidate`, { title: 'Candidate', format: 'markdown', body: 'A', baseRevisionId: null });
const card = await api('S3 request acceptance of revision A', 'POST', `${path}/interactions`, { kind: 'request_confirmation', idempotencyKey: 'accept-candidate-a', payload: { version: 1, prompt: 'Accept candidate A?', target: { type: 'issue_document', issueId: task.id, key: 'candidate', revisionId: a.latestRevisionId } } });
await api('S3 candidate revision B', 'PUT', `${path}/documents/candidate`, { title: 'Candidate', format: 'markdown', body: 'B', baseRevisionId: a.latestRevisionId });
await api('S3 reject stale acceptance', 'POST', `${path}/interactions/${card.id}/accept`, {});
await api('S3 card state after stale acceptance', 'GET', `${path}/interactions`);
fs.writeFileSync('/home/node/paperclip-staleness-evidence.json', JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
