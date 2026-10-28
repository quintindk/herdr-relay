import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeJournal } from '../src/node-journal.mjs';
import { installLocalSchedule } from '../src/node-schedules.mjs';
import { tickAutomation } from '../src/node-automation.mjs';
import { resolveFolderBinding } from '../src/node-folder.mjs';

test('folder occurrences select one explicit binding, retain admitted identity and use replacements only for future work', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'relay-folder-')));
  const journal = new NodeJournal(':memory:', { nodeId: 'node', instanceId: 'backend' });
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  const start = Date.parse('2026-10-20T06:00:00Z');
  let sends = 0;
  const binding = id => ({ id, identity: { directory, sessionId: id }, native: {
    snapshot: async () => ({ idle: true, inbox: [], messages: [] }), send: async () => { sends++; },
  }, observe: () => ({ state: 'observed' }) });
  const bindings = new Map([['a', binding('a')], ['b', binding('b')]]);
  const resolve = async id => bindings.get(id);
  resolve.folder = folder => resolveFolderBinding(bindings, folder, resolve);
  installLocalSchedule(journal, { id: 'job', revision: 1, nodeId: 'node', targetFolder: directory,
    instructions: 'Check', cron: '* * * * *', enabled: true }, start);
  await tickAutomation(journal, resolve, start + 60000);
  assert.equal(sends, 0);
  bindings.delete('b');
  await tickAutomation(journal, resolve, start + 60000);
  const first = journal.works()[0];
  assert.equal(first.execution.targetAgentId, 'a');
  assert.equal(first.nativeConversationId, 'a');
  bindings.delete('a'); bindings.set('b', binding('b'));
  await tickAutomation(journal, resolve, start + 60000);
  assert.equal(sends, 1);
  assert.equal(journal.work(first.id).bindingId, 'a');
  journal.db.prepare("UPDATE occurrences SET state='completed'").run();
  journal.save({ ...first, state: 'settled', execution: { ...first.execution, state: 'completed' } });
  await tickAutomation(journal, resolve, start + 120000);
  assert.equal(sends, 2);
  assert.equal(journal.works().find(work => work.id !== first.id).execution.targetAgentId, 'b');
});
