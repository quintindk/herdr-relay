import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { waitForChild } from '../src/dependencies.mjs';
import { promptFor } from '../src/supervisor.mjs';

function fixture(t, path = ':memory:') {
  const store = new Store(path); t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  const run = store.acknowledge(store.dispatch({ bindingId: 'worker', bindingRevision: 1,
    companyId: 'company', agentId: 'agent', taskId: 'parent', runId: 'backend' }).id);
  const children = ['a', 'b'].map(id => ({ id, companyId: 'company', parentId: 'parent', assigneeAgentId: 'peer', status: 'todo' }));
  const issue = { id: 'parent', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress', blockedBy: [{ issueId: 'existing' }] };
  const writes = [];
  const api = async (_, __, method, path, body) => {
    if (method === 'PATCH') {
      assert.equal(store.operation(`dependency:${run.id}`).state, 'uncertain');
      writes.push(body);
      issue.status = body.status;
      issue.blockedBy = body.blockedByIssueIds.map(id => ({ id }));
    }
    return structuredClone(path.endsWith('/parent') ? issue : children.find(child => path.endsWith(`/${child.id}`)));
  };
  return { store, run, children, issue, writes, api };
}

test('child wait persists dependency, survives lost PATCH reply and settles only on terminal evidence', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  let run = store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: 'company', agentId: 'agent', taskId: 'parent', runId: 'backend' });
  run = store.acknowledge(run.id);
  const child = { id: 'child', companyId: 'company', parentId: 'parent', assigneeAgentId: 'peer', status: 'todo' };
  const issue = { id: 'parent', companyId: 'company', assigneeAgentId: 'agent', status: 'in_progress', blockedBy: [] };
  let writes = 0;
  const api = async (_, __, method, path, body) => {
    if (path.endsWith('/child')) return child;
    if (method === 'PATCH') { writes++; issue.status = body.status; issue.blockedBy = body.blockedByIssueIds.map(id => ({ id })); throw new Error('lost'); }
    return issue;
  };
  await assert.rejects(waitForChild(store, run, 'token', api, { taskId: 'child' }));
  await waitForChild(store, run, 'token', api, { taskId: 'child' });
  assert.equal(writes, 1);
  assert.equal(store.run(run.id).dependency.childId, 'child');
  assert.throws(() => store.submit(run.id, { key: 'bad', summary: 'premature', candidate: 'bad' }), { code: 'work_waiting' });
  store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed' });
  store.beginNative(run.id, 'prompt', []);
  store.nativeStatus(run.id, { state: 'finished', messageId: 'reply' });
  store.finishNative(run.id, store.run(run.id).native);
  assert.equal(store.run(run.id).settlement.outcome, 'waiting');
  child.companyId = 'other';
  await assert.rejects(waitForChild(store, run, 'token', api, { taskId: 'child' }), { code: 'work_inactive' });
});

test('two children use a canonical set, preserve blockers and reject a changed set', async t => {
  const { store, run, api, writes } = fixture(t);
  const result = await waitForChild(store, run, 'token', api, { taskIds: ['b', 'a'] });
  assert.deepEqual(result.dependency, { taskIds: ['a', 'b'], state: 'recorded' });
  assert.deepEqual(writes, [{ status: 'blocked', blockedByIssueIds: ['a', 'b', 'existing'] }]);
  assert.deepEqual(store.operation(`dependency:${run.id}`).taskIds, ['a', 'b']);
  await waitForChild(store, run, 'token', api, { taskIds: ['a', 'b'] });
  assert.equal(writes.length, 1);
  await assert.rejects(waitForChild(store, run, 'token', api, { taskIds: ['a'] }), { code: 'operation_conflict' });
  assert.throws(() => store.submit(run.id, { key: 'bad', summary: 'premature', candidate: 'bad' }), { code: 'work_waiting' });
});

