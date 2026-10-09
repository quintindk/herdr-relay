import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { manageRoutine, routineTargetAdmission } from '../src/routines.mjs';
import { harnessRoutine } from '../src/harness-routines.mjs';
import { persistentRoutineScope, resolveRoutineFolder, ensureRoutineRouter } from '../src/persistent-routines.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-persistent-routines-'));
  const path = join(directory, 'state.sqlite');
  const f = { store: new Store(path), companyId: randomUUID(), agents: [], routines: [], runs: [], calls: [] };
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.restart = () => { f.store.close(); f.store = new Store(path); };
  f.config = { companyId: f.companyId, machineId: 'machine', session: 'default', socketPath: '/run/herdr.sock',
    bridgeDirectories: ['/work/project'] };
  f.options = { observationConfig: f.config, routingContextFile: '/private/relay-routing.json' };
  f.scope = () => persistentRoutineScope(f.store, f.config, f.companyId, '/work/project');
  f.input = { action: 'create', companyId: f.companyId, targetDirectory: '/work/project', key: 'cron',
    title: 'Review tasks', description: 'Review outstanding tasks', cron: '0 8 * * 1-5' };
  f.create = (input = {}, options = {}) => manageRoutine(f.store, f.api, { ...f.input, ...input }, { ...f.options, ...options });
  f.manage = (action, scheduleId, input = {}, options = {}) => manageRoutine(f.store, f.api,
    { action, companyId: f.companyId, ...(action === 'list' ? {} : { scheduleId }),
      ...(['list', 'inspect'].includes(action) ? {} : { key: action }), ...input }, { ...f.options, ...options });
  f.posts = suffix => f.calls.filter(call => call.method === 'POST' && call.path.endsWith(suffix));
  f.api = async (method, url, body) => {
    f.calls.push({ method, path: url, body: structuredClone(body) });
    await f.before?.(method, url, body);
    let result;
    if (url === `/api/companies/${f.companyId}/agents`) {
      if (method === 'GET') result = f.agents;
      else {
        assert.equal(method, 'POST');
        const intent = f.store.operation(`routine-router:${digest(body.adapterConfig.relayRoutineScope)}`);
        assert.equal(intent.state, 'uncertain');
        assert.equal(intent.marker, body.adapterConfig.relayRoutineMarker);
        result = { ...body, id: randomUUID(), companyId: f.companyId, status: 'idle' };
        f.agents.push(result);
      }
    } else if (method === 'GET' && url.startsWith('/api/agents/')) {
      result = f.agents.find(agent => url === `/api/agents/${agent.id}`);
    } else if (url === `/api/companies/${f.companyId}/routines`) {
      if (method === 'GET') result = f.routines;
      else {
        assert.equal(method, 'POST');
        assert.equal(body.status, 'paused');
        result = { ...body, id: randomUUID(), companyId: f.companyId, latestRevisionId: randomUUID(), triggers: [] };
        f.routines.push(result);
      }
    } else if (url.startsWith('/api/routine-triggers/')) {
      assert.equal(method, 'PATCH');
      const routine = f.routines.find(item => item.triggers.some(trigger => url.endsWith(trigger.id)));
      result = routine.triggers.find(trigger => url.endsWith(trigger.id));
      Object.assign(result, body);
      routine.latestRevisionId = randomUUID();
    } else {
      const routine = f.routines.find(item => url.startsWith(`/api/routines/${item.id}`));
      assert.ok(routine, `${method} ${url}`);
      if (url === `/api/routines/${routine.id}`) {
        if (method === 'PATCH') {
          assert.equal(body.baseRevisionId, routine.latestRevisionId);
          Object.assign(routine, { status: body.status, latestRevisionId: randomUUID() });
        } else assert.equal(method, 'GET');
        result = routine;
      } else if (url.endsWith('/triggers')) {
        assert.equal(method, 'POST');
        const trigger = { ...body, id: randomUUID(), routineId: routine.id, companyId: f.companyId, archived: false };
        routine.triggers.push(trigger);
        routine.latestRevisionId = randomUUID();
        result = { trigger };
      } else if (url.includes('/runs?')) result = f.runs.filter(run => run.routineId === routine.id);
      else if (url.endsWith('/run')) {
        assert.equal(method, 'POST');
        result = { ...body, id: randomUUID(), routineId: routine.id, companyId: f.companyId, status: 'issue_created' };
        f.runs.push(result);
      } else assert.fail(`${method} ${url}`);
    }
    await f.after?.(method, url, result);
    return structuredClone(result);
  };
  f.chat = (id, folder = '/work/project', availability = 'present') => {
    const observed = f.store.saveOperation({ id: `herdr-agent:${id}`, runId: '', availability, agentId: randomUUID(), marker: `marker-${id}`,
      identity: { companyId: f.companyId, machineId: 'machine', session: 'default', harness: 'opencode', sessionKind: 'id', conversationId: id },
      placement: { directory: folder, terminalId: `terminal-${id}` } });
    const binding = f.store.register({ id, companyId: f.companyId, agentId: observed.agentId, harness: 'opencode', delivery: 'pull',
      lifetime: 'persistent', conversationId: id, instanceId: digest(['machine', 'default']) }).binding;
    const bridge = f.store.saveOperation({ id: `opencode-bridge:${id}`, runId: '', state: 'armed', ready: true, epoch: `epoch-${id}`,
      sessionCreatedAt: 123, lastSeen: new Date().toISOString(), tokenHash: 'PRIVATE-TOKEN',
      identity: { bindingId: id, observedId: observed.id, conversationId: id, ...observed.placement } });
    return { observed, binding, bridge };
  };
  f.native = (chat, action, input) => harnessRoutine(f.store, chat.bridge, `routine-${action}`, {
    ...input, ...(['list', 'inspect'].includes(action) ? {} : {
      source: { id: `${chat.binding.id}-${action}`, text: `Human request to ${action} cron`, role: 'user', createdAt: Date.now() },
    }),
  }, f.api, f.options);
  return f;
}

