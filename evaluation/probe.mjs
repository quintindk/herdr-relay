import fs from 'node:fs';

const product = process.argv[2];
const phase = process.argv[3] || 'initial';
const base = product === 'paperclip' ? 'http://127.0.0.1:3100' : 'http://127.0.0.1:17300';
const stateFile = `/home/node/${product}-probe.json`;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (phase === 'initial' && state.initialCompleted) throw new Error('Initial probe already completed. Use a fresh container or run the recovery phase.');
const observations = [];
function summarise(body) {
  if (Array.isArray(body)) return body.map(summarise);
  if (!body || typeof body !== 'object') return body;
  const keys = ['id', 'qitemId', 'state', 'status', 'title', 'role', 'reportsTo', 'assigneeAgentId',
    'assigneeUserId', 'sourceSession', 'destinationSession', 'closureReason', 'closureTarget',
    'blockedOn', 'body', 'error', 'message', 'details', 'executionState', 'executionPolicy',
    'outcome', 'kind', 'source', 'parentId', 'blockedBy', 'blocks', 'payload', 'target', 'result'];
  return Object.fromEntries(keys.filter(k => body[k] !== undefined).map(k => [k, body[k]]));
}
async function api(label, method, path, body, actor, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (actor) headers[product === 'openrig' ? 'X-OpenRig-Session' : 'Authorization'] =
    product === 'openrig' ? actor : `Bearer ${actor}`;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  // Key creation responses are intentionally excluded from evidence.
  if (label) observations.push({ label, method, path, status: r.status, response: summarise(data) });
  return { status: r.status, data };
}

