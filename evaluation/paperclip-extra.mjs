import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('/home/node/paperclip-probe.json', 'utf8'));
const evidence = [];
async function api(label, method, path, body) {
  const r = await fetch('http://127.0.0.1:3100' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json(); evidence.push({ label, status: r.status, body: data }); return data;
}
const routine = await api('S1.1 monitor routine without project or goal', 'POST', `/api/companies/${s.company}/routines`, { title: 'Monitor fixture inbox', assigneeAgentId: s.agents.Monitor.id, description: 'Save cursor, notify Daily only for relevant messages', concurrencyPolicy: 'coalesce_if_active' });
if (routine.id) {
  await api('S1.1 schedule within working hours', 'POST', `/api/routines/${routine.id}/triggers`, { kind: 'schedule', cronExpression: '*/15 8-17 * * 1-5', timezone: 'Africa/Johannesburg' });
  await api('S1.1 synthetic monitor check', 'POST', `/api/routines/${routine.id}/run`, { idempotencyKey: 'monitor-check-001', payload: { cursor: 'mail-41' } });
  await api('S1.3 replay monitor check', 'POST', `/api/routines/${routine.id}/run`, { idempotencyKey: 'monitor-check-001', payload: { cursor: 'mail-41' } });
  await api('S1.7 pause routine', 'PATCH', `/api/routines/${routine.id}`, { status: 'paused' });
}
await api('S3 review history persisted', 'GET', `/api/issues/${s.graph}/comments`);
await api('S2 answered interaction persisted', 'GET', `/api/issues/${s.subnet}/interactions`);
const document = await api('S3.3 create revisioned candidate document', 'PUT', `/api/issues/${s.graph}/documents/candidate`, { title: 'Graph candidate', format: 'markdown', body: 'Candidate B: fixture-b', baseRevisionId: null });
evidence.push({ label: 'S3 candidate revision result', document });
fs.writeFileSync('/home/node/paperclip-extra-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence.map(e=>({label:e.label,status:e.status,body:e.body})),null,2));
