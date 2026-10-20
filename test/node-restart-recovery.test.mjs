import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BackendStore } from '../src/backend-store.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickNode, submitNodeResult } from '../src/node-execution.mjs';

for (const observed of [false, true]) test(`native journal restart preserves lost-send intent with observed=${observed}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-recovery-'));
  let store = new BackendStore(join(directory, 'backend.sqlite'));
  const token = store.bootstrap().token;
  const owner = store.authenticate(token);
  const cmd = (actor, action, payload) => store.command(actor, { key: crypto.randomUUID(), action, payload });
  cmd(owner, 'node.enrol', { id: 'node', name: 'Node' });
  const nodeToken = store.enrolCredential(owner, 'node', 'credential').token;
  let node = store.authenticate(nodeToken);
  cmd(node, 'agent.register', { id: 'agent', nodeId: 'node', name: 'Agent', mode: 'headless' });
  cmd(owner, 'task.create', { id: 'task', title: 'Work' });
  cmd(owner, 'execution.request', { id: 'e', taskId: 'task', taskRevision: 1, targetAgentId: 'agent', instructions: 'Work' });
  const identity = { nodeId: 'node', instanceId: store.instance };
  let journal = new NodeJournal(join(directory, 'node.sqlite'), identity);
  t.after(() => { journal.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = async (method, path, body) => {
    if (method === 'POST') return store.command(node, body);
    if (path.startsWith('/v1/events')) return store.events({ cursor: new URL(path, 'http://local').searchParams.get('cursor') ?? undefined });
    return store.get(path.includes('/tasks/') ? 'task' : 'execution', path.split('/').at(-1));
  };
  let sends = 0;
  const binding = { id: 'binding', identity: { sessionId: 'session' }, native: {
    snapshot: async () => ({ idle: true, inbox: [], messages: [] }),
    send: async () => { sends++; throw new Error('Lost native reply'); },
  }, observe: () => observed ? { state: 'finished', outcome: 'succeeded', messageId: 'terminal' } : { state: 'unobserved' } };
  await tickNode(journal, api, async () => binding);
  const invocation = journal.work('e').invocation;
  journal.close(); store.close();
  store = new BackendStore(join(directory, 'backend.sqlite'));
  node = store.authenticate(nodeToken);
  journal = new NodeJournal(join(directory, 'node.sqlite'), identity);
  await tickNode(journal, api, async () => binding);
  await tickNode(journal, api, async () => binding);
  assert.equal(sends, 1);
  assert.deepEqual(journal.work('e').invocation, invocation);
  if (observed) {
    binding.native.snapshot = async () => { throw new Error('Native history unavailable after proved settlement'); };
    await tickNode(journal, api, async () => binding);
    assert.equal(journal.work('e').observation.messageId, 'terminal');
    submitNodeResult(journal, 'e', { candidate: 'candidate', summary: 'Done' });
    await journal.flush(api);
    assert.equal(store.get('execution', 'e').state, 'completed');
  } else {
    assert.equal(journal.work('e').state, 'uncertain');
    assert.equal(store.get('execution', 'e').state, 'accepted');
  }
});
