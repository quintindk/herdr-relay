import fs from 'node:fs';
const evidence = [];
const daily = 'main-lead@daily';
async function api(label, method, path, body) {
  const r = await fetch('http://127.0.0.1:17300' + path, { method, headers: { 'Content-Type': 'application/json', 'X-OpenRig-Session': daily }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); evidence.push({ label, status: r.status, body: data }); return data;
}
const prior = JSON.parse(fs.readFileSync('/home/node/openrig-deep-evidence.json', 'utf8'));
const instance = prior.find(e => e.label === 'S3 inspect workflow').body;
for (const candidate of ['candidate-a', 'candidate-b']) await api(`S3 typed candidate ${candidate}`, 'POST', '/api/workflow/project', {
  instanceId: instance.instanceId, currentPacketId: instance.currentFrontier[0], exit: 'done', actorSession: daily,
  closureEvidence: { acceptance: { candidate, verdict: 'CLEAR', evidence_ref: '/home/node/graph-proof.json' } },
});
await api('S3 accepted workflow state', 'GET', `/api/workflow/${instance.instanceId}`);
await api('S0.3 human task using canonical registered address', 'POST', '/api/queue/create', {
  qitemId: 'eval-human-canonical', destinationSession: 'quintin@external', body: 'Decide demo direction', summary: 'Demo direction', evidenceRef: 'fixture://message-1', nudge: false,
});
const job = await api('S1.1 standing monitor reminder', 'POST', '/api/watchdog/register', {
  policy: 'periodic-reminder', targetSession: 'main-lead@monitor', intervalSeconds: 3600, registeredBySession: daily,
  specYaml: 'policy: periodic-reminder\ntarget:\n  session: main-lead@monitor\ninterval_seconds: 3600\nmessage: Check fixture inbox from saved cursor\n',
});
if (job.jobId) await api('S1.7 stop monitoring schedule', 'POST', `/api/watchdog/${job.jobId}/stop`, {});
await api('S1.6 pending inbox read', 'GET', '/api/queue/inbox/pending?destinationSession=main-lead%40daily');
fs.writeFileSync('/home/node/openrig-followup-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
