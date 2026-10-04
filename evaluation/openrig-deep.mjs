import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const base = 'http://127.0.0.1:17300';
const daily = 'main-lead@daily', worker = 'main-lead@graph', monitor = 'main-lead@monitor';
const evidence = [];
async function api(label, method, path, body, actor = daily) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-OpenRig-Session': actor }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  evidence.push({ label, status: r.status, body: data });
  return data;
}
function cli(label, args) {
  try { const output = execFileSync('rig', args, { encoding: 'utf8', env: { ...process.env, OPENRIG_SESSION_NAME: daily } }); evidence.push({ label, exitCode: 0, output }); return output; }
  catch (e) { evidence.push({ label, exitCode: e.status, output: e.stdout?.toString(), error: e.stderr?.toString() }); return null; }
}
cli('S0.3 register human without connector', ['gateway', 'human', 'add', 'quintin', '--display-name', 'Quintin', '--actor', 'evaluation']);
cli('S0.3 register human with placeholder Slack binding', ['gateway', 'human', 'add', 'quintin', '--display-name', 'Quintin', '--binding', 'slack:fixture:fixture-secret:primary', '--delivery-class', 'D', '--actor', 'evaluation']);
cli('S0.3 read registered human address', ['gateway', 'human', 'show', 'quintin', '--json']);
await api('S0.3 human-owned queue with registered address', 'POST', '/api/queue/create', { qitemId: 'eval-registered-human', destinationSession: 'quintin@gateway', body: 'Decide demo direction', summary: 'Demo direction', evidenceRef: 'fixture://message-1', nudge: false });
await api('S1.2 event without a task', 'POST', '/api/stream/emit', { streamItemId: 'eval-mail-1', sourceSession: monitor, body: 'Unimportant newsletter', hintType: 'mail' }, monitor);
await api('S1.3 repeat event', 'POST', '/api/stream/emit', { streamItemId: 'eval-mail-1', sourceSession: monitor, body: 'Unimportant newsletter', hintType: 'mail' }, monitor);
await api('S1.6 notification retained while recipient offline', 'POST', '/api/queue/inbox/drop', { inboxId: 'eval-offline-event', destinationSession: daily, body: 'Important Teams event source=teams-42' }, monitor);
await api('S2.4 corrected closure preserves result in transition note', 'POST', '/api/queue/eval-subnet/update', { state: 'done', closureReason: 'no-follow-on', transitionNote: 'Fixture subnet /subscriptions/fixture/subnets/demo' }, 'main-lead@landing');
await api('S2.4 verify recorded result', 'GET', '/api/queue/eval-subnet/transitions');
await api('S2.3 create new live dependency', 'POST', '/api/queue/create', { qitemId: 'eval-subnet-2', destinationSession: 'main-lead@landing', body: 'Second subnet fixture', nudge: false });
await api('S2.3 create dependent work', 'POST', '/api/queue/create', { qitemId: 'eval-deploy', destinationSession: 'main-lead@project', body: 'Deploy once subnet exists', nudge: false });
await api('S2.3 block on live qitem', 'POST', '/api/queue/eval-deploy/update', { state: 'blocked', blockedOn: 'eval-subnet-2', transitionNote: 'Continue deployment once subnet result is available' }, 'main-lead@project');
await api('S2.3 complete blocker', 'POST', '/api/queue/eval-subnet-2/update', { state: 'done', closureReason: 'no-follow-on', transitionNote: 'Fake subnet ready' }, 'main-lead@landing');
await api('S2.3 dependent after closure', 'GET', '/api/queue/eval-deploy');
await api('S2.6 cancel a claimed obligation', 'POST', '/api/queue/eval-daily-b/update', { state: 'canceled', transitionNote: 'No longer needed' });

fs.writeFileSync('/home/node/eval-workflow.yaml', `workflow:
  id: eval-acceptance
  version: 1
  entry: { role: producer }
  roles:
    producer: { preferred_targets: [${worker}] }
    reviewer: { preferred_targets: [${daily}] }
  steps:
    - id: produce
      actor_role: producer
      allowed_exits: [handoff]
    - id: accept
      actor_role: reviewer
      acceptance:
        candidate: candidate-b
        verdicts: [CLEAR]
        evidence_ref: /home/node/graph-proof.json
      allowed_exits: [done]
`);
const instance = await api('S3 typed acceptance instantiate', 'POST', '/api/workflow/instantiate', { specPath: '/home/node/eval-workflow.yaml', rootObjective: 'Review graph candidate', createdBySession: daily });
if (instance.instance?.instanceId) {
  const instanceId = instance.instance.instanceId;
  const projected = await api('S3 submit through workflow', 'POST', '/api/workflow/project', { instanceId, currentPacketId: instance.entryQitemId, exit: 'handoff', actorSession: worker }, worker);
  const currentPacketId = projected.nextQitemId;
  if (currentPacketId) {
    await api('S3.3 reject stale candidate A', 'POST', '/api/workflow/project', { instanceId, currentPacketId, exit: 'done', actorSession: daily, acceptance: { candidate: 'candidate-a', verdict: 'CLEAR', evidenceRef: '/home/node/graph-proof.json' } });
    await api('S3.3 accept exact candidate B', 'POST', '/api/workflow/project', { instanceId, currentPacketId, exit: 'done', actorSession: daily, acceptance: { candidate: 'candidate-b', verdict: 'CLEAR', evidenceRef: '/home/node/graph-proof.json' } });
    await api('S3 inspect workflow', 'GET', `/api/workflow/${instanceId}`);
  }
}
cli('S3.5 runtime still exists after review', ['ps', '--nodes', '--rig', 'graph', '--json']);
cli('S1.1 schedule monitor reminder', ['watchdog', 'register', '--policy', 'periodic-reminder', '--target-session', monitor, '--interval-seconds', '3600', '--registered-by', daily, '--json']);
fs.writeFileSync('/home/node/openrig-deep-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