test('offline directory create, activation and manual run use a durable router without a chat', async t => {
  const f = fixture(t);
  const result = await f.create({ enabled: true });
  assert.equal(result.state, 'active');
  assert.equal(result.target, null);
  assert.equal(result.targetBindingId, undefined);
  assert.equal(result.targetDirectory, '/work/project');
  assert.deepEqual(result.persistentScope, f.scope());
  assert.equal(f.routines[0].assigneeAgentId, result.routerAgentId);
  const record = f.store.operation(result.scheduleId);
  assert.deepEqual(record.router, { agentId: result.routerAgentId, marker: f.agents[0].adapterConfig.relayRoutineMarker, scope: f.scope() });
  assert.equal(record.authority.kind, 'operator');
  const agent = f.agents[0];
  assert.equal(agent.name, 'project cron');
  assert.deepEqual(agent.adapterConfig, { observationOnly: false, relayRoutineScope: f.scope(), relayRoutineMarker: record.router.marker,
    relayContextFile: f.options.routingContextFile, requireReviewDisposition: true });
  assert.deepEqual(agent.runtimeConfig.heartbeat, { enabled: true, wakeOnDemand: true, intervalSec: 0, maxConcurrentRuns: 1 });
  assert.ok(!JSON.stringify(result).includes(record.router.marker));
  assert.ok(!JSON.stringify(result).includes('/private/'));
  const run = await f.manage('run', result.scheduleId);
  assert.equal(run.run.id, f.runs[0].id);
  assert.equal(f.store.runs().length, 0);
});

test('two concurrent routines share one folder router across a Store restart', async t => {
  const f = fixture(t);
  const [first, second] = await Promise.all([f.create(), f.create({ key: 'second' })]);
  assert.equal(first.routerAgentId, second.routerAgentId);
  assert.equal(f.posts('/agents').length, 1);
  assert.equal(f.posts('/routines').length, 2);
  f.restart();
  const third = await f.create({ key: 'third' });
  assert.equal(third.routerAgentId, first.routerAgentId);
  assert.equal(f.posts('/agents').length, 1);
});

