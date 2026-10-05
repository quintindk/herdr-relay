import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../src/service.mjs';
import { execute } from '../src/adapter.mjs';
import { digest } from '../src/protocol.mjs';

test('real adapter child-wake path returns success without dispatch, comments or replacement review', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-review-wake-'));
  let interaction;
  const api = async (_, token, method, path) => {
    assert.equal(token, 'backend-token'); assert.equal(method, 'GET');
    if (path.includes('/heartbeat-runs/')) return { id: 'wake', companyId: 'company', agentId: 'agent', status: 'running',
      invocationSource: 'automation', contextSnapshot: { wakeReason: 'issue_children_completed', taskId: 'task' } };
    if (path.endsWith('/interactions')) return [interaction];
    return { id: 'task', companyId: 'company', assigneeAgentId: 'agent', status: 'in_review' };
  };
  const service = await startService({ directory, paperclipUrl: 'http://127.0.0.1:3100', api });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = service.store;
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'task', runId: 'original' });
  store.acknowledge(run.id); store.submit(run.id, { key: 'one', candidate: 'candidate', summary: 'Created child' });
  store.publication(run.id, { state: 'recorded' }); store.settle(run.id, { outcome: 'completed', evidence: 'Fixture completed' });
  run = store.recordReview(run.id, { interactionId: 'review', status: 'pending', candidate: 'candidate' });
  interaction = { id: 'review', kind: 'request_confirmation', status: 'pending', idempotencyKey: `relay-review:${run.id}:${digest(run.result)}`,
    payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } };
  const contextFile = join(directory, 'operator.json');
  writeFileSync(contextFile, JSON.stringify({ socketPath: service.socketPath, token: service.token }), { mode: 0o600 });
  const ctx = { config: { relayContextFile: contextFile, bindingId: 'worker', requireReviewDisposition: true },
    authToken: 'backend-token', runId: 'wake', agent: { id: 'agent', companyId: 'company' },
    context: { taskId: 'task', wakeReason: 'issue_children_completed' }, onLog: async () => {} };
  const result = await execute(ctx);
  assert.equal(result.exitCode, 0); assert.equal(result.resultJson.skipped, true);
  assert.equal(result.resultJson.reviewInteractionId, 'review'); assert.equal(store.runs().length, 1);
  assert.deepEqual(await execute(ctx), result);
  assert.equal(store.run(run.id).review.interactionId, 'review');
});