test('invalid task sets are rejected before any backend access', async t => {
  const { store, run } = fixture(t);
  for (const input of [null, {}, { taskIds: [] }, { taskIds: 'a' }, { taskIds: ['a', 'a'] },
    { taskIds: ['a', ''] }, { taskIds: ['a', null] }, { taskIds: [' a'] },
    { taskIds: Array.from({ length: 65 }, (_, id) => `${id}`) }, { taskId: 'a', taskIds: ['a'] }]) {
    await assert.rejects(waitForChild(store, run, 'token', () => assert.fail('unexpected backend access'), input), { code: 'invalid_request' });
  }
  assert.equal(store.operation(`dependency:${run.id}`), null);
});

test('every child and the parent must have exact scope and ownership before mutation', async t => {
  for (const [target, change, code] of [
    ['child', { companyId: 'foreign' }, 'dependency_scope_mismatch'],
    ['child', { parentId: 'foreign' }, 'dependency_scope_mismatch'],
    ['child', { id: 'wrong' }, 'dependency_scope_mismatch'],
    ['child', { assigneeAgentId: 'agent' }, 'invalid_dependency'],
    ['child', { assigneeAgentId: null }, 'invalid_dependency'],
    ['parent', { companyId: 'foreign' }, 'dependency_scope_mismatch'],
    ['parent', { assigneeAgentId: 'foreign' }, 'dependency_scope_mismatch'],
    ['parent', { executionRunId: 'foreign' }, 'dependency_scope_mismatch'],
    ['parent', { id: 'wrong' }, 'dependency_scope_mismatch'],
  ]) {
    await t.test(`${target} ${JSON.stringify(change)}`, async t => {
      const { store, run, api, writes } = fixture(t);
      const changed = async (...args) => {
        const value = await api(...args);
        return args[3].endsWith(target === 'child' ? '/b' : '/parent') ? { ...value, ...change } : value;
      };
      await assert.rejects(waitForChild(store, run, 'token', changed, { taskIds: ['a', 'b'] }), { code });
      assert.equal(writes.length, 0);
      assert.equal(store.operation(`dependency:${run.id}`), null);
    });
  }
});

test('done children are satisfied, cancelled children explicitly require blocked-work inspection', async t => {
  for (const status of ['done', 'cancelled']) {
    await t.test(status, async t => {
      const { store, run, children, writes, api, issue } = fixture(t);
      children[0].status = status;
      const result = await waitForChild(store, run, 'token', api, { taskIds: ['a', 'b'] });
      assert.deepEqual(writes[0].blockedByIssueIds, status === 'done' ? ['b', 'existing'] : ['a', 'b', 'existing']);
      assert.deepEqual(result.dependency.taskIds, ['a', 'b']);
      assert.equal(result.dependencyWait.state, status === 'done' ? 'waiting' : 'blocked');
      assert.deepEqual(result.dependencyWait[status === 'done' ? 'doneTaskIds' : 'cancelledTaskIds'], ['a']);
      if (status === 'cancelled') {
        assert.match(result.dependencyWait.message, /not successful/);
        children[1].status = 'done';
        const retry = await waitForChild(store, run, 'token', api, { taskIds: ['a', 'b'] });
        assert.equal(retry.dependencyWait.state, 'waiting');
        assert.deepEqual(issue.blockedBy.map(item => item.id), ['a', 'b', 'existing']);
        assert.equal(issue.status, 'blocked');
        assert.equal(writes.length, 1);
        assert.deepEqual(store.operation(`dependency:${run.id}`).blockedByIssueIds, ['a', 'b', 'existing']);
        assert.throws(() => store.submit(run.id, { key: 'bad', summary: 'premature', candidate: 'bad' }), { code: 'work_waiting' });
      }
    });
  }
});

