import assert from 'node:assert/strict';
import test from 'node:test';
import { githubTasksProvider } from '../src/tasks-provider.mjs';

test('GitHub comment reads retain authors and explicit pagination', async () => {
  const calls = [];
  const provider = githubTasksProvider(async (method, path) => {
    calls.push({ method, path });
    return [{ id: 11, body: 'Comment', user: { login: 'human' }, created_at: 't1', updated_at: 't2' }];
  }, { owner: 'o', repo: 'r' });
  const page = await provider.listComments('1', { limit: 1 });
  assert.deepEqual(page.items[0].author, { type: 'user', id: 'human' });
  assert.equal(page.items[0].taskId, '1');
  assert.equal(page.nextCursor, '2');
  assert.equal(page.complete, false);
  assert.equal(calls[0].path, '/repos/o/r/issues/1/comments?per_page=1&page=1');
  await assert.rejects(provider.listComments('1', { cursor: '1&other=2' }), { code: 'invalid_query' });
  assert.equal(calls.length, 1);
});

test('GitHub relationships preserve cross-repository identity and refuse false completeness', async () => {
  const issue = (number, repo = 'o/r') => ({ id: number * 10, number, repository_url: `https://api.github.com/repos/${repo}`,
    html_url: `https://github.com/${repo}/issues/${number}`, state: 'open' });
  const provider = githubTasksProvider(async (_method, path) => {
    if (path.includes('/sub_issues?')) return [issue(2)];
    if (path.includes('/dependencies/blocked_by?')) return [issue(3), issue(3, 'other/repo')];
    return issue(1);
  }, { owner: 'o', repo: 'r' });
  const relations = await provider.listRelations('1');
  assert.equal(relations.children[0].id, '2');
  assert.deepEqual(relations.dependencies, ['3']);
  assert.equal(relations.blockedBy[1].id, null);
  assert.equal(relations.blockedBy[1].repository, 'other/repo');
  assert.equal(relations.complete, false);
  assert.equal(Object.hasOwn(relations, 'parentId'), false);
});

test('GitHub relationship errors and exhausted traversal never become empty success', async () => {
  let calls = 0;
  const provider = githubTasksProvider(async (_method, path) => {
    calls++;
    if (!path.includes('?')) return {};
    return Array.from({ length: 100 }, () => ({ id: 20, number: 2, repository_url: 'https://api.github.com/repos/o/r' }));
  }, { owner: 'o', repo: 'r' });
  await assert.rejects(provider.listRelations('1'), { code: 'incomplete_query' });
  assert.equal(calls, 101);
  const denied = githubTasksProvider(async () => { throw Object.assign(new Error('denied'), { status: 403 }); }, { owner: 'o', repo: 'r' });
  await assert.rejects(denied.listRelations('1'), { status: 403 });
});