for (const delivered of [false, true]) test(`lost router receipt (${delivered ? 'delivered' : 'not delivered'}) never repeats POST`, async t => {
  const f = fixture(t);
  f[delivered ? 'after' : 'before'] = (method, path) => {
    if (method === 'POST' && path.endsWith('/agents')) throw Error('lost router reply');
  };
  await assert.rejects(f.create(), /lost router reply/);
  f.before = f.after = null;
  f.restart();
  await assert.rejects(f.create({ description: 'Changed retry' }), { code: 'operation_conflict' });
  if (delivered) {
    const result = await f.create({});
    assert.equal(result.routerAgentId, f.agents[0].id);
    assert.equal(result.created, true);
  } else {
    await assert.rejects(f.create(), { code: 'operation_uncertain' });
    await assert.rejects(f.create({ key: 'another' }), { code: 'operation_uncertain' });
  }
  assert.equal(f.posts('/agents').length, 1);
});

test('lost native routine reply recovers without another routine or router create', async t => {
  const f = fixture(t);
  f.after = (method, path) => { if (method === 'POST' && path.endsWith('/routines')) throw Error('lost routine'); };
  await assert.rejects(f.create(), /lost routine/);
  f.after = null;
  f.restart();
  assert.equal((await f.create()).state, 'paused');
  assert.equal(f.posts('/routines').length, 1);
  assert.equal(f.posts('/agents').length, 1);
});

for (const change of [
  f => { f.config.bridgeDirectories = []; },
  f => { f.config.companyId = 'foreign'; },
  f => { f.config.machineId = 'new-machine'; },
  f => { f.config.session = 'new-session'; },
  f => { f.config.socketPath = '/run/new.sock'; },
]) test('changed authorisation refuses activation but still permits owner pause and cancel', async t => {
  const f = fixture(t);
  const result = await f.create({ enabled: true });
  change(f);
  await assert.rejects(f.manage('resume', result.scheduleId), { code: 'routine_scope_revoked' });
  await assert.rejects(f.manage('run', result.scheduleId), { code: 'routine_scope_revoked' });
  assert.equal((await f.manage('pause', result.scheduleId)).state, 'paused');
  assert.equal((await f.manage('cancel', result.scheduleId)).state, 'cancelled');
  f.restart();
  assert.equal(f.store.operation(result.scheduleId).cancellationRequested, true);
});

test('foreign company, new folders, aliases and worker directories cannot create a scope', async t => {
  const f = fixture(t);
  for (const input of [{ companyId: 'foreign' }, { targetDirectory: '/work/new' }, { targetDirectory: '/work/./project' },
    { targetDirectory: '/work/project/' }, { targetDirectory: 'work/project' }, { targetDirectory: '/work/*' }]) {
    await assert.rejects(f.create(input), { code: 'routine_scope_revoked' });
  }
  await assert.rejects(f.create({ targetBindingId: 'chat' }), { code: 'invalid_request' });
  f.store.saveOperation({ id: 'herdr-worker:old', runId: '', state: 'blocked', request: { directory: '/work/project' } });
  await assert.rejects(f.create(), { code: 'routine_scope_revoked' });
  assert.equal(f.calls.length, 0);
});

test('recorded standing enrolment grants an offline directory without changing config', async t => {
  const f = fixture(t);
  f.config.bridgeDirectories = [];
  f.store.saveOperation({ id: 'directory-enrolment:grant', runId: '', state: 'recorded',
    scope: { companyId: f.companyId, machineId: 'machine', session: 'default', socketPath: '/run/herdr.sock' },
    request: { reserved: true, directory: '/work/project' } });
  assert.equal((await f.create({ enabled: true })).state, 'active');
});

