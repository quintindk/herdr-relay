// Deterministic process adapter fixture. This exercises real run-scoped API access,
// not model reasoning or an OpenCode/Hermes conversation.
import fs from 'node:fs';
const task = JSON.parse(fs.readFileSync(process.env.EVAL_ACTION_FILE, 'utf8'));
const base = (process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100').replace(/\/api\/?$/, '');
const results = [];
await new Promise(resolve => setTimeout(resolve, 1000));
for (const action of task.actions) {
  fs.writeFileSync(task.output, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, results, pending: action.label }, null, 2));
  const response = await fetch(base + action.path, {
    method: action.method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
      'X-Paperclip-Run-Id': process.env.PAPERCLIP_RUN_ID },
    body: action.body === undefined ? undefined : JSON.stringify(action.body),
  });
  const body = await response.json();
  results.push({ label: action.label, status: response.status, body });
  fs.writeFileSync(task.output, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, results }, null, 2));
  if (response.status >= 400 && !action.allowFailure) break;
}
fs.writeFileSync(task.output, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID, results }, null, 2));
console.log(JSON.stringify(results.map(r => ({ label: r.label, status: r.status }))));