test('all terminal children leave native parent work active with actionable inspection', async t => {
  for (const statuses of [['done', 'done'], ['cancelled', 'done'], ['cancelled', 'cancelled']]) {
    await t.test(statuses.join(','), async t => {
      const { store, run, children, writes, api, issue } = fixture(t);
      children.forEach((child, index) => { child.status = statuses[index]; });
      const result = await waitForChild(store, run, 'token', api, { taskIds: ['a', 'b'] });
      assert.equal(result.dependencyWait.state, 'needs_inspection');
      assert.match(result.dependencyWait.message, /task inspect/);
      assert.equal(writes.length, 0);
      assert.equal(issue.status, 'in_progress');
      assert.equal(store.operation(`dependency:${run.id}`), null);
      assert.equal(store.run(run.id).dependency, undefined);
      store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed' });
      store.beginNative(run.id, 'prompt', []);
      store.nativeStatus(run.id, { state: 'finished', messageId: 'reply' });
      store.finishNative(run.id, store.run(run.id).native);
      assert.equal(store.run(run.id).nativeState, 'claimed');
    });
  }
});

test('lost committed replies reconcile the original set across restart even after children finish', async t => {
  for (const finished of [0, 1, 2]) {
    await t.test(`${finished} finished`, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'relay-dependencies-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const path = join(directory, 'state.db');
      const { store, run, children, writes, api } = fixture(t, path);
      const lost = async (...args) => {
        const value = await api(...args);
        if (args[2] === 'PATCH') throw new Error('lost committed reply');
        return value;
      };
      await assert.rejects(waitForChild(store, run, 'token', lost, { taskIds: ['b', 'a'] }), /lost committed reply/);
      assert.equal(store.operation(`dependency:${run.id}`).state, 'uncertain');
      children.slice(0, finished).forEach(child => { child.status = 'done'; });
      const reopened = new Store(path); t.after(() => reopened.close());
      await assert.rejects(waitForChild(reopened, run, 'token', api, { taskIds: ['a'] }), { code: 'operation_conflict' });
      const result = await waitForChild(reopened, run, 'token', api, { taskIds: ['a', 'b'] });
      assert.equal(writes.length, 1);
      assert.deepEqual(reopened.operation(`dependency:${run.id}`).blockedByIssueIds, ['a', 'b', 'existing']);
      assert.equal(reopened.operation(`dependency:${run.id}`).state, 'recorded');
      assert.equal(result.dependencyWait.state, finished === 2 ? 'needs_inspection' : 'waiting');
      assert.equal(Boolean(reopened.run(run.id).dependency), finished !== 2);
    });
  }
});

test('lost successful wait responses retain the end-turn disposition after restart and terminal children', async t => {
  for (const single of [false, true]) {
    for (const status of ['done', 'cancelled']) {
      for (const matchingParent of [false, true]) {
        await t.test(`single=${single} status=${status} matchingParent=${matchingParent}`, async t => {
          const directory = mkdtempSync(join(tmpdir(), 'relay-dependencies-'));
          t.after(() => rmSync(directory, { recursive: true, force: true }));
          const path = join(directory, 'state.db');
          const { store, run, children, issue, writes, api } = fixture(t, path);
          const input = single ? { taskId: 'a' } : { taskIds: ['b', 'a'] };
          await waitForChild(store, run, 'token', api, input);
          const dependency = store.run(run.id).dependency;
          children.forEach(child => { child.status = status; });
          if (!matchingParent) {
            issue.status = 'in_progress';
            issue.blockedBy = [];
          }
          const reopened = new Store(path); t.after(() => reopened.close());
          const result = await waitForChild(reopened, run, 'token', api, input);
          assert.deepEqual(result.dependency, dependency);
          assert.equal(result.dependencyWait.state, 'waiting');
          assert.match(result.dependencyWait.message, /finish this turn without submitting/i);
          assert.deepEqual(result.dependencyWait[status === 'done' ? 'doneTaskIds' : 'cancelledTaskIds'], single ? ['a'] : ['a', 'b']);
          assert.equal(writes.length, 1);
          assert.throws(() => reopened.submit(run.id, { key: 'bad', summary: 'premature', candidate: 'bad' }), { code: 'work_waiting' });
          reopened.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed' });
          reopened.beginNative(run.id, 'prompt', []);
          reopened.nativeStatus(run.id, { state: 'finished', messageId: 'reply' });
          reopened.finishNative(run.id, reopened.run(run.id).native);
          assert.equal(reopened.run(run.id).settlement.outcome, 'waiting');
        });
      }
    }
  }
});

