import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.mjs';
import { digest } from '../src/protocol.mjs';
import { manageRoutine, routineRecords, routineTargetAdmission } from '../src/routines.mjs';
import { harnessRoutine } from '../src/harness-routines.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-routines-'));
  const path = join(directory, 'state.sqlite');
  const f = { store: new Store(path), companyId: randomUUID(), agentId: randomUUID(), routines: [], runs: [], calls: [] };
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.restart = () => { f.store.close(); f.store = new Store(path); };
  const identity = { companyId: f.companyId, harness: 'opencode', sessionKind: 'id', machineId: 'machine', session: 'default', conversationId: 'chat' };
  f.observed = f.store.saveOperation({ id: 'herdr-agent:worker', runId: '', identity, availability: 'present',
    agentId: f.agentId, marker: 'observation-marker', placement: { directory: '/work/project', terminalId: 'terminal' } });
  f.binding = f.store.register({ id: 'worker', companyId: f.companyId, agentId: f.agentId, harness: 'opencode',
    delivery: 'pull', instanceId: digest(['machine', 'default']), conversationId: 'chat', lifetime: 'persistent' }).binding;
  f.bridge = f.store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed', ready: true,
    epoch: 'epoch', sessionCreatedAt: 123, lastSeen: new Date().toISOString(), tokenHash: 'PRIVATE-TOKEN',
    identity: { bindingId: 'worker', observedId: f.observed.id, conversationId: 'chat', ...f.observed.placement } });
  f.agent = { id: f.agentId, companyId: f.companyId, status: 'idle', adapterType: 'herdr_relay',
    adapterConfig: { bindingId: 'worker', bindingRevision: 1, observationOnly: false, relayObservationMarker: f.observed.marker,
      requireReviewDisposition: true, token: 'PRIVATE-TOKEN' },
    runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } } };
  f.api = async (method, url, body) => {
    f.calls.push({ method, path: url, body: structuredClone(body) });
    if (f.before) await f.before(method, url, body);
    let result;
    if (method === 'GET' && url === `/api/agents/${f.agentId}`) result = f.agent;
    else if (method === 'GET' && /^\/api\/(projects|issues)\//.test(url)) result = { id: url.split('/').at(-1), companyId: f.resourceCompany ?? f.companyId };
    else if (url === `/api/companies/${f.companyId}/routines`) {
      if (method === 'GET') result = f.routines;
      else {
        assert.equal(method, 'POST');
        assert.equal(body.status, 'paused');
        assert.equal(body.concurrencyPolicy, 'skip_if_active');
        assert.equal(body.catchUpPolicy, 'skip_missed');
        assert.equal(body.idempotencyKey, undefined);
        assert.equal(body.relayReviewPolicy, undefined);
        assert.ok(f.store.db.prepare("SELECT id FROM operations WHERE id LIKE 'routine:%'").get());
        result = { ...body, id: randomUUID(), companyId: f.companyId, latestRevisionId: randomUUID(), triggers: [], token: 'PRIVATE-TOKEN' };
        f.routines.push(result);
      }
    } else {
      const routine = f.routines.find(value => url.startsWith(`/api/routines/${value.id}`));
      if (routine && url === `/api/routines/${routine.id}`) {
        if (method === 'PATCH') {
          assert.ok(Object.keys(body).every(key => ['baseRevisionId', 'status', 'title', 'description'].includes(key)));
          assert.equal(body.baseRevisionId, routine.latestRevisionId);
          const { baseRevisionId: _, ...changes } = body;
          Object.assign(routine, changes, { latestRevisionId: randomUUID() });
        } else assert.equal(method, 'GET');
        result = routine;
      } else if (routine && url === `/api/routines/${routine.id}/triggers`) {
        assert.equal(method, 'POST');
        assert.deepEqual(Object.keys(body).sort(), ['cronExpression', 'enabled', 'kind', 'label', 'timezone']);
        assert.equal(body.enabled, false);
        assert.equal(body.kind, 'schedule');
        assert.ok(body.label.length <= 120);
        const trigger = { ...body, id: randomUUID(), companyId: f.companyId, routineId: routine.id,
          archived: false, nextRunAt: '2027-01-04T06:00:00.000Z', secret: 'PRIVATE-TOKEN' };
        routine.triggers.push(trigger);
        routine.latestRevisionId = randomUUID();
        result = { trigger, revision: { id: routine.latestRevisionId } };
      } else if (method === 'PATCH' && url.startsWith('/api/routine-triggers/')) {
        const owner = f.routines.find(value => value.triggers.some(trigger => url === `/api/routine-triggers/${trigger.id}`));
        assert.ok(owner, url);
        const trigger = owner.triggers.find(value => url === `/api/routine-triggers/${value.id}`);
        assert.deepEqual(Object.keys(body), ['enabled']);
        Object.assign(trigger, body);
        owner.latestRevisionId = randomUUID();
        result = trigger;
      } else if (routine && method === 'GET' && /^\/api\/routines\/[^/]+\/runs\?limit=(50|100)$/.test(url)) {
        result = f.runs.filter(run => run.routineId === routine.id);
      } else if (routine && method === 'POST' && url === `/api/routines/${routine.id}/run`) {
        assert.deepEqual(Object.keys(body).sort(), ['idempotencyKey', 'payload', 'source']);
        assert.ok(body.idempotencyKey.length <= 255);
        assert.equal(body.source, 'manual');
        result = f.runs.find(run => run.idempotencyKey === body.idempotencyKey);
        if (!result) {
          result = { id: randomUUID(), routineId: routine.id, companyId: f.companyId, idempotencyKey: body.idempotencyKey,
            source: 'manual', triggerId: null, triggerPayload: body.payload, status: 'issue_created', linkedIssueId: randomUUID(), token: 'PRIVATE-TOKEN' };
          f.runs.push(result);
        }
      } else assert.fail(`Unexpected route ${method} ${url}`);
    }
    if (f.after) await f.after(method, url, result);
    return structuredClone(result);
  };
  f.input = { action: 'create', companyId: f.companyId, key: 'weekday-review', targetBindingId: 'worker',
    title: 'Review tasks', description: 'Review outstanding tasks {plain braces}.', cron: '0 8 * * 1-5' };
  f.create = (input = {}, options) => manageRoutine(f.store, f.api, { ...f.input, ...input }, options);
  f.manage = (action, input = {}, options) => manageRoutine(f.store, f.api, { action, companyId: f.companyId,
    scheduleId: routineRecords(f.store)[0]?.scheduleId, ...(['inspect', 'list'].includes(action) ? {} : { key: action }), ...input }, options);
  f.writes = () => f.calls.filter(call => call.method !== 'GET');
  f.offline = () => f.store.saveOperation({ ...f.bridge, ready: false });
  return f;
}

