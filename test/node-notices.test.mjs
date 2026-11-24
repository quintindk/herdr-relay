import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeJournal } from '../src/node-journal.mjs';
import { tickAgentNotices } from '../src/node-notices.mjs';

test('addressed question delivers one bounded initiating-agent turn and refuses resend after lost native reply', async () => {
  const journal = new NodeJournal(':memory:', { nodeId: 'desktop', instanceId: 'backend' });
  const question = { id: 'q', revision: 1, taskId: 'task', prompt: 'Which region?', status: 'open', addressedTo: { type: 'agent', id: 'initiator' } };
  journal.consume({ cursor: 'cursor', items: [{ id: 'event', type: 'question.ask', entityId: 'q', revision: 1, data: question }] });
  const sends = [];
  let idle = false;
  const binding = { id: 'binding', native: { snapshot: async () => ({ idle, messages: [], inbox: [] }),
    send: async invocation => { sends.push(invocation); throw new Error('lost reply'); } }, observe: () => ({ state: 'finished', outcome: 'succeeded' }) };
  try {
    const pending = JSON.parse(journal.db.prepare('SELECT data FROM notices').get().data);
    assert.equal(pending.kind, 'question');
    // A queued question persisted by an older node still gets a notice tag.
    const { kind, ...legacy } = pending;
    journal.db.prepare('UPDATE notices SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
    await tickAgentNotices(journal, async () => question, async () => binding);
    assert.equal(sends.length, 0);
    idle = true;
    await tickAgentNotices(journal, async () => question, async () => binding);
    await tickAgentNotices(journal, async () => question, async () => binding);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].noticeKind, 'question');
    assert.equal(journal.db.prepare('SELECT state FROM notices').get().state, 'settled');
  } finally { journal.close(); }
});
