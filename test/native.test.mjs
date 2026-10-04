import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { call } from '../src/client.mjs';
import { observe } from '../src/opencode.mjs';

const request = { bindingId: 'native', bindingRevision: 1, companyId: 'company', agentId: 'agent', runId: 'backend', taskId: 'task' };
const result = { key: 'one', summary: 'Native result', candidate: 'sha256:fixture' };
const code = expected => error => error.code === expected;

async function waitFor(fn) {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Native condition not reached');
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-native-'));
  const session = { id: 'ses_fixture', directory, projectID: 'project', time: { created: 1 } };
  const state = { messages: [], busy: false, posts: 0, lost: false, absent: false, aborts: 0, comments: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    assert.equal(url.searchParams.get('directory'), directory);
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/session/ses_fixture') res.end(JSON.stringify(session));
    else if (req.method === 'GET' && url.pathname === '/session/status') res.end(JSON.stringify(state.busy ? { ses_fixture: { type: 'busy' } } : {}));
    else if (req.method === 'GET' && url.pathname === '/session/ses_fixture/message') res.end(JSON.stringify(state.messages));
    else if (url.pathname.endsWith('/abort')) { state.aborts++; res.end('true'); }
    else if (req.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
      state.posts++;
      const input = JSON.parse(body);
      if (!state.absent) {
        state.messages.push({ info: { id: input.messageID, role: 'user', sessionID: session.id, time: { created: 2 } }, parts: input.parts });
        state.busy = true;
      }
      if (state.lost) req.socket.destroy();
      else { res.statusCode = 204; res.end(); }
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const binding = {
    id: 'native', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'native-instance',
    conversationId: session.id, delivery: 'opencode',
    opencode: { url: `http://127.0.0.1:${server.address().port}`, directory, projectID: 'project', sessionCreatedAt: 1, exclusive: true },
  };
  let service;
  const start = async () => {
    service = await startService({ directory: join(directory, 'relay'), paperclipUrl: 'http://paperclip.test',
      api: async (run, token, method, path, body) => {
        assert.equal(token, 'backend-secret');
        if (!path.endsWith('/comments')) return { companyId: 'company', title: 'Recovered task' };
        if (method === 'GET') return state.comments;
        const comment = { id: 'receipt', ...body, authorAgentId: run.request.agentId, createdByRunId: run.request.runId };
        state.comments.push(comment);
        return comment;
      } });
    return service;
  };
  await start();
  t.after(async () => {
    await service.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const admin = () => ({ socketPath: service.socketPath, token: service.token });
  const register = () => call(admin(), 'POST', '/bindings', binding);
  const dispatch = async () => {
    const run = await call(admin(), 'POST', '/runs', request);
    await call(admin(), 'POST', `/runs/${run.id}/attach`, { token: 'backend-secret' });
    return run.id;
  };
  const finish = (id, info = {}, parts = []) => {
    state.messages.push({ info: {
      id: `msg_reply_${state.messages.length}`, parentID: service.store.run(id).invocation.messageId,
      role: 'assistant', sessionID: session.id, time: { created: 3, completed: 4 }, finish: 'stop', ...info,
    }, parts });
    state.busy = false;
  };
  return { directory, state, session, binding, admin, register, dispatch, finish,
    get service() { return service; }, restart: async () => { await service.close(); await start(); } };
}

test('native delivery preserves exact message identity, private context, and submission/settlement separation', async t => {
  const f = await fixture(t);
  await f.register();
  const id = await f.dispatch();
  await waitFor(() => f.state.posts === 1);
  const run = f.service.store.run(id);
  const contextDir = join(f.directory, 'relay/workers');
  const contextPath = join(contextDir, readdirSync(contextDir)[0]);
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  assert.equal(statSync(contextPath).mode & 0o777, 0o600);
  assert.ok(!run.invocation.prompt.includes(context.token));
  assert.ok(!run.invocation.prompt.includes('backend-secret'));
  assert.equal(context.bindingId, 'native');
  await call(context, 'POST', `/runs/${id}/acknowledge`, {});
  await call(context, 'POST', `/runs/${id}/submit`, result);
  assert.equal(f.service.store.run(id).nativeState, 'claimed');
  await assert.rejects(call(f.admin(), 'POST', `/runs/${id}/settle`, { outcome: 'completed', evidence: 'guess' }), code('native_observation_required'));
  await assert.rejects(call(context, 'POST', `/runs/${id}/settle`, {}), code('forbidden'));
  f.finish(id);
  await waitFor(() => f.service.store.run(id).nativeState === 'settled');
  assert.equal(f.service.store.run(id).settlement.outcome, 'completed');
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.aborts, 0);
});

test('lost native delivery response and Relay restart reconcile without another prompt', async t => {
  const f = await fixture(t);
  f.state.lost = true;
  await f.register();
  const id = await f.dispatch();
  await waitFor(() => f.state.posts === 1);
  const messageId = f.service.store.run(id).invocation.messageId;
  await f.restart();
  f.service.store.acknowledge(id);
  f.service.store.submit(id, result);
  f.finish(id);
  await waitFor(() => f.service.store.run(id).nativeState === 'settled');
  assert.equal(f.service.store.run(id).invocation.messageId, messageId);
  assert.equal(f.state.posts, 1);
});

test('unobserved delivery stays reserved after cancellation and restart', async t => {
  const f = await fixture(t);
  f.state.lost = true;
  f.state.absent = true;
  await f.register();
  const id = await f.dispatch();
  await waitFor(() => f.state.posts === 1);
  f.service.store.cancel(id);
  await f.restart();
  await waitFor(() => f.service.store.run(id).native?.reason === 'message_not_observed');
  assert.notEqual(f.service.store.run(id).nativeState, 'settled');
  assert.throws(() => f.service.store.dispatch({ ...request, runId: 'next' }), code('conversation_busy'));
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.aborts, 0);
});

test('busy and replaced native conversations block delivery', async t => {
  const f = await fixture(t);
  await f.register();
  f.state.busy = true;
  const id = await f.dispatch();
  await waitFor(() => f.service.store.run(id).native?.reason === 'native_busy');
  assert.equal(f.state.posts, 0);
  f.session.time.created = 2;
  f.state.busy = false;
  await waitFor(() => f.service.store.run(id).native?.reason === 'native_identity_mismatch');
  assert.equal(f.state.posts, 0);
  await assert.rejects(f.register(), code('native_identity_mismatch'));
});

test('foreign input conflict is sticky, even after deletion and a matching final response', async t => {
  const f = await fixture(t);
  await f.register();
  const id = await f.dispatch();
  await waitFor(() => f.state.posts === 1);
  f.service.store.acknowledge(id);
  f.service.store.submit(id, result);
  f.state.messages.push({ info: { id: 'msg_human', sessionID: f.session.id, role: 'user', time: { created: 3 } }, parts: [] });
  await waitFor(() => f.service.store.run(id).native?.state === 'conflict');
  f.state.messages.pop();
  f.finish(id);
  await f.restart();
  await delay(350);
  assert.equal(f.service.store.run(id).nativeState, 'claimed');
  assert.equal(f.service.store.run(id).native.reason, 'concurrent_native_input');
});

test('native cancellation waits for its terminal response and never calls session-wide abort', async t => {
  const f = await fixture(t);
  await f.register();
  const id = await f.dispatch();
  await waitFor(() => f.state.posts === 1);
  f.service.store.cancel(id);
  assert.notEqual(f.service.store.run(id).nativeState, 'settled');
  f.finish(id, { error: { name: 'MessageAbortedError' } });
  await waitFor(() => f.service.store.run(id).nativeState === 'settled');
  assert.equal(f.service.store.run(id).settlement.outcome, 'cancelled');
  assert.equal(f.state.aborts, 0);
});

test('a terminal response without submission stays unresolved', async t => {
  const f = await fixture(t);
  await f.register();
  const id = await f.dispatch();
  await waitFor(() => f.state.posts === 1);
  f.finish(id);
  await waitFor(() => f.service.store.run(id).native?.state === 'finished');
  assert.notEqual(f.service.store.run(id).nativeState, 'settled');
  assert.throws(() => f.service.store.dispatch({ ...request, runId: 'next' }), code('conversation_busy'));
});

test('idle status, wrong parents, unfinished tools and intermediate tool responses cannot settle work', () => {
  const invocation = { messageId: 'msg_work', prompt: 'work', priorUserIds: [] };
  const user = { info: { id: 'msg_work', role: 'user' }, parts: [{ type: 'text', text: 'work' }] };
  const response = { info: { id: 'msg_reply', role: 'assistant', parentID: 'msg_work', finish: 'stop', time: { created: 1, completed: 2 } }, parts: [] };
  const snapshot = { idle: true, messages: [user] };
  assert.equal(observe(snapshot, invocation).state, 'observed');
  snapshot.messages.push({ ...response, info: { ...response.info, parentID: 'msg_other' } });
  assert.equal(observe(snapshot, invocation).state, 'observed');
  snapshot.messages[1] = { ...response, parts: [{ type: 'tool', state: { status: 'running' } }] };
  assert.equal(observe(snapshot, invocation).state, 'observed');
  snapshot.messages[1].parts[0].state.status = 'completed';
  assert.equal(observe(snapshot, invocation).state, 'observed');
  snapshot.messages[1] = response;
  assert.equal(observe({ ...snapshot, idle: false }, invocation).state, 'observed');
  assert.equal(observe(snapshot, invocation).state, 'finished');
});

test('schema upgrade preserves pull state and rejects future schemas without rewriting them', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite');
  let store = new Store(path);
  const binding = { id: 'native', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'conversation' };
  const token = store.register(binding).token;
  const run = store.dispatch(request);
  store.db.exec('PRAGMA user_version = 1');
  store.close();
  store = new Store(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(store.authenticate(token), 'native');
  assert.deepEqual(store.run(run.id), run);
  store.db.exec('PRAGMA user_version = 99');
  store.close();
  assert.throws(() => new Store(path), code('unsupported_schema'));
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  db.close();
});

test('native conversation aliases and unreserved registrations are rejected', async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.store.register({ ...f.binding, opencode: { ...f.binding.opencode, exclusive: false } }), code('native_reservation_required'));
  await f.register();
  assert.throws(() => f.service.store.register({ ...f.binding, id: 'alias', agentId: 'other', instanceId: 'another-label' }), code('identity_conflict'));
});