test('new folder chat can list, inspect and control with human source, unrelated folder cannot see it', async t => {
  const f = fixture(t), origin = f.chat('origin', '/work/origin');
  const { action: _, companyId: __, ...input } = f.input;
  const created = await f.native(origin, 'create', input);
  const owner = f.chat('replacement'), stranger = f.chat('stranger', '/work/other');
  assert.equal((await f.native(owner, 'list', {})).routines[0].scheduleId, created.scheduleId);
  assert.equal((await f.native(owner, 'inspect', { scheduleId: created.scheduleId })).routerAgentId, created.routerAgentId);
  for (const action of ['resume', 'pause', 'cancel']) {
    const result = await f.native(owner, action, { scheduleId: created.scheduleId, key: action });
    assert.equal(result.state, action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'cancelled');
  }
  assert.deepEqual(await f.native(stranger, 'list', {}), { routines: [] });
  await assert.rejects(f.native(stranger, 'inspect', { scheduleId: created.scheduleId }), { code: 'forbidden' });
  await assert.rejects(f.native(stranger, 'pause', { scheduleId: created.scheduleId, key: 'stranger' }), { code: 'forbidden' });
  assert.equal((await f.native(origin, 'inspect', { scheduleId: created.scheduleId })).state, 'cancelled');
  const record = f.store.operation(created.scheduleId);
  assert.equal(record.authority.bindingId, 'origin');
  assert.equal(record.authority.sourceMessageId, 'origin-create');
  assert.ok(!JSON.stringify(await f.native(owner, 'list', {})).includes('PRIVATE-TOKEN'));
});

test('directory create key belongs to the scope but original authority and source remain immutable', async t => {
  const f = fixture(t), first = f.chat('first'), second = f.chat('second');
  const { action: _, companyId: __, ...input } = f.input;
  f.after = (method, path) => { if (method === 'POST' && path.endsWith('/agents')) throw Error('lost'); };
  await assert.rejects(f.native(first, 'create', input), /lost/);
  f.after = null;
  await assert.rejects(f.native(second, 'create', input), { code: 'operation_conflict' });
  const result = await f.native(first, 'create', input);
  assert.equal(f.store.operation(result.scheduleId).authority.bindingId, 'first');
  assert.equal(f.posts('/agents').length, 1);
});

test('native folder controls still reject synthetic human source', async t => {
  const f = fixture(t), created = await f.create(), chat = f.chat('owner');
  await assert.rejects(harnessRoutine(f.store, chat.bridge, 'routine-resume', { scheduleId: created.scheduleId, key: 'bad',
    source: { id: 'synthetic', text: 'Activate', createdAt: Date.now(), synthetic: true } }, f.api, f.options),
  { code: 'invalid_routine_source' });
});

test('omitting native target fields creates a persistent cron owned by the enrolled caller folder', async t => {
  const f = fixture(t), chat = f.chat('owner');
  const { action: _, companyId: __, targetDirectory: ___, ...input } = f.input;
  const created = await f.native(chat, 'create', input);
  assert.equal(created.targetDirectory, '/work/project');
  assert.equal(created.targetBindingId, undefined);
  assert.equal(created.target, null);
});