test('create provisions paused routine and disabled trigger with a public safe projection', async t => {
  const f = fixture(t);
  const result = await f.create();
  assert.equal(result.state, 'paused');
  assert.equal(result.created, true);
  assert.equal(result.relayReviewPolicy, 'none');
  assert.equal(result.timezone, 'Africa/Johannesburg');
  assert.ok(result.scheduleId.startsWith('routine:'));
  assert.notEqual(result.scheduleId, result.routineId);
  assert.equal(result.pauseStopsRunningWork, false);
  assert.equal(result.description, f.input.description);
  assert.deepEqual(f.writes().map(call => [call.method, call.path]), [
    ['POST', `/api/companies/${f.companyId}/routines`], ['POST', `/api/routines/${result.routineId}/triggers`],
  ]);
  assert.match(f.routines[0].description, /<!-- herdr-relay-routine:[a-f0-9]{64} -->$/);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-TOKEN'));
  assert.ok(!JSON.stringify(result).includes('herdr-relay-routine:'));
  f.offline();
  f.restart();
  assert.deepEqual(await f.create(), result);
  assert.equal(f.writes().length, 2);
});

for (const action of ['pause', 'cancel']) {
  test(`${action} stops owned native scheduling despite description drift`, async t => {
    const f = fixture(t);
    await f.create({ enabled: true });
    f.routines[0].description = 'Edited outside Relay';
    const result = await f.manage(action);
    assert.equal(result.state, action === 'cancel' ? 'cancelled' : 'paused');
    assert.equal(f.routines[0].status, action === 'cancel' ? 'archived' : 'paused');
    if (action === 'pause') await assert.rejects(f.manage('resume'), { code: 'routine_identity_mismatch' });
  });
}

