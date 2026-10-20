import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ProviderJournal } from '../src/provider-journal.mjs';
import { githubTasksProvider } from '../src/tasks-provider.mjs';

test('lost GitHub create reply reconciles one issue and never blindly sends another create', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new ProviderJournal(db, 'github:o/r');
  const issues = [];
  let posts = 0;
  const provider = githubTasksProvider(async (method, _path, body) => {
    if (method === 'GET') return issues;
    posts++;
    issues.push({ id: 10, number: 1, title: body.title, body: body.body, state: 'open', labels: body.labels,
      updated_at: 'r1', html_url: 'https://github.com/o/r/issues/1' });
    throw new Error('lost response');
  }, { owner: 'o', repo: 'r', journal });
  try {
    const task = { title: 'One', description: 'Work' };
    await assert.rejects(provider.createTask(task, { key: 'create' }), /lost response/);
    assert.equal((await provider.createTask(task, { key: 'create' })).id, '1');
    assert.equal(posts, 1);
    await assert.rejects(provider.createTask({ ...task, title: 'Changed' }, { key: 'create' }), { code: 'operation_conflict' });
  } finally { db.close(); }
});

test('unobserved external publication stays uncertain even when no matching object is found', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new ProviderJournal(db, 'scope');
  let sends = 0;
  const input = { key: 'key', kind: 'create', payload: {}, send: async () => { sends++; throw new Error('lost'); }, reconcile: async () => null };
  try {
    await assert.rejects(journal.perform(input), /lost/);
    await assert.rejects(journal.perform(input), { code: 'operation_uncertain' });
    assert.equal(sends, 1);
  } finally { db.close(); }
});

test('concurrent identical external publications share the same in-flight operation', async () => {
  const db = new DatabaseSync(':memory:');
  const journal = new ProviderJournal(db, 'scope');
  let sends = 0, release;
  const input = { key: 'one', kind: 'create', payload: { title: 'One' },
    send: async () => { sends++; return new Promise(resolve => { release = resolve; }); }, reconcile: async () => null };
  try {
    const first = journal.perform(input);
    const second = journal.perform(input);
    await assert.rejects(journal.perform({ ...input, payload: { title: 'Changed' } }), { code: 'operation_conflict' });
    release({ id: 'receipt' });
    assert.deepEqual(await first, await second);
    assert.equal(sends, 1);
  } finally { db.close(); }
});