for (const change of [
  agent => { agent.companyId = 'foreign'; },
  agent => { agent.adapterType = 'other'; },
  agent => { agent.adapterConfig.relayRoutineScope.session = 'foreign'; },
  agent => { agent.adapterConfig.relayRoutineMarker = 'foreign'; },
  agent => { agent.adapterConfig.observationOnly = true; },
  agent => { agent.adapterConfig.bindingId = 'fixed-chat'; },
  agent => { agent.adapterConfig.relayObservationMarker = 'observation'; },
  agent => { agent.adapterConfig.relayContextFile = '/other/context'; },
  agent => { agent.adapterConfig.requireReviewDisposition = false; },
  agent => { agent.runtimeConfig.heartbeat.maxConcurrentRuns = 2; },
  agent => { agent.runtimeConfig.heartbeat.intervalSec = 60; },
]) test('backend router drift blocks activation without rewriting or replacing it', async t => {
  const f = fixture(t), created = await f.create();
  change(f.agents[0]);
  await assert.rejects(f.manage('resume', created.scheduleId));
  assert.equal(f.posts('/agents').length, 1);
  assert.equal(f.routines[0].status, 'paused');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('ambiguous router marker and changed context are never adopted', async t => {
  const f = fixture(t);
  const router = await ensureRoutineRouter(f.store, f.api, f.scope(), f.options.routingContextFile);
  f.agents.push({ ...structuredClone(f.agents[0]), id: randomUUID() });
  await assert.rejects(ensureRoutineRouter(f.store, f.api, f.scope(), f.options.routingContextFile), { code: 'routine_router_mismatch' });
  f.agents.pop();
  await assert.rejects(ensureRoutineRouter(f.store, f.api, f.scope(), '/private/other.json'), { code: 'routine_router_mismatch' });
  assert.equal(f.posts('/agents').length, 1);
  assert.equal(router.agentId, f.agents[0].id);
});

test('resolver refuses offline, unknown, stale, ambiguous and error observations, admits one fresh idle chat', t => {
  const f = fixture(t), scope = f.scope();
  const resolve = () => resolveRoutineFolder(f.store, scope, f.config, routineTargetAdmission);
  assert.deepEqual(resolve(), { ready: false, blocker: 'routine_target_busy', reason: 'offline', target: null });
  const first = f.chat('first');
  assert.equal(resolve().target.bindingId, 'first');
  f.store.saveOperation({ ...first.observed, availability: 'unknown' });
  assert.equal(resolve().reason, 'unavailable');
  f.store.saveOperation({ ...first.observed, error: 'unavailable' });
  assert.equal(resolve().reason, 'unavailable');
  f.store.saveOperation(first.observed);
  const stale = { ...first.observed, updatedAt: new Date(Date.now() - 60000).toISOString() };
  f.store.db.prepare('UPDATE operations SET data = ? WHERE id = ?').run(JSON.stringify(stale), stale.id);
  assert.equal(resolve().reason, 'unavailable');
  f.store.saveOperation(first.observed);
  const second = f.chat('second', '/work/project', 'unknown');
  assert.equal(resolve().reason, 'ambiguous');
  f.store.saveOperation({ ...second.observed, availability: 'offline' });
  assert.equal(resolve().ready, true);
  f.store.saveOperation({ ...first.bridge, ready: false });
  assert.equal(resolve().reason, 'unavailable');
  f.store.saveOperation({ ...first.observed, availability: 'offline' });
  assert.equal(resolve().reason, 'offline');
  f.config.bridgeDirectories = [];
  assert.throws(resolve, { code: 'routine_scope_revoked' });
});

test('all historical folder bridges fence unsettled work even after observations disappear', t => {
  const f = fixture(t), old = f.chat('old'), current = f.chat('current');
  const run = f.store.dispatch({ bindingId: old.binding.id, bindingRevision: old.binding.revision, companyId: f.companyId,
    agentId: old.binding.config.agentId, taskId: 'old-task', runId: 'old-backend-run' });
  f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(old.observed.id);
  const resolve = () => resolveRoutineFolder(f.store, f.scope(), f.config, routineTargetAdmission);
  assert.equal(resolve().ready, false);
  assert.equal(resolve().blocker, 'routine_target_busy');
  f.store.save({ ...run, nativeState: 'settled' }, 'test.settled');
  assert.equal(resolve().target.bindingId, current.binding.id);
  assert.equal(f.store.runs(old.binding.id)[0].request.bindingId, old.binding.id);
});

test('scope revoked during router provision leaves a recoverable receipt and no native routine', async t => {
  const f = fixture(t);
  f.after = (method, path) => { if (method === 'POST' && path.endsWith('/agents')) f.config.bridgeDirectories = []; };
  await assert.rejects(f.create({ enabled: true }), { code: 'routine_scope_revoked' });
  assert.equal(f.posts('/routines').length, 0);
  f.after = null;
  f.config.bridgeDirectories = ['/work/project'];
  assert.equal((await f.create({ enabled: true })).state, 'active');
  assert.equal(f.posts('/agents').length, 1);
});