test('explicit enabled creates paused, verifies disabled trigger, then enables with current revision', async t => {
  const f = fixture(t);
  const result = await f.create({ enabled: true, relayReviewPolicy: 'none' });
  assert.equal(result.state, 'active');
  assert.equal(result.relayReviewPolicy, 'none');
  assert.deepEqual(f.writes().map(call => call.method), ['POST', 'POST', 'PATCH', 'PATCH']);
  assert.equal(f.writes()[2].body.enabled, true);
  assert.equal(f.writes()[3].body.status, 'active');
  assert.equal(result.latestRevisionId, f.routines[0].latestRevisionId);
  assert.equal(result.nextRunAt, f.routines[0].triggers[0].nextRunAt);
});

for (const input of [
  { cron: '@daily' }, { cron: '0 0 8 * * *' }, { timezone: 'Not/AZone' }, { title: 'x'.repeat(201) },
  { description: 'Poll {{timestamp}}' }, { title: 'Poll {{date}}' }, { relayReviewPolicy: 'coordinator' },
  { relayReviewPolicy: 'agent_decides' }, { enabled: 'true' }, { assigneeAgentId: 'arbitrary' },
]) test(`invalid create refuses before backend writes: ${JSON.stringify(input)}`, async t => {
  const f = fixture(t);
  await assert.rejects(f.create(input));
  assert.equal(f.calls.length, 0);
});

test('stable creation keys reject changed payload even after completion', async t => {
  const f = fixture(t);
  await f.create();
  for (const input of [{ description: 'changed' }, { enabled: true }, { relayReviewPolicy: 'human' }, { cron: '0 9 * * 1-5' }]) {
    await assert.rejects(f.create(input), { code: 'operation_conflict' });
  }
  assert.equal(f.writes().length, 2);
});

for (const [name, change] of [
  ['offline', f => f.offline()],
  ['generic unreserved actor', f => f.store.db.prepare('DELETE FROM operations WHERE id = ?').run(f.bridge.id)],
  ['future heartbeat', f => f.store.saveOperation({ ...f.bridge, lastSeen: new Date(Date.now() + 60000).toISOString() })],
  ['changed observation', f => f.store.saveOperation({ ...f.observed, identity: { ...f.observed.identity, conversationId: 'replacement' } })],
  ['changed terminal', f => f.store.saveOperation({ ...f.observed, placement: { ...f.observed.placement, terminalId: 'new' } })],
  ['changed company', f => f.store.saveOperation({ ...f.observed, identity: { ...f.observed.identity, companyId: 'other' } })],
  ['retired', f => f.store.retireBinding('worker')],
  ['inactive worker grant', f => f.store.saveOperation({ id: 'herdr-worker:blocked', runId: '', bindingId: 'worker', state: 'blocked' })],
]) test(`target admission refuses ${name}`, async t => {
  const f = fixture(t);
  change(f);
  assert.equal(routineTargetAdmission(f.store, f.store.binding('worker')).ready, false);
  await assert.rejects(f.create());
  assert.equal(f.calls.length, 0);
});

test('service lifetime is eligible but a task-scoped target is not', async t => {
  const f = fixture(t);
  const binding = f.store.binding('worker');
  assert.equal(routineTargetAdmission(f.store, { ...binding, config: { ...binding.config, lifetime: 'service' } }).ready, true);
  assert.equal(routineTargetAdmission(f.store, { ...binding, config: { ...binding.config, lifetime: 'task' } }).ready, false);
});