test('adapter process restart and Relay restart reuse native invocation and publish one result', async t => {
  const f = await fixture(t);
  await f.register();
  const operator = join(f.directory, 'operator.json');
  writeFileSync(operator, JSON.stringify(f.admin()), { mode: 0o600 });
  const context = {
    agent: { companyId: 'company', id: 'agent' }, runId: 'backend', authToken: 'backend-secret',
    config: { relayContextFile: operator, bindingId: 'native' }, context: { taskId: 'task' },
  };
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  const launch = () => {
    const source = `import { execute } from ${JSON.stringify(new URL('../src/adapter.mjs', import.meta.url).href)};
      const result = await execute({ ...${JSON.stringify(context)}, onLog: async () => {} });
      console.log(JSON.stringify(result));`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    return { child, output: () => output, errors: () => errors };
  };
  const first = launch();
  await waitFor(() => f.state.posts === 1);
  const run = f.service.store.runs()[0];
  const exit = once(first.child, 'exit');
  first.child.kill('SIGKILL');
  await exit;
  await f.restart();
  const second = launch();
  const completed = once(second.child, 'exit');
  const contextDir = join(f.directory, 'relay/workers');
  const worker = JSON.parse(readFileSync(join(contextDir, readdirSync(contextDir)[0]), 'utf8'));
  await waitFor(async () => {
    try { return (await call(worker, 'GET', `/runs/${run.id}/task`)).title === 'Recovered task'; }
    catch (error) { if (['adapter_unavailable', 'EPIPE', 'ECONNRESET'].includes(error.code)) return false; throw error; }
  });
  await call(worker, 'POST', `/runs/${run.id}/acknowledge`, {});
  await call(worker, 'POST', `/runs/${run.id}/submit`, result);
  f.finish(run.id);
  await waitFor(() => second.child.exitCode !== null);
  const [status] = await completed;
  assert.equal(status, 0, second.errors());
  assert.equal(JSON.parse(second.output()).exitCode, 0);
  assert.equal(f.service.store.runs().length, 1);
  assert.equal(f.service.store.run(run.id).invocation.messageId, run.invocation.messageId);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.comments.length, 1);
  assert.equal(f.state.comments[0].createdByRunId, 'backend');
});