test('uncertain operations never blindly replay, including lost original blockers', async t => {
  for (const committed of [false, true]) {
    await t.test(`committed=${committed}`, async t => {
      const { store, run, api, issue, writes } = fixture(t);
      let attempts = 0;
      const lost = async (...args) => {
        if (args[2] === 'PATCH') {
          attempts++;
          if (committed) await api(...args);
          throw new Error('lost');
        }
        return api(...args);
      };
      await assert.rejects(waitForChild(store, run, 'token', lost, { taskIds: ['a', 'b'] }), /lost/);
      if (committed) issue.blockedBy = [{ id: 'a' }, { id: 'b' }];
      await assert.rejects(waitForChild(store, run, 'token', lost, { taskIds: ['b', 'a'] }), { code: 'dependency_uncertain' });
      assert.equal(attempts, 1);
      assert.equal(writes.length, committed ? 1 : 0);
      assert.equal(store.run(run.id).dependency, undefined);
    });
  }
});

test('finished children with no matching receipt return inspection without replay or settlement', async t => {
  const { store, run, api, children, writes } = fixture(t);
  await assert.rejects(waitForChild(store, run, 'token', async (...args) => {
    if (args[2] === 'PATCH') throw new Error('lost');
    return api(...args);
  }, { taskIds: ['a', 'b'] }), /lost/);
  children.forEach(child => { child.status = 'cancelled'; });
  const result = await waitForChild(store, run, 'token', api, { taskIds: ['a', 'b'] });
  assert.equal(result.dependencyWait.state, 'needs_inspection');
  assert.match(result.dependencyWait.message, /unconfirmed/);
  assert.equal(store.operation(`dependency:${run.id}`).state, 'uncertain');
  assert.equal(store.run(run.id).dependency, undefined);
  assert.equal(writes.length, 0);
});

test('lost confirmation GET reconciles without another PATCH', async t => {
  const { store, run, api, writes } = fixture(t);
  await assert.rejects(waitForChild(store, run, 'token', async (...args) => {
    if (args[2] === 'GET' && writes.length) throw new Error('lost receipt');
    return api(...args);
  }, { taskIds: ['a', 'b'] }), /lost receipt/);
  await waitForChild(store, run, 'token', api, { taskIds: ['b', 'a'] });
  assert.equal(writes.length, 1);
});

test('live active state is checked after every await before any further writes', async t => {
  for (const change of ['cancel', 'submit', 'waiting', 'settle', 'recover', 'dependency']) {
    for (const after of [1, 2, 3, 4, 5]) {
      await t.test(`${change} after await ${after}`, async t => {
        const { store, run, api, writes } = fixture(t);
        let calls = 0;
        const changed = async (...args) => {
          const value = await api(...args);
          if (++calls === after) {
            const live = store.run(run.id);
            if (change === 'cancel') live.cancellationRequested = true;
            if (change === 'submit') live.result = { summary: 'finished' };
            if (change === 'waiting') live.waiting = { state: 'pending' };
            if (change === 'settle') live.nativeState = 'settled';
            if (change === 'recover') live.backendRunId = 'replacement';
            if (change === 'dependency') live.dependency = { childId: 'other', state: 'recorded' };
            store.save(live, 'test.changed');
          }
          return value;
        };
        await assert.rejects(waitForChild(store, run, 'token', changed, { taskIds: ['a', 'b'] }),
          { code: change === 'dependency' ? 'operation_conflict' : 'work_inactive' });
        assert.equal(calls, after);
        assert.equal(writes.length, after >= 4 ? 1 : 0);
        assert.equal(store.operation(`dependency:${run.id}`)?.state, after >= 4 ? 'uncertain' : undefined);
        assert.equal(store.run(run.id).dependency?.childId, change === 'dependency' ? 'other' : undefined);
      });
    }
  }
});