test('backend adapter identity, readiness and concurrency limits are verified without rewriting them', async t => {
  const f = fixture(t);
  for (const change of [() => { f.agent.runtimeConfig.heartbeat.maxConcurrentRuns = 2; },
    () => { f.agent.runtimeConfig.heartbeat.maxConcurrentRuns = 1; f.agent.adapterConfig.bindingRevision = 2; },
    () => { f.agent.adapterConfig.bindingRevision = 1; f.agent.status = 'running'; }]) {
    change();
    await assert.rejects(f.create(), { code: 'routine_backend_target_unavailable' });
  }
  assert.equal(f.writes().length, 0);
});

test('project and parent scope are checked before persisting or creating', async t => {
  const f = fixture(t), projectId = randomUUID(), parentTaskId = randomUUID();
  f.resourceCompany = 'foreign';
  await assert.rejects(f.create({ projectId }), { code: 'routine_resource_mismatch' });
  await assert.rejects(f.create({ parentTaskId }), { code: 'routine_resource_mismatch' });
  assert.equal(routineRecords(f.store).length, 0);
  f.resourceCompany = f.companyId;
  const result = await f.create({ projectId, parentTaskId });
  assert.equal(f.routines[0].parentIssueId, parentTaskId);
  assert.equal(result.projectId, projectId);
});

for (const phase of ['routine', 'trigger']) test(`lost ${phase} receipt reconciles a unique marker after restart without another POST`, async t => {
  const f = fixture(t);
  f.after = (method, path) => {
    if (method === 'POST' && (phase === 'routine' ? path.endsWith('/routines') : path.endsWith('/triggers'))) throw Error('lost receipt');
  };
  await assert.rejects(f.create(), /lost receipt/);
  f.restart();
  f.after = null;
  const result = await f.create();
  assert.equal(result.state, 'paused');
  assert.equal(f.routines.length, 1);
  assert.equal(f.routines[0].triggers.length, 1);
  assert.equal(f.writes().length, 2);
});

for (const phase of ['routine', 'trigger']) test(`uncertain ${phase} creation without a matching marker never reposts`, async t => {
  const f = fixture(t);
  f.before = (method, path) => {
    if (method === 'POST' && (phase === 'routine' ? path.endsWith('/routines') : path.endsWith('/triggers'))) throw Error('no receipt');
  };
  await assert.rejects(f.create(), /no receipt/);
  f.before = null;
  f.restart();
  await assert.rejects(f.create(), { code: 'operation_uncertain' });
  await assert.rejects(f.create(), { code: 'operation_uncertain' });
  assert.equal(f.writes().filter(call => call.path.endsWith(phase === 'routine' ? '/routines' : '/triggers')).length, 1);
});

test('duplicate marker and changed routine configuration cannot be adopted', async t => {
  const f = fixture(t);
  f.after = (method, path) => { if (method === 'POST' && path.endsWith('/routines')) throw Error('lost'); };
  await assert.rejects(f.create(), /lost/);
  f.after = null;
  f.routines.push({ ...structuredClone(f.routines[0]), id: randomUUID() });
  await assert.rejects(f.create(), { code: 'operation_uncertain' });
  f.routines.pop();
  f.routines[0].assigneeAgentId = randomUUID();
  await assert.rejects(f.create(), { code: 'routine_scope_changed' });
  assert.equal(f.writes().length, 1);
});

test('concurrent identical creates produce one routine and one trigger', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.create(), f.create(), f.create()]);
  assert.ok(results.every(value => value.scheduleId === results[0].scheduleId));
  assert.equal(f.writes().length, 2);
});

