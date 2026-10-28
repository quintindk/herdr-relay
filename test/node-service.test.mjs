import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { startNodeService } from '../src/node-service.mjs';
import { call } from '../src/client.mjs';

test('worker stages one exact result, cannot impersonate another agent or mix a question and result', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-node-service-'));
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  journal.save({ id: 'execution', state: 'observing', execution: { id: 'execution', state: 'accepted', targetAgentId: 'worker', runId: 'run' } });
  const socketPath = join(directory, 'node.sock');
  const service = await startNodeService({ journal, socketPath, workers: [{ agentId: 'worker', token: 'worker-token' }, { agentId: 'other', token: 'other-token' }] });
  try {
    const connection = { socketPath, token: 'worker-token' };
    const body = { executionId: 'execution', runId: 'run', key: 'result', payload: { candidate: 'sha256:one', summary: 'Done' } };
    assert.equal((await call(connection, 'POST', '/work/submit', body)).state, 'staged');
    await call(connection, 'POST', '/work/submit', body);
    assert.equal(journal.work('execution').staged.kind, 'result');
    await assert.rejects(call(connection, 'POST', '/work/ask', { ...body, payload: { prompt: 'Which region?' } }), { code: 'operation_conflict' });
    await assert.rejects(call({ socketPath, token: 'other-token' }, 'POST', '/work/read', body), { code: 'forbidden' });
    await assert.rejects(call(connection, 'POST', '/work/read', { ...body, runId: 'stale' }), { code: 'forbidden' });
  } finally { await service.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); }
});