test('committed wait retries revalidate live work after every backend read', async t => {
  for (const after of [1, 2, 3]) {
    await t.test(`cancel after read ${after}`, async t => {
      const { store, run, children, api, writes } = fixture(t);
      await waitForChild(store, run, 'token', api, { taskIds: ['a', 'b'] });
      children.forEach(child => { child.status = 'done'; });
      let calls = 0;
      const changed = async (...args) => {
        assert.equal(args[2], 'GET');
        const value = await api(...args);
        if (++calls === after) store.save({ ...store.run(run.id), cancellationRequested: true }, 'test.changed');
        return value;
      };
      await assert.rejects(waitForChild(store, run, 'token', changed, { taskIds: ['a', 'b'] }), { code: 'work_inactive' });
      assert.equal(calls, after);
      assert.equal(writes.length, 1);
    });
  }
});

test('legacy childId operations and single-child store records remain compatible', async t => {
  const { store, run, issue, api, writes } = fixture(t);
  store.saveOperation({ id: `dependency:${run.id}`, runId: run.id, childId: 'a', state: 'uncertain' });
  issue.status = 'blocked';
  issue.blockedBy.push({ id: 'a' });
  const result = await waitForChild(store, run, 'token', api, { taskIds: ['a'] });
  assert.deepEqual(result.dependency, { childId: 'a', state: 'recorded' });
  assert.deepEqual(store.waitForDependency(run.id, 'a').dependency, result.dependency);
  assert.equal(writes.length, 0);
  assert.throws(() => store.waitForDependency(run.id, ['a', 'b']), { code: 'operation_conflict' });
});

test('store canonicalises multi-child arrays and rejects invalid sets', t => {
  const { store, run } = fixture(t);
  for (const ids of [[], ['a', 'a'], [''], [' a'], [null], null, Array(65).fill('a')]) {
    assert.throws(() => store.waitForDependency(run.id, ids), { code: 'invalid_request' });
  }
  assert.deepEqual(store.waitForDependency(run.id, ['b', 'a']).dependency, { taskIds: ['a', 'b'], state: 'recorded' });
  assert.deepEqual(store.waitForDependency(run.id, ['a', 'b']).dependency.taskIds, ['a', 'b']);
});

test('CLI sends wait-children file payload to the new route and preserves wait-child', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-wait-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'service.sock');
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const context = join(directory, 'context.json');
  const file = join(directory, 'children.json');
  writeFileSync(context, JSON.stringify({ socketPath, token: 'test' }));
  writeFileSync(file, JSON.stringify({ taskIds: ['b', 'a'] }));
  for (const args of [['wait-children', '--file', file], ['wait-child', '--task', 'a']]) {
    const child = spawn(process.execPath, ['src/cli.mjs', '--context', context, 'work', args[0], 'run', ...args.slice(1)]);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, stderr);
  }
  assert.deepEqual(requests, [
    { path: '/runs/run/wait-children', body: { taskIds: ['b', 'a'] } },
    { path: '/runs/run/wait-child', body: { taskId: 'a' } },
  ]);
});

test('worker prompt requires explicit fan-out authority, exact parentId and ending the waiting turn', t => {
  const { run } = fixture(t);
  const prompt = promptFor(run, '/context.json');
  assert.match(prompt, /explicitly authorises delegation or fan-out/);
  assert.match(prompt, /MUST set parentId to the current task ID "parent"/);
  assert.match(prompt, /work wait-children RUN --file FILE/);
  assert.match(prompt, /Once waiting is recorded, finish this turn without submitting/);
});
