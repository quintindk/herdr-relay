import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('/home/node/paperclip-probe.json', 'utf8'));
const base = 'http://127.0.0.1:3100';
const evidence = [];
const executionId = Date.now().toString();
async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { unexpectedResponse: text.slice(0, 200) }; }
  return { status: r.status, body: parsed };
}
async function run(name, issue, label, actions) {
  const slug = `${executionId}-${label.replace(/[^a-z0-9]/gi, '-')}`;
  const file = `/home/node/action-${slug}.json`, output = `/home/node/result-${slug}.json`;
  fs.writeFileSync(file, JSON.stringify({ actions, output }));
  const configured = await api('PATCH', `/api/agents/${s.agents[name].id}`, {
    adapterConfig: { command: 'node', args: ['/evaluation/paperclip-worker.mjs'], env: { EVAL_ACTION_FILE: file }, timeoutSec: 30 },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 } },
  });
  if (configured.status !== 200) throw new Error(JSON.stringify(configured));
  const wake = await api('POST', `/api/agents/${s.agents[name].id}/heartbeat/invoke`, { reason: 'evaluation', payload: { issueId: issue, taskId: issue }, idempotencyKey: slug });
  evidence.push({ label: `${label}: wake`, status: wake.status, runId: wake.body.id, error: wake.body.error });
  // Disable further automatic wakes once this run has started. The fixture is a
  // single scripted turn, not a general worker suitable for recovery prompts.
  for (let n = 0; n < 60; n++) {
    const current = await api('GET', `/api/heartbeat-runs/${wake.body.id}`);
    if (current.body.startedAt || ['failed', 'cancelled', 'succeeded'].includes(current.body.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await api('PATCH', `/api/agents/${s.agents[name].id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  for (let n = 0; n < 90; n++) {
    const current = await api('GET', `/api/heartbeat-runs/${wake.body.id}`);
    if (['failed', 'cancelled', 'succeeded'].includes(current.body.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!fs.existsSync(output)) {
    evidence.push({ label: `${label}: missing fixture output`, wake, run: await api('GET', `/api/heartbeat-runs/${wake.body.id}`) });
    console.log(JSON.stringify(evidence.at(-1)));
    return null;
  }
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  evidence.push({ label, ...result });
  await api('PATCH', `/api/agents/${s.agents[name].id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  // Let the process adapter finish before the next wake of the same agent.
  await new Promise(resolve => setTimeout(resolve, 1200));
  return result;
}
const checkout = (issue, name) => ({ label: 'Checkout', method: 'POST', path: `/api/issues/${issue}/checkout`, body: { agentId: s.agents[name].id, expectedStatuses: ['todo', 'backlog', 'in_review', 'blocked'] } });
const patch = (issue, status, comment) => ({ label: `${status}: ${comment}`, method: 'PATCH', path: `/api/issues/${issue}`, body: { status, comment } });
// Fresh tasks avoid interpreting prior fixture mistakes as product failures.
for (const agent of Object.values(s.agents)) await api('PATCH', `/api/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
s.subnet = (await api('POST', `/api/companies/${s.company}/issues`, { title: `Run-scoped subnet ${executionId}`, assigneeAgentId: s.agents.Landing.id })).body.id;
s.graph = (await api('POST', `/api/companies/${s.company}/issues`, { title: `Run-scoped graph ${executionId}`, assigneeAgentId: s.agents.Graph.id, executionPolicy: { mode: 'normal', commentRequired: true, stages: [{ type: 'review', participants: [{ type: 'agent', agentId: s.agents.Daily.id }] }] } })).body.id;
await run('Landing', s.subnet, 'S2 clarification with real run', [checkout(s.subnet, 'Landing'), {
  label: 'Question addressed to requester', method: 'POST', path: `/api/issues/${s.subnet}/interactions`, body: {
    kind: 'ask_user_questions', idempotencyKey: 'subnet-size-v2', addresseeAgentId: s.agents.Daily.id, continuationPolicy: 'wake_assignee',
    payload: { version: 1, questions: [{ id: 'size', prompt: 'Subnet CIDR?', selectionMode: 'single', required: true, options: [{ id: 'small', label: '10.230.1.0/24' }] }] },
  },
}, patch(s.subnet, 'in_review', 'Waiting for subnet size from the requester.')]);
const interactions = await api('GET', `/api/issues/${s.subnet}/interactions`);
evidence.push({ label: 'S2 persisted questions', ...interactions });
const question = (Array.isArray(interactions.body) ? interactions.body : []).find(q => q.idempotencyKey === 'subnet-size-v2');
if (question) {
  const dailyTask = await api('POST', `/api/companies/${s.company}/issues`, { title: 'Answer subnet clarification', assigneeAgentId: s.agents.Daily.id });
  await run('Daily', dailyTask.body.id, 'S2 requester answers in own run', [checkout(dailyTask.body.id, 'Daily'), {
    label: 'Answer specific question', method: 'POST', path: `/api/issues/${s.subnet}/interactions/${question.id}/respond`, body: { answers: [{ questionId: 'size', optionIds: ['small'] }] },
  }, patch(dailyTask.body.id, 'done', 'Answered subnet question.')]);
}
await run('Landing', s.subnet, 'S2 provider completes fake subnet', [checkout(s.subnet, 'Landing'), patch(s.subnet, 'done', 'Fixture resource /subscriptions/fixture/subnets/demo, CIDR 10.230.1.0/24. No Azure calls made.')]);
evidence.push({ label: 'S2 dependent after provider result', ...await api('GET', `/api/issues/${s.deploy}`) });
await run('Graph', s.graph, 'S3 submit candidate A', [checkout(s.graph, 'Graph'), patch(s.graph, 'done', 'Candidate A: fixture-a. Ready for review.')]);
evidence.push({ label: 'S3 submitted review state', ...await api('GET', `/api/issues/${s.graph}`) });
await run('Daily', s.graph, 'S3 request corrections', [patch(s.graph, 'in_progress', 'Changes requested: include graph metadata.')]);
await run('Graph', s.graph, 'S3 submit candidate B', [checkout(s.graph, 'Graph'), patch(s.graph, 'done', 'Candidate B: fixture-b. Includes graph metadata.')]);
await run('Daily', s.graph, 'S3 accept candidate B', [patch(s.graph, 'done', 'Accepted candidate B after deterministic fixture review.')]);
evidence.push({ label: 'S3 accepted task', ...await api('GET', `/api/issues/${s.graph}`) });
evidence.push({ label: 'S3 worker after acceptance', ...await api('GET', `/api/agents/${s.agents.Graph.id}`) });
fs.writeFileSync('/home/node/paperclip-runs-evidence.json', JSON.stringify(evidence, null, 2));
fs.writeFileSync('/home/node/paperclip-probe.json', JSON.stringify(s), { mode: 0o600 });
console.log(JSON.stringify(evidence.map(e => ({ label: e.label, status: e.status, results: e.results?.map(r=>({label:r.label,status:r.status,error:r.body.error})), issueStatus:e.body?.status, executionState:e.body?.executionState })), null, 2));