if (product === 'paperclip') {
  if (phase === 'initial') {
    const companies = await api(null, 'GET', '/api/companies');
    state.company = companies.data.find(c => c.name === 'Retinue evaluation').id;
    const cp = `/api/companies/${state.company}`;
    state.agents = {};
    for (const name of ['Daily', 'Project', 'Landing', 'Monitor', 'Graph']) {
      const a = await api(`S0.1 agent ${name} without role/manager`, 'POST', `${cp}/agents`, {
        name: `${name} probe`, adapterType: 'process', adapterConfig: { command: '/bin/true' },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
      });
      if (a.status !== 201) throw new Error(JSON.stringify(a.data));
      const k = await api(null, 'POST', `/api/agents/${a.data.id}/keys`, { name: 'isolated-evaluation' });
      state.agents[name] = { id: a.data.id, token: k.data.token };
    }
    const daily = state.agents.Daily;
    await api('S0.2 agent-authenticated discovery', 'GET', `${cp}/agents`, undefined, daily.token);
    const backlog = await api('S0.3 unassigned backlog', 'POST', `${cp}/issues`, { title: 'Unassigned follow-up', idempotencyKey: 'baseline-backlog' });
    state.backlog = backlog.data.id;
    await api('S0.3 human-owned work', 'POST', `${cp}/issues`, { title: 'Quintin decision', assigneeUserId: 'local-board', idempotencyKey: 'human-task' });
    const request = { title: 'Vend demo subnet', description: 'Fake subnet only. Clarify size first.', assigneeAgentId: state.agents.Landing.id, idempotencyKey: 'subnet-event-001' };
    let subnet = await api('S2.1 unrelated peer creates request (agent key)', 'POST', `${cp}/issues`, request, daily.token);
    if (subnet.status >= 400) subnet = await api('S2.1 board fallback, not agent success', 'POST', `${cp}/issues`, request);
    state.subnet = subnet.data.id;
    await api('S1.3/S2.5 identical task creation retry', 'POST', `${cp}/issues`, request, daily.token);
    await api('S1.3 changed payload under same key', 'POST', `${cp}/issues`, { ...request, title: 'Changed request bytes' }, daily.token);
    await api('S1.4 daily driver task A', 'POST', `${cp}/issues`, { title: 'Daily active work', assigneeAgentId: daily.id });
    await api('S1.4 daily driver task B while A unresolved', 'POST', `${cp}/issues`, { title: 'Daily pending decision', assigneeAgentId: daily.id });
    await api('S1.2 project-targeted event', 'POST', `${cp}/issues`, { title: 'Project event follow-up', assigneeAgentId: state.agents.Project.id, idempotencyKey: 'project-message-001' }, daily.token);
    const deploy = await api('S2.3 deployment blocked by subnet', 'POST', `${cp}/issues`, {
      title: 'Deploy demo', assigneeAgentId: state.agents.Project.id, blockedByIssueIds: [state.subnet], status: 'blocked',
    });
    state.deploy = deploy.data.id;
    await api('S2.2 provider asks via comment with agent key', 'POST', `/api/issues/${state.subnet}/comments`, { body: 'What subnet size is required?' }, state.agents.Landing.token);
    const question = await api('S2.2 structured agent-directed question (agent key)', 'POST', `/api/issues/${state.subnet}/interactions`, {
      kind: 'ask_user_questions', idempotencyKey: 'subnet-size-question', addresseeAgentId: daily.id,
      continuationPolicy: 'wake_assignee', payload: { version: 1, questionSet: { schema: 'paperclip.question_set.v1', questions: [{ id: 'size', prompt: 'Subnet CIDR?', answerMode: 'text', required: true }] } },
    }, state.agents.Landing.token);
    state.question = question.data.id;
    await api('S2.2 requester answers via comment', 'POST', `/api/issues/${state.subnet}/comments`, { body: 'Use 10.230.1.0/24. This is a fixture.' }, daily.token);
    const graph = await api('S3.1 create graph work with agent reviewer', 'POST', `${cp}/issues`, {
      title: 'Update graph candidate', assigneeAgentId: state.agents.Graph.id,
      executionPolicy: { mode: 'normal', commentRequired: true, stages: [{ type: 'review', participants: [{ type: 'agent', agentId: daily.id }] }] },
    });
    state.graph = graph.data.id;
    const checkout = await api('S3.2 checkout with persistent agent key, no run', 'POST', `/api/issues/${state.graph}/checkout`, {
      agentId: state.agents.Graph.id, expectedStatuses: ['todo', 'backlog'],
    }, state.agents.Graph.token);
    await api('S3.2 submit candidate as agent', 'PATCH', `/api/issues/${state.graph}`, { status: 'done', comment: 'Candidate A: graph digest fixture-a.' }, state.agents.Graph.token);
    await api('S3.2 inspect persisted review state', 'GET', `/api/issues/${state.graph}`);
    state.checkout = checkout.status;
  } else {
    await api('S1.6 persisted backlog after restart', 'GET', `/api/issues/${state.backlog}`);
    await api('S2.5 persisted subnet request after restart', 'GET', `/api/issues/${state.subnet}`);
    await api('S3.6 persisted graph review after restart', 'GET', `/api/issues/${state.graph}`);
  }
} else {
  const daily = 'main-lead@daily', project = 'main-lead@project', landing = 'main-lead@landing';
  if (phase === 'initial') {
    await api('S0.3 unassigned backlog', 'POST', '/api/queue/create', { qitemId: 'eval-unassigned', body: 'Backlog' }, daily);
    const req = { qitemId: 'eval-subnet', destinationSession: landing, body: 'Vend fake subnet; clarify size.', nudge: false };
    await api('S2.1 unrelated peer request across rigs', 'POST', '/api/queue/create', req, daily);
    await api('S2.5 identical creation retry', 'POST', '/api/queue/create', req, daily);
    await api('S1.3 changed payload under same ID', 'POST', '/api/queue/create', { ...req, body: 'Different CIDR requirement' }, daily);
    await api('S0.3 human work without human registration', 'POST', '/api/queue/create', { qitemId: 'eval-human', destinationSession: 'human:quintin', body: 'Please decide', evidenceRef: 'fixture://message-1', nudge: false }, daily);
    await api('S2.1 provider claims', 'POST', '/api/queue/eval-subnet/claim', {}, landing);
    await api('S2.2 provider clarification deposit', 'POST', '/api/queue/inbox/drop', { inboxId: 'eval-question', destinationSession: daily, body: 'What subnet size?' }, landing);
    await api('S2.2 response deposit while provider owns work', 'POST', '/api/queue/inbox/drop', { inboxId: 'eval-answer', destinationSession: landing, body: '10.230.1.0/24' }, daily);
    for (const [id, destination] of [['daily-a', daily], ['daily-b', daily], ['project-event', project]]) {
      await api(`S1.4 create ${id}`, 'POST', '/api/queue/create', { qitemId: `eval-${id}`, destinationSession: destination, body: id, nudge: false }, 'main-lead@monitor');
      if (destination === daily) await api(`S1.4 claim ${id}`, 'POST', `/api/queue/eval-${id}/claim`, {}, daily);
    }
    await api('S2.4 provider closes with fake result', 'POST', '/api/queue/eval-subnet/update', { state: 'done', closureReason: 'no-follow-on', transitionNote: 'subnetId=/subscriptions/fixture/subnets/demo; CIDR=10.230.1.0/24', evidenceRef: 'fixture://subnet' }, landing);
    await api('S2.4 result notification to requester', 'POST', '/api/queue/inbox/drop', { inboxId: 'eval-result', destinationSession: daily, body: 'Subnet ready: /subscriptions/fixture/subnets/demo' }, landing);
    await api('S3.1 graph request', 'POST', '/api/queue/create', { qitemId: 'eval-graph', destinationSession: 'main-lead@graph', body: 'Update graph and return exact candidate', nudge: false }, daily);
    await api('S3.2 graph claim', 'POST', '/api/queue/eval-graph/claim', {}, 'main-lead@graph');
    await api('S3.2 handoff candidate for review', 'POST', '/api/queue/eval-graph/handoff', { toSession: daily, body: 'Candidate A: fixture-a. Review before commit.', evidenceRef: 'fixture://graph-a', nudge: false }, 'main-lead@graph');
  } else {
    await api('S1.6 durable inbox after restart', 'GET', `/api/queue/inbox/pending?destinationSession=${daily}`, undefined, daily);
    await api('S2.5 subnet state after restart', 'GET', '/api/queue/eval-subnet');
    await api('S3.6 graph handoff after restart', 'GET', '/api/queue/eval-graph');
  }
}
if (phase === 'initial') state.initialCompleted = true;
fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
fs.writeFileSync(`/home/node/${product}-${phase}-evidence.json`, JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations, null, 2));