test('pause and cancellation work offline, persist terminal state and never cancel existing work', async t => {
  const f = fixture(t);
  await f.create({ enabled: true });
  f.offline();
  assert.equal((await f.manage('pause')).state, 'paused');
  assert.equal(f.routines[0].status, 'paused');
  const result = await f.manage('cancel');
  assert.equal(result.state, 'cancelled');
  assert.equal(f.routines[0].status, 'archived');
  f.restart();
  await assert.rejects(f.manage('resume'), { code: 'routine_cancelled' });
  await assert.rejects(f.manage('run'), { code: 'routine_cancelled' });
  assert.equal((await f.create({ enabled: true })).state, 'cancelled');
  assert.equal((await f.manage('cancel')).state, 'cancelled');
  assert.ok(!f.calls.some(call => /heartbeat|\/issues\//.test(call.path)));
});

test('resume refuses a replaced native session even if it is ready again', async t => {
  const f = fixture(t);
  await f.create();
  f.store.saveOperation({ ...f.bridge, sessionCreatedAt: 456 });
  await assert.rejects(f.manage('resume'), { code: 'routine_target_changed' });
  assert.equal(f.routines[0].status, 'paused');
});

for (const phase of ['trigger', 'status']) test(`lost activation ${phase} receipt is reconciled with no repeated PATCH`, async t => {
  const f = fixture(t);
  f.after = (method, path) => {
    if (method === 'PATCH' && (phase === 'trigger' ? path.startsWith('/api/routine-triggers/') : path.startsWith('/api/routines/'))) throw Error('lost');
  };
  await assert.rejects(f.create({ enabled: true }), /lost/);
  f.after = null;
  f.restart();
  assert.equal((await f.create({ enabled: true })).state, 'active');
  assert.equal(f.writes().filter(call => call.method === 'PATCH').length, 2);
});

test('unconfirmed status update is not blindly repeated', async t => {
  const f = fixture(t);
  await f.create();
  f.before = (method, path) => { if (method === 'PATCH' && path.startsWith('/api/routines/')) throw Error('not received'); };
  await assert.rejects(f.manage('resume'), /not received/);
  f.before = null;
  await assert.rejects(f.manage('resume'), { code: 'operation_uncertain' });
  assert.equal(f.writes().filter(call => call.method === 'PATCH' && call.path.startsWith('/api/routines/')).length, 1);
});

test('newer pause supersedes an incomplete resume and its old key cannot reactivate', async t => {
  const f = fixture(t);
  await f.create();
  f.after = (method, path) => { if (method === 'PATCH' && path.startsWith('/api/routine-triggers/')) throw Error('lost'); };
  await assert.rejects(f.manage('resume'), /lost/);
  f.after = null;
  assert.equal((await f.manage('pause')).state, 'paused');
  f.restart();
  await assert.rejects(f.manage('resume'), { code: 'routine_operation_superseded' });
  assert.equal(f.routines[0].status, 'paused');
});

test('lost cancellation receipt persists refusal and reconciles while target is offline', async t => {
  const f = fixture(t);
  await f.create({ enabled: true });
  f.after = (method, path) => { if (method === 'PATCH' && path.startsWith('/api/routines/')) throw Error('lost'); };
  await assert.rejects(f.manage('cancel'), /lost/);
  f.after = null;
  f.offline();
  f.restart();
  await assert.rejects(f.manage('resume'), { code: 'routine_cancelled' });
  assert.equal((await f.manage('cancel')).state, 'cancelled');
  assert.equal(f.writes().filter(call => call.body?.status === 'archived').length, 1);
});

test('external archival is persisted and cannot be resumed', async t => {
  const f = fixture(t);
  await f.create();
  f.routines[0].status = 'archived';
  await assert.rejects(f.manage('resume'), { code: 'routine_cancelled' });
  assert.equal(routineRecords(f.store)[0].state, 'cancelled');
});

test('fresh target and source are checked again before activation', async t => {
  const f = fixture(t);
  let valid = true;
  f.after = (method, path) => { if (method === 'PATCH' && path.startsWith('/api/routine-triggers/')) valid = false; };
  await assert.rejects(f.create({ enabled: true }, { check: () => valid }), { code: 'routine_authority_changed' });
  assert.equal(f.routines[0].status, 'paused');
  assert.ok(!f.writes().some(call => call.body?.status === 'active'));
});

test('manual run is stable, payload compared locally and lost response recovered offline', async t => {
  const f = fixture(t);
  await f.create();
  f.after = (method, path) => { if (method === 'POST' && path.endsWith('/run')) throw Error('lost run'); };
  await assert.rejects(f.manage('run', { payload: { message: 'check' } }), /lost run/);
  f.after = null;
  f.offline();
  f.restart();
  const result = await f.manage('run', { payload: { message: 'check' } });
  assert.equal(result.run.id, f.runs[0].id);
  assert.equal(result.state, 'paused');
  assert.equal(f.calls.filter(call => call.path.endsWith('/run')).length, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-TOKEN'));
  await assert.rejects(f.manage('run', { payload: { message: 'different' } }), { code: 'operation_conflict' });
});

test('manual retry without receipt reuses exact backend idempotency body', async t => {
  const f = fixture(t);
  await f.create();
  f.before = (method, path) => { if (method === 'POST' && path.endsWith('/run')) throw Error('no run receipt'); };
  await assert.rejects(f.manage('run'), /no run receipt/);
  f.before = null;
  const result = await f.manage('run');
  const calls = f.calls.filter(call => call.path.endsWith('/run'));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(result.run.id, f.runs[0].id);
});

test('manual run checks target at send boundary but accepts a receipt that makes the target busy', async t => {
  const f = fixture(t);
  await f.create();
  await assert.rejects(f.manage('run', {}, { check: () => {
    const mutations = f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'routine-mutation:%'").all().map(row => JSON.parse(row.data));
    if (mutations.some(item => item.body)) f.offline();
  } }), { code: 'routine_bridge_unavailable' });
  assert.equal(f.calls.filter(call => call.path.endsWith('/run')).length, 0);
  f.store.saveOperation(f.bridge);
  f.after = (method, path) => { if (method === 'POST' && path.endsWith('/run')) f.offline(); };
  const result = await f.manage('run');
  assert.equal(result.run.id, f.runs[0].id);
});

test('mutation keys cannot be reused for another action', async t => {
  const f = fixture(t);
  await f.create();
  await f.manage('pause', { key: 'same' });
  await assert.rejects(f.manage('resume', { key: 'same' }), { code: 'operation_conflict' });
});

test('editing a job preserves its timer identity and archives the old definition without a new create', async t => {
  const f = fixture(t), created = await f.create({ enabled: true, relayReviewPolicy: 'human' });
  const before = structuredClone(f.store.operation(created.scheduleId));
  const edited = await f.manage('edit', { payload: { description: 'Execute in scope and report in chat', relayReviewPolicy: 'none' } });
  assert.equal(edited.scheduleId, created.scheduleId); assert.equal(edited.routineId, created.routineId);
  assert.equal(edited.state, 'active'); assert.equal(edited.relayReviewPolicy, 'none');
  assert.equal(edited.description, 'Execute in scope and report in chat');
  assert.deepEqual(f.store.operation(created.scheduleId).versions[0].body, before.body);
  assert.equal(f.routines.length, 1); assert.equal(f.routines[0].triggers.length, 1);
  const patches = f.writes().filter(call => call.method === 'PATCH').length;
  await f.manage('edit', { payload: { description: 'Execute in scope and report in chat', relayReviewPolicy: 'none' } });
  assert.equal(f.writes().filter(call => call.method === 'PATCH').length, patches);
});

test('lost job definition edits reconcile without another PATCH or duplicate timer', async t => {
  const f = fixture(t), created = await f.create();
  f.after = (method, path) => { if (method === 'PATCH' && path.startsWith('/api/routines/')) throw Error('lost edit'); };
  const input = { payload: { description: 'Updated job instruction' } };
  await assert.rejects(f.manage('edit', input), /lost edit/);
  f.after = null; f.restart();
  assert.equal((await f.manage('edit', input)).description, 'Updated job instruction');
  assert.equal(f.writes().filter(call => call.method === 'PATCH').length, 1);
  assert.equal(f.store.operation(created.scheduleId).versions.length, 1);
});

test('list and inspect expose only managed records, safe history and same-company scope', async t => {
  const f = fixture(t);
  const result = await f.create();
  await f.manage('run');
  const list = await manageRoutine(f.store, f.api, { action: 'list', companyId: f.companyId });
  assert.equal(list.routines[0].scheduleId, result.scheduleId);
  const detail = await f.manage('inspect');
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.backendStatus, 'paused');
  assert.ok(!JSON.stringify(detail).includes('PRIVATE-TOKEN'));
  await assert.rejects(f.manage('inspect', { companyId: 'foreign' }), { code: 'forbidden' });
  assert.deepEqual(await manageRoutine(f.store, f.api, { action: 'list', companyId: 'foreign' }), { routines: [] });
  await assert.rejects(f.manage('resume', { scheduleId: result.routineId }), { code: 'routine_not_found' });
});

test('native origin scope is immutable and arbitrary actor authority is refused', async t => {
  const f = fixture(t);
  await assert.rejects(f.create({}, { authority: { kind: 'agent' } }), { code: 'forbidden' });
  const authority = { kind: 'native', bindingId: 'worker', conversationId: 'chat', sessionCreatedAt: 123, sourceMessageId: 'msg', sourceDigest: 'digest' };
  const created = await f.create({}, { authority });
  await assert.rejects(f.create({}, { authority: { ...authority, sourceDigest: 'different' } }), { code: 'operation_conflict' });
  await assert.rejects(manageRoutine(f.store, f.api, { action: 'inspect', companyId: f.companyId, scheduleId: created.scheduleId },
    { authority: { ...authority, conversationId: 'other' } }), { code: 'forbidden' });
});

for (const explicit of [false, true]) test(`human turn can create and activate its own cron (${explicit ? 'explicit' : 'default'} target)`, async t => {
  const f = fixture(t);
  const bridge = f.store.saveOperation({ ...f.bridge, state: 'configured', ready: false });
  const { action: _, companyId: __, targetBindingId: ___, ...args } = f.input;
  const result = await harnessRoutine(f.store, bridge, 'routine-create', { ...args,
    ...(explicit ? { targetBindingId: 'worker' } : {}), enabled: true,
    source: { id: 'human-create', text: 'Create and activate my cron', role: 'user', createdAt: Date.now() } }, f.api);
  assert.equal(result.state, 'active');
  assert.equal(result.targetBindingId, 'worker');
  assert.equal(result.origin.bindingId, 'worker');
  assert.equal(f.store.operation(bridge.id).state, 'configured');
  assert.equal(f.store.operation(bridge.id).ready, false);
  assert.equal(f.store.runs().length, 0);
  const task = { originKind: 'routine_execution', originId: result.routineId,
    originRunId: 'occurrence', companyId: f.companyId, assigneeAgentId: f.agentId };
  assert.equal(routineTargetAdmission(f.store, f.binding, task).ready, false);
  // The setup exception must never weaken occurrence admission, even if explicitly passed.
  assert.equal(routineTargetAdmission(f.store, f.binding, task, { allowBusyBridge: true }).ready, false);
  f.store.saveOperation({ ...bridge, state: 'armed', ready: true });
  assert.equal(routineTargetAdmission(f.store, f.binding, task).ready, true);
});

test('human turn can resume its own paused cron while busy but cannot run it immediately', async t => {
  const f = fixture(t);
  const bridge = f.store.saveOperation({ ...f.bridge, ready: false });
  const { action: _, companyId: __, ...args } = f.input;
  const created = await harnessRoutine(f.store, bridge, 'routine-create', { ...args,
    source: { id: 'human-create', text: 'Create my cron paused', createdAt: Date.now() } }, f.api);
  assert.equal(created.state, 'paused');
  const result = await harnessRoutine(f.store, bridge, 'routine-resume', { scheduleId: created.scheduleId, key: 'resume',
    source: { id: 'human-resume', text: 'Activate it', createdAt: Date.now() } }, f.api);
  assert.equal(result.state, 'active');
  await assert.rejects(harnessRoutine(f.store, bridge, 'routine-run', { scheduleId: created.scheduleId, key: 'run',
    source: { id: 'human-run', text: 'Run it', createdAt: Date.now() } }, f.api), { code: 'routine_bridge_unavailable' });
  assert.equal(f.calls.filter(call => call.path.endsWith('/run')).length, 0);
});

for (const mode of ['synthetic', 'notification', 'invocation', 'active-run', 'stale', 'epoch', 'backend', 'other-target']) {
  test(`self-setup preserves authority and identity guards: ${mode}`, async t => {
    const f = fixture(t);
    const source = { id: 'human', text: 'Create my cron', createdAt: Date.now() };
    if (['active-run', 'invocation'].includes(mode)) {
      const run = f.store.dispatch({ bindingId: 'worker', bindingRevision: 1, companyId: f.companyId,
        agentId: f.agentId, taskId: 'task', runId: 'backend' });
      if (mode === 'invocation') f.store.save({ ...run, nativeState: 'settled', invocation: { messageId: source.id } }, 'test.settled');
    }
    const bridge = { ...f.bridge, ready: false };
    if (mode === 'synthetic') source.synthetic = true;
    if (mode === 'notification') f.store.saveOperation({ id: 'completion-notification:test', runId: '',
      origin: { bindingId: 'worker', conversationId: 'chat', sessionCreatedAt: 123 }, messageId: source.id });
    if (mode === 'stale') bridge.lastSeen = new Date(Date.now() - 60000).toISOString();
    f.store.saveOperation(bridge);
    if (mode === 'epoch') f.store.saveOperation({ ...bridge, epoch: 'replacement' });
    if (mode === 'backend') f.agent.status = 'running';
    const { action: _, companyId: __, ...args } = f.input;
    const authority = mode === 'other-target' ? { kind: 'native', bindingId: 'origin', conversationId: 'origin',
      sessionCreatedAt: 123, sourceMessageId: source.id, sourceDigest: digest(source.text) } : null;
    if (authority) await assert.rejects(f.create({}, { authority }), { code: 'routine_bridge_unavailable' });
    else await assert.rejects(harnessRoutine(f.store, bridge, 'routine-create', { ...args, source }, f.api), {
      code: mode === 'active-run' ? 'conversation_busy' : mode === 'stale' ? 'routine_bridge_unavailable'
        : mode === 'epoch' ? 'bridge_identity_mismatch' : mode === 'backend' ? 'routine_backend_target_unavailable' : 'invalid_routine_source',
    });
    assert.equal(f.writes().length, 0);
  });
}

test('execution admission requires exact native routine lineage and remains valid when paused', async t => {
  const f = fixture(t);
  const record = await f.create();
  const task = { originKind: 'routine_execution', originId: record.routineId, originRunId: randomUUID(), companyId: f.companyId, assigneeAgentId: f.agentId };
  assert.equal(routineTargetAdmission(f.store, f.store.binding('worker'), task).ready, true);
  assert.equal(routineTargetAdmission(f.store, f.store.binding('worker'), { ...task, originId: randomUUID() }).ready, false);
  assert.equal(routineTargetAdmission(f.store, f.store.binding('worker'), { ...task, originRunId: null }).ready, false);
  await f.manage('cancel');
  assert.equal(routineTargetAdmission(f.store, f.store.binding('worker'), task).ready, false);
});

test('all fake-backend write bodies satisfy the installed native Paperclip validators', async t => {
  const path = join(homedir(), '.paperclip/cli/installs/npm/2026.1001.0/node_modules/@paperclipai/shared/dist/validators/routine.js');
  if (!existsSync(path)) { t.skip('Pinned native Paperclip source is not installed'); return; }
  const schemas = await import(pathToFileURL(path).href);
  const f = fixture(t);
  await f.create({ enabled: true, projectId: randomUUID(), parentTaskId: randomUUID() });
  await f.manage('run', { payload: { message: 'verify' } });
  await f.manage('pause');
  await f.manage('resume');
  await f.manage('cancel');
  for (const { method, path, body } of f.writes()) {
    const schema = path.endsWith('/routines') ? schemas.createRoutineSchema
      : path.endsWith('/triggers') ? schemas.createRoutineTriggerSchema
      : path.startsWith('/api/routine-triggers/') ? schemas.updateRoutineTriggerSchema
      : path.endsWith('/run') ? schemas.runRoutineSchema : schemas.updateRoutineSchema;
    assert.equal(schema.safeParse(body).success, true, `${method} ${path}: ${JSON.stringify(schema.safeParse(body).error)}`);
  }
});
