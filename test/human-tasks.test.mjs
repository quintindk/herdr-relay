import assert from 'node:assert/strict';
import { test } from 'node:test';
import './git-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { humanTask } from '../src/human-tasks.mjs';
import { createOperatorTask } from '../src/operations.mjs';
import { digest } from '../src/protocol.mjs';
import { attachTaskReference, lookupTaskReference, reserveTaskReference, finishTaskReference } from '../src/task-references.mjs';

function fixture(t, file = ':memory:') {
  const store = new Store(file);
  t.after(() => store.close());
  const task = { id: 'task', companyId: 'company', identifier: 'TEST-1', title: 'Human work', description: 'Full description\n'.repeat(200),
    parentId: null, projectId: null, assigneeUserId: 'human', assigneeAgentId: null, status: 'todo', priority: 'medium', updatedAt: '2026-10-08T00:00:00Z' };
  const state = { task, company: { id: 'company', defaultResponsibleUserId: 'default-human' }, interactions: [], children: [],
    resources: new Map(), creations: new Map(), calls: [], comments: [], hook: null, patch: null, post: null };
  const comment = body => {
    const value = { id: `comment-${state.comments.length}`, companyId: 'company', issueId: 'task', body: body.body,
      clientRequestId: body.clientRequestId, authorType: 'user', authorUserId: 'connector-human', authorAgentId: null };
    state.comments.push(value);
    return value;
  };
  const api = async (method, path, body) => {
    state.calls.push({ method, path, ...(body ? { body: structuredClone(body) } : {}) });
    await state.hook?.(method, path, body);
    let value;
    if (method === 'PATCH') {
      assert.equal(path, '/api/issues/task');
      if (state.patch) return state.patch(body);
      if (body.comment) comment({ body: body.comment, clientRequestId: body.commentClientRequestId });
      Object.assign(state.task, body, { updatedAt: '2026-10-08T00:01:00Z' });
      value = state.task;
    } else if (method === 'POST') {
      if (path === '/api/issues/task/comments') {
        value = comment(body);
        await state.post?.(value, body);
        return structuredClone(value);
      }
      assert.equal(path, '/api/companies/company/issues');
      if (!state.creations.has(body.idempotencyKey)) state.creations.set(body.idempotencyKey,
        { ...structuredClone(task), ...body, id: `created-${state.creations.size}` });
      value = state.creations.get(body.idempotencyKey);
      await state.post?.(value, body);
    } else {
      assert.equal(method, 'GET');
      if (path === '/api/companies/company') value = state.company;
      else if (path.startsWith('/api/issues/task/comments?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        assert.equal(query.get('order'), 'asc');
        assert.equal(query.has('limit'), false);
        assert.equal(query.has('after'), false);
        value = state.comments;
      }
      else if (path.endsWith('/interactions')) value = state.interactions;
      else if (path.startsWith('/api/companies/company/issues?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        assert.equal(query.get('parentId'), 'task');
        assert.equal(query.get('limit'), '1');
        assert.equal(query.get('status'), 'backlog,todo,in_progress,blocked,in_review');
        value = state.children;
      } else if (path === '/api/issues/task') value = state.task;
      else value = state.resources.get(path) ?? [...state.creations.values()].find(item => path === `/api/issues/${item.id}`);
      assert.ok(value !== undefined, `Unexpected API path: ${path}`);
    }
    return structuredClone(value);
  };
  const inspect = () => humanTask(store, api, { action: 'inspect', companyId: 'company', taskId: 'task' });
  const input = async (action, payload, key = 'change') => ({ action, companyId: 'company', taskId: 'task', key,
    expectedRevision: (await inspect()).revision, ...(payload === undefined ? {} : { payload }) });
  const writes = () => state.calls.filter(call => call.method !== 'GET');
  return { store, state, api, inspect, input, writes };
}

const externalReference = { namespace: 'crm', externalId: 'CASE-1', url: 'https://example.com/cases/1' };
const referenceCreate = { action: 'create', companyId: 'company', key: 'create-reference',
  externalReference, payload: { title: 'Follow-up' } };

function cancelledRoutineResult(f) {
  f.state.task.status = 'blocked'; f.state.task.assigneeUserId = null; f.state.task.assigneeAgentId = 'router';
  f.store.register({ id: 'binding', companyId: 'company', agentId: 'router', harness: 'opencode', instanceId: 'i', conversationId: 'c' });
  let run = f.store.dispatch({ bindingId: 'binding', bindingRevision: 1, companyId: 'company', agentId: 'router', taskId: 'task', runId: 'backend' });
  f.store.acknowledge(run.id); f.store.submit(run.id, { key: 'candidate', candidate: 'sha256:candidate', summary: 'Preserved result' });
  f.store.publication(run.id, { state: 'recorded', commentId: 'comment' }); f.store.cancel(run.id);
  run = f.store.settle(run.id, { outcome: 'cancelled', evidence: 'Stale native execution cancelled' });
  f.state.task.executionBlocker = { recoveryActionId: 'recovery', runId: 'backend', agentId: 'router',
    cause: 'legacy_execution_requires_reconciliation', nextAction: 'Recorded work is preserved' };
  f.store.saveOperation({ id: `routine-task:${digest(['company', 'task'])}`, runId: '', state: 'recorded',
    scheduleId: 'routine', routineRunId: 'occurrence', routingAgentId: 'router', backendRunId: 'backend', relayRunId: run.id,
    request: { companyId: 'company', relayReviewPolicy: 'none', body: { assigneeAgentId: 'router' } },
    receipt: { id: 'task', companyId: 'company', assigneeAgentId: 'router' } });
  return run;
}

test('recover terminalises only an exact cancelled published no-review routine result', async t => {
  const f = fixture(t), run = cancelledRoutineResult(f);
  const input = { ...await f.input('recover'), reason: 'Preserve the published result and unblock future occurrences' };
  const result = await humanTask(f.store, f.api, input);
  assert.equal(result.task.status, 'done'); assert.equal(result.task.assigneeAgentId, 'router');
  assert.deepEqual(f.writes(), [{ method: 'PATCH', path: '/api/issues/task', body: { status: 'done' } }]);
  const completion = f.store.operation(`no-review-completion:${run.id}`);
  assert.equal(completion.state, 'recorded'); assert.equal(completion.status, 'done');
  assert.equal(completion.candidate, 'sha256:candidate'); assert.equal(completion.recoveredFrom, 'cancelled_published_routine');
  assert.deepEqual(await humanTask(f.store, f.api, input), result); assert.equal(f.writes().length, 1);
});

test('recover refuses ordinary blocked tasks and altered cancelled-result evidence', async t => {
  for (const variant of ['ordinary', 'unpublished', 'completed', 'wrong-blocker', 'review', 'not-routine']) {
    const f = fixture(t);
    let run;
    if (variant !== 'ordinary') run = cancelledRoutineResult(f);
    if (variant === 'unpublished') f.store.publication(run.id, { state: 'none' });
    if (variant === 'completed') f.store.save({ ...run, cancellationRequested: false,
      settlement: { outcome: 'completed', evidence: 'Different state' } }, 'fixture');
    if (variant === 'wrong-blocker') f.state.task.executionBlocker.runId = 'other';
    if (variant === 'review') f.state.task.reviewPolicy = { mode: 'human' };
    if (variant === 'not-routine') f.store.saveOperation({ ...f.store.operation(`routine-task:${digest(['company', 'task'])}`), state: 'uncertain' });
    const input = { ...await f.input('recover'), reason: 'Attempt bounded recovery' };
    await assert.rejects(humanTask(f.store, f.api, input), { code: 'recovery_not_authorised' });
    assert.equal(f.writes().length, 0); assert.equal(f.state.task.status, variant === 'ordinary' ? 'todo' : 'blocked');
  }
});

test('merged_interactive recovery verifies merged artefact, comments, decisions and absent agent without inventing a result', async t => {
  const f = fixture(t), repository = mkdtempSync(join(tmpdir(), 'relay-merged-recovery-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']);
  const artifactPath = 'docs/review-decisions.md';
  mkdirSync(join(repository, 'docs'));
  writeFileSync(join(repository, artifactPath), ['# Decisions', ...Array.from({ length: 7 }, (_, i) => `### D0${i + 1} - Candidate ${i + 1}`)].join('\n'));
  git(['add', artifactPath]); git(['commit', '-m', 'merge reviewed decisions']);
  const commit = git(['rev-parse', 'HEAD']);
  Object.assign(f.state.task, { status: 'blocked', assigneeUserId: null, assigneeAgentId: 'interactive-agent',
    description: `Decision artefact: ${artifactPath}` });
  f.store.register({ id: 'interactive-binding', companyId: 'company', agentId: 'interactive-agent', harness: 'opencode',
    instanceId: 'i', conversationId: 'interactive-chat' });
  const runs = [];
  for (let number = 1; number <= 7; number++) {
    let run = f.store.dispatch({ bindingId: 'interactive-binding', bindingRevision: 1, companyId: 'company',
      agentId: 'interactive-agent', taskId: 'task', runId: `backend-${number}` });
    f.store.acknowledge(run.id); f.store.ask(run.id, { key: `candidate-${number}`, question: `Candidate ${number}` });
    f.store.questionReceipt(run.id, { state: 'recorded', interactionId: `interaction-${number}` });
    if (number === 7) { f.store.cancel(run.id); run = f.store.settle(run.id, { outcome: 'cancelled', evidence: 'Agent disappeared' }); }
    else run = f.store.settle(run.id, { outcome: 'waiting', evidence: 'Human decision recorded' });
    runs.push(run);
    f.state.interactions.push({ id: `interaction-${number}`, kind: 'ask_user_questions',
      status: number === 7 ? 'pending' : 'answered', sourceRunId: `backend-${number}` });
    f.state.comments.push({ id: `candidate-comment-${number}`, companyId: 'company', issueId: 'task',
      authorAgentId: 'interactive-agent', body: `# Candidate ${number}: Preserved candidate` });
  }
  const last = runs.at(-1);
  f.state.task.executionBlocker = { recoveryActionId: 'recovery', runId: 'backend-7', agentId: 'interactive-agent',
    cause: 'legacy_execution_requires_reconciliation', nextAction: 'Recorded work is preserved' };
  f.store.saveOperation({ id: 'operator-task:interactive', runId: '', state: 'recorded',
    request: { companyId: 'company', relayReviewPolicy: 'human', body: { assigneeAgentId: 'interactive-agent' } },
    receipt: { id: 'task', companyId: 'company', assigneeAgentId: 'interactive-agent' } });
  const input = { ...await f.input('recover'), reason: 'Merged interactive work is preserved',
    payload: { mode: 'merged_interactive', repository, commit: commit.slice(0, 9), artifactPath } };
  const result = await humanTask(f.store, f.api, input);
  assert.equal(result.task.status, 'done'); assert.equal(runs.every(run => !run.result), true);
  const completion = f.store.operation('merged-interactive-completion:task');
  assert.equal(completion.commit, commit); assert.equal(completion.artifactPath, artifactPath);
  assert.equal(completion.status, 'done'); assert.equal(completion.state, 'recorded');
  assert.equal(f.store.operation(`no-review-completion:${last.id}`), null);
  assert.deepEqual(await humanTask(f.store, f.api, input), result);
  assert.equal(f.writes().length, 1);
});

test('external-reference creation reserves by journal identity and exposes references in its receipt', async t => {
  const f = fixture(t);
  f.state.post = () => {
    const ref = f.store.operation(`task-reference:${digest(['company', 'crm', 'CASE-1'])}`);
    assert.equal(ref.state, 'reserved');
    assert.deepEqual(f.store.operation(ref.ownerKey).request.externalReference, externalReference);
  };
  const result = await humanTask(f.store, f.api, referenceCreate);
  assert.deepEqual(result.task.references, [{ companyId: 'company', taskId: result.task.id, ...externalReference }]);
  assert.deepEqual(result.outcome, { confirmed: true });
  assert.deepEqual(f.store.operation(result.operationId).receipt, result.task);
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].body.externalReference, undefined);
  const count = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  assert.deepEqual(await humanTask(f.store, f.api, referenceCreate), result);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, count);
});

test('new create keys reuse actual terminal task state without defaults, resource validation or backend writes', async t => {
  for (const status of ['done', 'cancelled']) {
    const f = fixture(t);
    const first = await humanTask(f.store, f.api, referenceCreate);
    const task = [...f.state.creations.values()][0];
    Object.assign(task, { status, title: 'Actual title', assigneeUserId: null, assigneeAgentId: 'agent', token: 'private-token' });
    f.state.company.defaultResponsibleUserId = null;
    const input = { ...referenceCreate, key: 'reuse', payload: { title: 'Do not apply', parentId: 'nonexistent' } };
    const reused = await humanTask(f.store, f.api, input);
    assert.equal(reused.task.id, first.task.id);
    assert.equal(reused.task.status, status);
    assert.equal(reused.task.title, 'Actual title');
    assert.equal(reused.task.assigneeAgentId, 'agent');
    assert.deepEqual(reused.outcome, { confirmed: true, reused: true });
    assert.equal(f.writes().length, 1);
    const journal = f.store.operation(reused.operationId);
    assert.deepEqual(journal.request.payload, input.payload);
    assert.deepEqual(journal.receipt, reused.task);
    assert.doesNotMatch(JSON.stringify(reused), /private-token|sourceDigest|ownerKey/);
    const count = f.store.db.prepare('SELECT total_changes() AS n').get().n;
    await humanTask(f.store, f.api, input);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, count);
    await assert.rejects(humanTask(f.store, f.api, { ...input, payload: { title: 'Changed request' } }), { code: 'operation_conflict' });
    await assert.rejects(humanTask(f.store, f.api, { ...input, externalReference: { ...externalReference, externalId: 'other' } }), { code: 'operation_conflict' });
    await assert.rejects(humanTask(f.store, f.api, { ...input, key: 'url-conflict', externalReference: { ...externalReference, url: 'https://other.example' } }), { code: 'task_reference_conflict' });
  }
});

test('reference creation rejects malformed metadata and non-create use before API or journal access', async t => {
  const f = fixture(t);
  for (const value of [null, [], {}, { namespace: 'crm' }, { ...externalReference, externalId: '' },
    ...['companyId', 'taskId', 'ownerKey', 'engagement', 'dueAt', 'createdAt', 'token'].map(field => ({ ...externalReference, [field]: 'injected' })),
    ...[null, undefined, '', 'javascript:alert(1)', 'https://user:pass@example.com'].map(url => ({ ...externalReference, url }))]) {
    await assert.rejects(humanTask(f.store, f.api, { ...referenceCreate, externalReference: value }), { code: 'invalid_request' });
  }
  for (const action of ['inspect', 'edit', 'assign', 'complete', 'comment', 'reopen', 'cancel']) {
    await assert.rejects(humanTask(f.store, f.api, { ...referenceCreate, action, taskId: 'task' }), { code: 'invalid_request' });
  }
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
});

test('inspect references are local public projections and invalidate revisions for both edits and attachments', async t => {
  const f = fixture(t);
  const first = await f.inspect();
  assert.deepEqual(first.task.references, []);
  const ref = { companyId: 'company', ...externalReference };
  reserveTaskReference(f.store, ref, 'owner');
  assert.equal((await f.inspect()).revision, first.revision);
  finishTaskReference(f.store, ref, 'owner', 'task');
  f.state.task.references = [{ token: 'forged-backend-reference' }];
  const current = await f.inspect();
  assert.notEqual(current.revision, first.revision);
  assert.deepEqual(current.task.references, [{ ...ref, taskId: 'task' }]);
  assert.doesNotMatch(JSON.stringify(current.task.references), /owner|token|At/);
  await assert.rejects(humanTask(f.store, f.api, { action: 'edit', companyId: 'company', taskId: 'task', key: 'edit',
    expectedRevision: first.revision, payload: { title: 'Changed' } }), { code: 'stale_revision' });
  await assert.rejects(attachTaskReference(f.store, f.api, { ...ref, externalId: 'new', taskId: 'task', key: 'attach',
    expectedRevision: first.revision }), { code: 'stale_revision' });
  assert.equal(f.writes().length, 0);
});

test('interrupted reference finalisation and receipt inspection recover after restart without another POST', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'human-reference-finish-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const failure of ['task-identity', 'finish', 'inspect', 'human-receipt']) {
    const file = join(directory, `${failure}.sqlite`);
    const f = fixture(t, file);
    const save = f.store.saveOperation.bind(f.store);
    f.store.saveOperation = operation => {
      if ((failure === 'task-identity' && operation.id.startsWith('human-task:') && operation.taskId) ||
        (failure === 'finish' && operation.id.startsWith('task-reference:') && operation.state === 'attached') ||
        (failure === 'human-receipt' && operation.id.startsWith('human-task:') && operation.state === 'recorded')) throw new Error('interrupted');
      return save(operation);
    };
    if (failure === 'inspect') f.state.hook = (method, path) => {
      if (path.startsWith('/api/issues/created-')) throw new Error('interrupted');
    };
    await assert.rejects(humanTask(f.store, f.api, referenceCreate), /interrupted/);
    const reopened = new Store(file); t.after(() => reopened.close());
    f.state.hook = null;
    const result = await humanTask(reopened, f.api, referenceCreate);
    assert.equal(result.task.id, 'created-0');
    assert.equal(result.task.references.length, 1);
    assert.equal(result.outcome.reused, undefined);
    assert.equal(result.state, 'recorded');
    assert.equal(f.writes().length, 1);
  }
});

test('revoked create authority cannot send or finish, and reservations retain exact source and key', async t => {
  for (const stage of ['initial', 'company', 'post', 'reuse']) {
    const f = fixture(t);
    if (stage === 'reuse') await humanTask(f.store, f.api, referenceCreate);
    const input = { ...referenceCreate, key: stage === 'reuse' ? 'reuse' : referenceCreate.key };
    let valid = stage !== 'initial';
    const authority = { kind: 'native', bindingId: 'caller', sourceDigest: 'source' };
    const check = () => assert.ok(valid, 'revoked');
    f.state.hook = (method, path) => {
      if ((stage === 'company' && path === '/api/companies/company') || (stage === 'reuse' && path.startsWith('/api/issues/'))) valid = false;
    };
    if (stage === 'post') f.state.post = () => { valid = false; };
    await assert.rejects(humanTask(f.store, f.api, input, { check, authority }), /revoked/);
    assert.equal(f.writes().length, ['post', 'reuse'].includes(stage) ? 1 : 0);
    if (stage === 'initial') {
      assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
      continue;
    }
    if (stage !== 'reuse') assert.equal((await lookupTaskReference(f.store, f.api, { companyId: 'company', namespace: 'crm', externalId: 'CASE-1' })).state, 'reserved');
    await assert.rejects(humanTask(f.store, f.api, input, { authority: { ...authority, sourceDigest: 'different' } }), { code: 'operation_conflict' });
    valid = true;
    f.state.hook = null;
    f.state.post = null;
    const result = await humanTask(f.store, f.api, input, { check, authority });
    assert.equal(result.task.id, 'created-0');
    assert.equal(f.state.creations.size, 1);
  }
});

test('competing human creates reserve one external identity before posting', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    humanTask(f.store, f.api, referenceCreate),
    humanTask(f.store, f.api, { ...referenceCreate, key: 'competitor' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'task_reference_reserved');
  const reused = await humanTask(f.store, f.api, { ...referenceCreate, key: 'competitor' });
  assert.equal(reused.outcome.reused, true);
  assert.equal(f.writes().length, 1);
});

test('pre-create reservation failures retain the exact payload, reference and authority owner', async t => {
  const f = fixture(t);
  f.state.company.defaultResponsibleUserId = null;
  await assert.rejects(humanTask(f.store, f.api, referenceCreate), { code: 'invalid_request' });
  for (const change of [{ payload: { title: 'Changed' } }, { externalReference: { ...externalReference, externalId: 'other' } },
    { externalReference: undefined }]) {
    await assert.rejects(humanTask(f.store, f.api, { ...referenceCreate, ...change }));
  }
  await assert.rejects(humanTask(f.store, f.api, referenceCreate, { authority: { kind: 'native', bindingId: 'other' } }),
    { code: 'task_reference_reserved' });
  assert.equal(f.writes().length, 0);
  f.state.company.defaultResponsibleUserId = 'human';
  assert.equal((await humanTask(f.store, f.api, referenceCreate)).task.id, 'created-0');
  assert.equal(f.writes().length, 1);
});

test('reusing a reference requires fresh matching backend company and task identity before recording success', async t => {
  for (const change of [{ companyId: 'foreign' }, { id: 'foreign' }]) {
    const f = fixture(t);
    reserveTaskReference(f.store, { companyId: 'company', ...externalReference }, 'import');
    finishTaskReference(f.store, { companyId: 'company', ...externalReference }, 'import', 'task');
    Object.assign(f.state.task, change);
    await assert.rejects(humanTask(f.store, f.api, referenceCreate), { code: 'forbidden' });
    const journal = f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'human-task:%'").get();
    assert.equal(JSON.parse(journal.data).state, 'uncertain');
    assert.equal(JSON.parse(journal.data).receipt, undefined);
    assert.equal(f.writes().length, 0);
  }
});

test('simultaneous same-key human creates preserve one backend identity and do not turn creation into reuse', async t => {
  const f = fixture(t);
  const results = await Promise.all([
    humanTask(f.store, f.api, referenceCreate), humanTask(f.store, f.api, referenceCreate),
  ]);
  assert.equal(f.state.creations.size, 1);
  assert.equal(results[0].task.id, results[1].task.id);
  assert.equal(results[0].outcome.reused, undefined);
  assert.equal(results[1].outcome.reused, undefined);
  assert.equal(new Set(f.writes().map(call => call.body.idempotencyKey)).size, 1);
});

function runFor(f, overrides = {}) {
  const binding = f.store.binding('worker', false) ?? f.store.register({ id: 'worker', companyId: 'company', agentId: 'agent',
    harness: 'opencode', instanceId: 'instance', conversationId: 'conversation' }).binding;
  const run = f.store.dispatch({ bindingId: binding.id, bindingRevision: binding.revision, companyId: 'company',
    agentId: 'agent', runId: `backend-${f.store.runs().length}`, taskId: 'task' });
  return f.store.save({ ...run, ...overrides }, 'test');
}

function readyBridge(f) {
  const binding = f.store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode',
    instanceId: digest(['machine', 'session']), conversationId: 'conversation' }).binding;
  f.state.resources.set('/api/agents/agent', { id: 'agent', companyId: 'company' });
  f.store.saveOperation({ id: 'observed', runId: '', availability: 'present', agentId: 'agent',
    identity: { companyId: 'company', conversationId: 'conversation', machineId: 'machine', session: 'session', harness: 'opencode', sessionKind: 'id' },
    placement: { terminalId: 'terminal', directory: '/repo' } });
  f.store.saveOperation({ id: 'opencode-bridge:worker', runId: '', state: 'armed', ready: true, epoch: 'epoch', sessionCreatedAt: 1, lastSeen: new Date().toISOString(),
    identity: { bindingId: binding.id, observedId: 'observed', conversationId: 'conversation', terminalId: 'terminal', directory: '/repo' } });
}

test('inspect returns full public text, a revision and default human, without journalling or backend writes', async t => {
  const f = fixture(t);
  f.state.task.assigneeAdapterOverrides = { secret: 'do-not-return' };
  f.state.task.executionPolicy = { secret: 'do-not-return' };
  const first = await f.inspect();
  assert.equal(first.task.description, f.state.task.description);
  assert.equal(first.defaultHumanUserId, 'default-human');
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(first).includes('do-not-return'), false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM operations').get().n, 0);
  assert.equal(f.writes().length, 0);
  f.state.task.executionRunId = 'execution';
  assert.notEqual((await f.inspect()).revision, first.revision);
  f.state.task.executionRunId = null;
  f.state.interactions.push({ id: 'question', status: 'pending' });
  assert.notEqual((await f.inspect()).revision, first.revision);
});

test('rejects foreign tasks, invalid public fields and truncated descriptions', async t => {
  for (const change of [{ companyId: 'other' }, { id: 'other' }, { title: { secret: 'value' } }, { descriptionTruncated: true }]) {
    const f = fixture(t); Object.assign(f.state.task, change);
    await assert.rejects(f.inspect());
    assert.equal(f.writes().length, 0);
  }
});

test('rejects unknown actions, malicious fields, missing revisions and invalid payloads before writes', async t => {
  const f = fixture(t);
  const base = await f.input('edit', { title: 'new' });
  for (const input of [
    { ...base, action: 'delete' }, { ...base, authority: { kind: 'operator' } }, { ...base, origin: {} },
    { ...base, expectedRevision: undefined }, { ...base, key: '' }, { ...base, payload: {} },
    ...['reviewPolicy', 'executionPolicy', 'executionRunId', 'companyId', 'projectId', 'assigneeAgentId', 'idempotencyKey', 'dueAt', 'startDate']
      .map(field => ({ ...base, payload: { [field]: 'override' } })),
    ...['done', 'in_review', 'cancelled', 'bogus'].map(status => ({ ...base, payload: { status } })),
    { ...base, payload: { description: 7 } }, { ...base, payload: { title: '' } }, { ...base, payload: { priority: 'urgent' } },
    { ...base, action: 'complete', payload: { status: 'done' } }, { ...base, action: 'inspect' },
  ]) await assert.rejects(humanTask(f.store, f.api, input));
  assert.equal(f.writes().length, 0);
});

test('edits send only changed fields, preserve policies, and report actual fresh backend status', async t => {
  const f = fixture(t);
  f.state.task.reviewPolicy = 'human';
  const input = await f.input('edit', { title: 'Renamed', description: f.state.task.description });
  f.state.patch = body => { Object.assign(f.state.task, body, { status: 'blocked' }); return { ...f.state.task, status: 'todo' }; };
  const result = await humanTask(f.store, f.api, input);
  assert.deepEqual(f.writes().map(call => call.body), [{ title: 'Renamed' }]);
  assert.equal(result.task.status, 'blocked');
  assert.equal(result.state, 'recorded');
  assert.equal(result.task.reviewPolicy, undefined);
  f.state.task.status = 'cancelled';
  assert.equal((await humanTask(f.store, f.api, input)).task.status, 'cancelled');
  assert.equal(f.writes().length, 1);
});

test('no-op edits are journalled without PATCH', async t => {
  const f = fixture(t);
  const result = await humanTask(f.store, f.api, await f.input('edit', { title: f.state.task.title }));
  assert.equal(result.state, 'recorded');
  assert.equal(f.writes().length, 0);
});

test('stale revisions and changes during validation cannot PATCH', async t => {
  for (const during of [false, true]) {
    const f = fixture(t);
    const input = await f.input('edit', { title: 'new' });
    if (!during) f.state.task.description = 'changed';
    else {
      let reads = 0;
      f.state.hook = (method, path) => { if (path === '/api/issues/task' && ++reads === 2) f.state.task.assigneeUserId = 'different'; };
    }
    await assert.rejects(humanTask(f.store, f.api, input), { code: 'stale_revision' });
    assert.equal(f.writes().length, 0);
  }
});

test('all mutation types refuse execution holds, pending interactions and unsettled Relay work', async t => {
  for (const action of ['edit', 'assign', 'complete', 'comment', 'reopen', 'cancel']) {
    for (const hold of ['executionRunId', 'checkoutRunId', 'executionLockedAt', 'activeRun', 'activeRecoveryAction', 'executionBlocker', 'executionState', 'interaction', 'run']) {
      const f = fixture(t);
      if (hold === 'interaction') f.state.interactions.push({ id: 'question', status: 'pending' });
      else if (hold === 'run') runFor(f);
      else f.state.task[hold] = hold === 'executionState' ? { status: 'pending', currentStageId: 'stage' } : 'active';
      const payload = { edit: { title: 'new' }, assign: { assigneeUserId: 'another' }, comment: { body: 'Note' }, reopen: {} }[action];
      const input = { ...await f.input(action, payload), ...(action === 'cancel' ? { reason: 'Not needed' } : {}) };
      await assert.rejects(humanTask(f.store, f.api, input), { code: hold === 'interaction' ? 'interaction_pending' : 'task_busy' });
      assert.equal(f.writes().length, 0);
    }
  }
});

test('human completion needs no candidate or run and reports backend review disposition honestly', async t => {
  for (const status of ['done', 'in_review']) {
    const f = fixture(t);
    f.state.patch = () => { f.state.task.status = status; return { ...f.state.task, status: 'done' }; };
    const result = await humanTask(f.store, f.api, await f.input('complete'));
    assert.equal(result.task.status, status);
    assert.deepEqual(result.outcome, { confirmed: status === 'done' });
    assert.deepEqual(f.writes().map(call => call.body), [{ status: 'done' }]);
    assert.equal(f.store.runs().length, 0);
  }
});

test('completion refuses non-human ownership, review policy, unresolved dependencies and active children', async t => {
  for (const change of [
    { assigneeUserId: null }, { assigneeUserId: null, assigneeAgentId: 'agent' }, { assigneeAgentId: 'agent' },
    { reviewPolicy: 'human' }, { executionPolicy: { stages: [] } }, { status: 'in_review' }, { status: 'cancelled' },
    { status: 'blocked', unblockDescriptor: { owner: 'board', action: 'Resolve access' } }, { liveDescendantCount: 1 },
  ]) {
    const f = fixture(t); Object.assign(f.state.task, change);
    await assert.rejects(humanTask(f.store, f.api, await f.input('complete')));
    assert.equal(f.writes().length, 0);
  }
  for (const status of ['todo', 'cancelled']) {
    const f = fixture(t);
    f.state.task.blockedBy = [{ id: 'dependency', status: 'done' }];
    f.state.resources.set('/api/issues/dependency', { id: 'dependency', companyId: 'company', status });
    await assert.rejects(humanTask(f.store, f.api, await f.input('complete')), { code: 'dependency_unresolved' });
    assert.equal(f.writes().length, 0);
  }
  const f = fixture(t);
  f.state.children.push({ id: 'child', companyId: 'company', parentId: 'task', status: 'todo' });
  await assert.rejects(humanTask(f.store, f.api, await f.input('complete')), { code: 'dependency_unresolved' });
  assert.equal(f.writes().length, 0);
});

test('completion re-reads blockers rather than trusting relationship summaries', async t => {
  const f = fixture(t);
  f.state.task.blockedBy = [{ id: 'dependency', status: 'todo' }];
  f.state.task.blockedByIssueIds = ['dependency'];
  f.state.resources.set('/api/issues/dependency', { id: 'dependency', companyId: 'company', status: 'done' });
  assert.equal((await humanTask(f.store, f.api, await f.input('complete'))).task.status, 'done');
});

test('reassignment cannot bypass prior results, publication, settlement or exact backend acceptance', async t => {
  for (const problem of ['unaccepted', 'unpublished', 'unsettled', 'wrong-candidate', 'missing-backend', 'no-review', 'uncertain']) {
    const f = fixture(t);
    const result = { candidate: 'candidate', key: 'result', summary: 'Agent result' };
    const run = runFor(f, { nativeState: problem === 'unsettled' ? 'claimed' : 'settled', result,
      settlement: { outcome: 'completed' }, publication: { state: problem === 'unpublished' ? 'pending' : 'recorded' },
      review: { status: ['unaccepted', 'no-review'].includes(problem) ? 'pending' : 'accepted', candidate: problem === 'wrong-candidate' ? 'other' : 'candidate', interactionId: 'review' } });
    if (problem !== 'missing-backend') f.state.interactions.push({ id: 'review', status: 'accepted', kind: 'request_confirmation',
      idempotencyKey: `relay-review:${run.id}:${digest(result)}`, payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } });
    if (problem === 'uncertain') f.store.saveOperation({ id: `completion:${run.id}`, runId: run.id, state: 'uncertain' });
    await assert.rejects(humanTask(f.store, f.api, await f.input('complete')));
    assert.equal(f.writes().length, 0);
  }
});

test('accepted settled published history permits human completion only with exact backend evidence', async t => {
  const f = fixture(t);
  const result = { candidate: 'candidate', key: 'result', summary: 'Agent result' };
  const run = runFor(f, { nativeState: 'settled', result, settlement: { outcome: 'completed' }, publication: { state: 'recorded' },
    review: { status: 'accepted', candidate: 'candidate', interactionId: 'review' } });
  f.state.interactions.push({ id: 'review', status: 'accepted', kind: 'request_confirmation',
    idempotencyKey: `relay-review:${run.id}:${digest(result)}`, payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: 'candidate', label: run.id } } });
  assert.equal((await humanTask(f.store, f.api, await f.input('complete'))).task.status, 'done');
});

test('assignment explicitly clears opposite ownership and never includes status, wake or policy overrides', async t => {
  for (const payload of [{ assigneeAgentId: 'agent' }, { assigneeUserId: 'another' }, { assigneeUserId: null }, { assigneeAgentId: null },
    { assigneeAgentId: null, assigneeUserId: null }]) {
    const f = fixture(t);
    if (payload.assigneeAgentId) f.state.resources.set('/api/agents/agent', { id: 'agent', companyId: 'company' });
    const input = { ...await f.input('assign', payload), reason: 'Explicitly assign this task' };
    await humanTask(f.store, f.api, input);
    assert.deepEqual(f.writes().map(call => call.body), [{ assigneeAgentId: null, assigneeUserId: null, ...payload }]);
  }
});

test('assignment rejects missing wake reason, two assignees, invalid values and foreign agents', async t => {
  const f = fixture(t);
  for (const payload of [{}, { assigneeAgentId: 'agent', assigneeUserId: 'human' }, { assigneeAgentId: 'agent', assigneeUserId: null },
    { assigneeUserId: '' }, { assigneeAgentId: 1 }, { wake: true }, { assigneeAgentId: 'agent' }]) {
    await assert.rejects(humanTask(f.store, f.api, await f.input('assign', payload)));
  }
  f.state.resources.set('/api/agents/agent', { id: 'agent', companyId: 'other' });
  await assert.rejects(humanTask(f.store, f.api, { ...await f.input('assign', { assigneeAgentId: 'agent' }), reason: 'Delegate' }), { code: 'forbidden' });
  assert.equal(f.writes().length, 0);
});

test('agent assignment requires fresh ready bridge and worker admission, including final revalidation', async t => {
  for (const problem of ['none', 'not-ready', 'stale', 'offline', 'active', 'grant', 'changed-during-read']) {
    const f = fixture(t); readyBridge(f);
    if (['not-ready', 'stale'].includes(problem)) f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'),
      ...(problem === 'not-ready' ? { ready: false } : { lastSeen: '2000-01-01T00:00:00Z' }) });
    if (problem === 'offline') f.store.saveOperation({ ...f.store.operation('observed'), availability: 'offline' });
    if (problem === 'active') {
      const run = runFor(f);
      f.store.save({ ...run, request: { ...run.request, taskId: 'other-task' } }, 'test');
    }
    if (problem === 'grant') f.store.saveOperation({ id: 'herdr-worker:grant', runId: '', bindingId: 'worker', state: 'blocked' });
    const input = { ...await f.input('assign', { assigneeAgentId: 'agent' }), reason: 'Explicit delegation' };
    if (problem === 'changed-during-read') f.state.hook = () => {
      f.store.saveOperation({ ...f.store.operation('opencode-bridge:worker'), ready: false });
    };
    if (problem === 'none') assert.equal((await humanTask(f.store, f.api, input)).task.assigneeAgentId, 'agent');
    else {
      await assert.rejects(humanTask(f.store, f.api, input), { code: problem === 'grant' ? 'worker_grant_inactive' : 'agent_not_ready' });
      assert.equal(f.writes().length, 0);
    }
  }
});

test('uncertain PATCH committed or uncommitted is read-only on every retry, including after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'human-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const committed of [true, false]) {
    const file = join(directory, `${committed}.sqlite`);
    const f = fixture(t, file);
    const input = await f.input('edit', { title: 'Requested change' });
    f.state.patch = body => {
      if (committed) Object.assign(f.state.task, body);
      throw new Error('Lost response');
    };
    await assert.rejects(humanTask(f.store, f.api, input), /Lost response/);
    const reopened = new Store(file); t.after(() => reopened.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      if (committed) {
        const result = await humanTask(reopened, f.api, input);
        assert.equal(result.state, 'recorded'); assert.equal(result.reconciled, true);
      } else await assert.rejects(humanTask(reopened, f.api, input), { code: 'operation_uncertain' });
    }
    assert.equal(f.writes().length, 1);
    await assert.rejects(humanTask(reopened, f.api, { ...input, payload: { title: 'Different' } }), { code: 'operation_conflict' });
  }
});

test('uncertain mutation cannot reconcile changed ownership or wrong-company readback', async t => {
  for (const change of [{ assigneeUserId: 'other' }, { assigneeAgentId: 'agent' }, { companyId: 'other' }]) {
    const f = fixture(t); const input = await f.input('edit', { title: 'Changed' });
    f.state.patch = body => { Object.assign(f.state.task, body, change); throw new Error('Lost response'); };
    await assert.rejects(humanTask(f.store, f.api, input));
    await assert.rejects(humanTask(f.store, f.api, input), { code: change.companyId ? 'forbidden' : 'operation_uncertain' });
    assert.equal(f.writes().length, 1);
  }
});

test('uncertain assignment and completion reconcile exact outcomes without another PATCH', async t => {
  for (const action of ['assign', 'complete']) {
    const f = fixture(t);
    const input = await f.input(action, action === 'assign' ? { assigneeUserId: 'another' } : undefined);
    f.state.patch = body => { Object.assign(f.state.task, body); throw new Error('Lost response'); };
    await assert.rejects(humanTask(f.store, f.api, input));
    assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
    assert.equal(f.writes().length, 1);
  }
});

test('lost fresh receipt leaves uncertain intent and does not trust the PATCH response', async t => {
  const f = fixture(t);
  const input = await f.input('complete');
  let written = false;
  f.state.patch = body => { Object.assign(f.state.task, body); written = true; return f.state.task; };
  f.state.hook = (method, path) => { if (written && method === 'GET' && path === '/api/issues/task') throw new Error('Read failed'); };
  await assert.rejects(humanTask(f.store, f.api, input), /Read failed/);
  f.state.hook = null;
  assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
  assert.equal(f.writes().length, 1);
});

test('authority is checked after every awaited API call and before mutation dispatch', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'Changed' });
  let valid = true;
  const check = () => assert.ok(valid, 'authority revoked');
  f.state.hook = (method, path) => { if (path.endsWith('/interactions')) valid = false; };
  await assert.rejects(humanTask(f.store, f.api, input, { check }), /authority revoked/);
  assert.equal(f.writes().length, 0);
});

test('Relay state changes during the final backend read are rejected', async t => {
  const f = fixture(t);
  const input = await f.input('complete');
  let reads = 0;
  f.state.hook = (method, path) => { if (path.endsWith('/interactions') && ++reads === 2) runFor(f); };
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'stale_revision' });
  assert.equal(f.writes().length, 0);
});

test('authority revocation after PATCH prevents recording success but preserves recovery intent', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'Changed' });
  let valid = true;
  f.state.patch = body => { Object.assign(f.state.task, body); valid = false; return f.state.task; };
  await assert.rejects(humanTask(f.store, f.api, input, { check: () => assert.ok(valid, 'revoked') }), /revoked/);
  assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
  assert.equal(f.writes().length, 1);
});

test('creation uses the default human, no native origin restriction, and separate operator namespace', async t => {
  const f = fixture(t);
  f.state.resources.set('/api/issues/imported-parent', { id: 'imported-parent', companyId: 'company' });
  f.state.resources.set('/api/projects/project', { id: 'project', companyId: 'company' });
  const payload = { title: 'Follow-up', description: 'Details', parentId: 'imported-parent', projectId: 'project' };
  const input = { action: 'create', companyId: 'company', key: 'same-key', payload };
  const native = { kind: 'native', bindingId: 'caller', conversationId: 'chat', sessionCreatedAt: 1, sourceDigest: digest('Human request') };
  const first = await humanTask(f.store, f.api, input, { authority: native });
  assert.equal(first.task.assigneeUserId, 'default-human');
  assert.equal(first.task.status, 'todo');
  const operation = f.store.operation(first.operationId);
  assert.deepEqual(operation.request.authority, native);
  assert.equal(operation.request.origin, undefined);
  assert.equal(JSON.stringify(first).includes('sourceDigest'), false);
  f.state.company.defaultResponsibleUserId = 'changed-default';
  const second = await humanTask(f.store, f.api, input, { authority: native });
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.assigneeUserId, 'default-human');
  await createOperatorTask(f.store, f.api, { companyId: 'company', key: 'same-key', payload: { ...payload, assigneeUserId: 'human' } });
  assert.equal(f.state.creations.size, 2);
  assert.equal(f.writes().length, 2);
  await assert.rejects(humanTask(f.store, f.api, input, { authority: { ...native, sourceDigest: digest('Different source') } }), { code: 'operation_conflict' });
});

test('creation persists intent and reuses identical backend idempotency after a lost reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'human-create-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite');
  const f = fixture(t, file);
  const input = { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Create' } };
  f.state.post = () => { throw new Error('Lost create reply'); };
  await assert.rejects(humanTask(f.store, f.api, input), /Lost create reply/);
  const reopened = new Store(file); t.after(() => reopened.close());
  f.state.post = null;
  f.state.company.defaultResponsibleUserId = 'different';
  const result = await humanTask(reopened, f.api, input);
  assert.equal(result.state, 'recorded');
  assert.equal(result.task.assigneeUserId, 'default-human');
  assert.equal(f.state.creations.size, 1);
  assert.deepEqual(f.writes()[0].body, f.writes()[1].body);
  await humanTask(reopened, f.api, input);
  assert.equal(f.writes().length, 2);
});

test('creation checks authority after resource awaits and persists validated unblock data across retries', async t => {
  const f = fixture(t);
  f.state.resources.set('/api/issues/parent', { id: 'parent', companyId: 'company' });
  const input = { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Task', parentId: 'parent', status: 'blocked',
    unblockDescriptor: { owner: 'board', action: 'Review permission' } } };
  let valid = true;
  f.state.hook = (method, path) => { if (path === '/api/issues/parent') valid = false; };
  await assert.rejects(humanTask(f.store, f.api, input, { check: () => assert.ok(valid, 'revoked') }), /revoked/);
  assert.equal(f.writes().length, 0);
  f.state.hook = null;
  f.state.post = () => { throw new Error('Lost response'); };
  await assert.rejects(humanTask(f.store, f.api, input));
  f.state.post = null;
  await humanTask(f.store, f.api, input);
  assert.deepEqual(f.writes()[0].body, f.writes()[1].body);
  assert.equal(f.state.creations.size, 1);
  await assert.rejects(humanTask(f.store, f.api, { ...input, payload: { ...input.payload,
    unblockDescriptor: { owner: 'board', action: 'Different' } } }), { code: 'operation_conflict' });
});

test('stable keys conflict across actions but are isolated by durable authority owner', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'Changed' });
  const authority = { kind: 'native', bindingId: 'one', conversationId: 'chat', sessionCreatedAt: 1, sourceDigest: 'source' };
  const result = await humanTask(f.store, f.api, input, { authority });
  await assert.rejects(humanTask(f.store, f.api, { ...input, action: 'assign', payload: { assigneeUserId: 'other' } }, { authority }), { code: 'operation_conflict' });
  await assert.rejects(humanTask(f.store, f.api, { ...input, expectedRevision: result.revision }, { authority }), { code: 'operation_conflict' });
  const another = await humanTask(f.store, f.api, { ...input, expectedRevision: result.revision }, { authority: { ...authority, bindingId: 'two' } });
  assert.notEqual(result.operationId, another.operationId);
});

test('creation rejects agent ownership, terminal statuses, missing default human and foreign resources', async t => {
  for (const payload of [{ title: 'Task', assigneeAgentId: 'agent' }, { title: 'Task', assigneeUserId: null },
    { title: 'Task', status: 'done' }, { title: 'Task', status: 'in_review' }, { title: 'Task', status: 'cancelled' },
    { title: 'Task', idempotencyKey: 'override' }, { title: 'Task', reviewPolicy: 'none' }]) {
    const f = fixture(t);
    await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create', payload }));
    assert.equal(f.writes().length, 0);
  }
  for (const value of [undefined, null, '', '  ']) {
    const f = fixture(t); f.state.company.defaultResponsibleUserId = value;
    await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Task' } }));
    assert.equal(f.writes().length, 0);
  }
  for (const field of ['parentId', 'projectId']) {
    const f = fixture(t);
    f.state.resources.set(`/api/${field === 'parentId' ? 'issues' : 'projects'}/foreign`, { id: 'foreign', companyId: 'other' });
    await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create', payload: { title: 'Task', [field]: 'foreign' } }), { code: 'forbidden' });
    assert.equal(f.writes().length, 0);
  }
});

test('blocked create/edit accepts only bounded board or user unblock descriptors', async t => {
  for (const action of ['create', 'edit']) {
    for (const descriptor of [undefined, null, { owner: 'agent', action: 'act' }, { owner: { agentId: 'agent' }, action: 'act' },
      { owner: { userId: 'human', companyId: 'other' }, action: 'act' }, { owner: 'board', action: '' },
      { owner: 'board', action: 'a'.repeat(2001) }, { owner: 'board', action: 'act', extra: true }]) {
      const f = fixture(t);
      const payload = { title: 'Task', status: 'blocked', ...(descriptor === undefined ? {} : { unblockDescriptor: descriptor }) };
      const input = action === 'create' ? { action, companyId: 'company', key: 'create', payload } : await f.input(action, payload);
      await assert.rejects(humanTask(f.store, f.api, input));
      assert.equal(f.writes().length, 0);
    }
    for (const owner of ['board', { userId: 'human' }]) {
      const f = fixture(t);
      const unblockDescriptor = { owner, action: 'Approve access' };
      const payload = { title: 'Task', status: 'blocked', unblockDescriptor };
      const input = action === 'create' ? { action, companyId: 'company', key: 'create', payload } : await f.input(action, payload);
      assert.equal((await humanTask(f.store, f.api, input)).task.status, 'blocked');
      assert.deepEqual(f.writes()[0].body.unblockDescriptor, unblockDescriptor);
    }
  }
});

test('inspect projects responsible human, timestamps, dependency summaries and unblock context without nested secrets', async t => {
  const f = fixture(t);
  Object.assign(f.state.task, { responsibleUserId: 'responsible', createdAt: '2026-10-01T00:00:00Z',
    completedAt: '2026-10-02T00:00:00Z', cancelledAt: '2026-10-03T00:00:00Z', blockedByIssueIds: ['dependency'],
    blockedBy: [{ id: 'dependency', title: 'Access', status: 'blocked', activeRecoveryAction: { token: 'SECRET' } }],
    blocks: [{ id: 'dependent', status: 'todo', adapterConfig: { token: 'SECRET' } }],
    unblockDescriptor: { owner: { agentId: 'agent', token: 'SECRET' }, action: 'Grant access', secret: 'SECRET' } });
  const first = await f.inspect();
  for (const field of ['responsibleUserId', 'createdAt', 'completedAt', 'cancelledAt', 'blockedByIssueIds']) {
    assert.deepEqual(first.task[field], f.state.task[field]);
  }
  assert.equal(first.task.blockedBy[0].title, 'Access');
  assert.equal(first.task.blocks[0].id, 'dependent');
  assert.deepEqual(first.task.unblockDescriptor, { owner: { agentId: 'agent' }, action: 'Grant access' });
  assert.equal(JSON.stringify(first).includes('SECRET'), false);
  f.state.task.completedAt = null;
  assert.notEqual((await f.inspect()).revision, first.revision);
  for (const change of [{ blockedByIssueIds: [7] }, { blockedBy: [{ id: 'dependency', title: {} }] },
    { blocks: [{ companyId: 'foreign' }] }, { unblockDescriptor: { owner: { userId: {} }, action: 'Action' } },
    { responsibleUserId: {} }, { completedAt: {} }]) {
    const bad = fixture(t); Object.assign(bad.state.task, change);
    await assert.rejects(bad.inspect(), { code: 'invalid_backend_response' });
  }
});

test('comments persist UUID intent before POST, preserve connector attribution and read more than 100 comments without cursors', async t => {
  const f = fixture(t);
  f.state.task.status = 'blocked';
  f.state.comments.push(...Array.from({ length: 125 }, (_, i) => ({ id: `old-${i}`, companyId: 'company', issueId: 'task',
    body: 'Blocked pending access', clientRequestId: 'unrelated', createdAt: '2026-10-08T00:00:00.123Z' })));
  const input = await f.input('comment', { body: 'Blocked pending access' });
  f.state.hook = (method, path, body) => {
    if (method !== 'POST') return;
    assert.equal(path, '/api/issues/task/comments');
    const operations = f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'human-task:%'").all().map(row => JSON.parse(row.data));
    assert.equal(operations.length, 1);
    const operation = operations[0];
    assert.equal(operation.state, 'uncertain');
    assert.equal(operation.clientRequestId, body.clientRequestId);
    const hash = digest(operation.id);
    assert.equal(body.clientRequestId, `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`);
    assert.match(body.clientRequestId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.deepEqual(body, { body: input.payload.body, clientRequestId: operation.clientRequestId, reopen: false, resume: false, interrupt: false });
  };
  const authority = { kind: 'native', bindingId: 'caller', sourceDigest: 'human-source' };
  // Model the installed backend's lossy cursor: sub-ms rows repeat the anchor.
  const api = (method, path, body) => path.includes('/comments?') && new URLSearchParams(path.split('?')[1]).has('after')
    ? Promise.resolve(structuredClone(f.state.comments.slice(0, 100))) : f.api(method, path, body);
  const result = await humanTask(f.store, api, input, { authority });
  assert.equal(result.task.status, 'blocked');
  assert.deepEqual(result.outcome, { confirmed: true });
  assert.equal(f.state.comments[125].authorUserId, 'connector-human');
  assert.equal(f.state.comments[125].authorAgentId, null);
  assert.equal(f.store.operation(result.operationId).commentId, 'comment-125');
  assert.deepEqual(f.store.operation(result.operationId).request.authority, authority);
  assert.deepEqual(f.state.calls.filter(call => call.path.includes('/comments?')).map(call => call.path),
    ['/api/issues/task/comments?order=asc']);
  await humanTask(f.store, api, input, { authority });
  assert.equal(f.writes().length, 1);
});

test('comment payload forbids attribution, wake flags and missing revisions', async t => {
  const f = fixture(t);
  const base = await f.input('comment', { body: 'Note' });
  for (const payload of [undefined, {}, { body: '' }, { body: 1 },
    ...['authorUserId', 'authorAgentId', 'onBehalfOfUserId', 'authorType', 'clientRequestId', 'reopen', 'resume', 'interrupt']
      .map(field => ({ body: 'Note', [field]: 'override' }))]) {
    await assert.rejects(humanTask(f.store, f.api, { ...base, payload }));
  }
  await assert.rejects(humanTask(f.store, f.api, { ...base, expectedRevision: undefined }));
  assert.equal(f.writes().length, 0);
});

test('comments reject agent reference syntax before any API call or uncertain intent, even without an @ label', async t => {
  const f = fixture(t);
  const base = await f.input('comment', { body: 'Note' });
  const calls = f.state.calls.length;
  for (const body of ['[@Agent](agent://12345678-1234-1234-1234-123456789abc)',
    '[Agent](agent://agent?i=bot)', '[](agent:///agent)', '[Email human@example.com](agent://agent)',
    '`[Agent](agent://agent)`', 'agent://not-yet-created', '[Agent](AGENT://agent)']) {
    await assert.rejects(humanTask(f.store, f.api, { ...base, payload: { body } }), { code: 'agent_mention_forbidden' });
  }
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'human-task:%'").get().n, 0);
  const result = await humanTask(f.store, f.api, { ...base, payload: {
    body: 'Email human@example.com, @Agent or @12345678-1234-1234-1234-123456789abc is plain prose. [Human](user://human)',
  } });
  assert.equal(result.outcome.confirmed, true);
  assert.equal(f.writes().length, 1);
});

test('comments require human ownership including terminal tasks and revalidate before POST', async t => {
  for (const status of ['todo', 'blocked', 'done', 'cancelled']) {
    for (const assignees of [{ assigneeUserId: null }, { assigneeUserId: ' ' },
      { assigneeUserId: null, assigneeAgentId: 'agent' }, { assigneeAgentId: 'agent' }]) {
      const f = fixture(t);
      Object.assign(f.state.task, assignees, { status });
      await assert.rejects(humanTask(f.store, f.api, await f.input('comment', { body: 'Note' })),
        { code: 'human_assignment_required' });
      assert.equal(f.writes().length, 0);
      assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'human-task:%'").get().n, 0);
    }
  }
  const f = fixture(t);
  const input = await f.input('comment', { body: 'Note' });
  let reads = 0;
  f.state.hook = (method, path) => {
    if (path === '/api/issues/task' && ++reads === 2) Object.assign(f.state.task, { assigneeUserId: null, assigneeAgentId: 'agent' });
  };
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'stale_revision' });
  assert.equal(f.writes().length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM operations WHERE id LIKE 'human-task:%'").get().n, 0);
});

test('comment receipts require explicit user attribution and reject agent, run, deleted or missing actor evidence', async t => {
  for (const change of [{ authorType: undefined }, { authorType: 'agent' }, { authorType: 'system' },
    { authorUserId: undefined }, { authorUserId: null }, { authorUserId: ' ' }, { authorUserId: 7 },
    { authorAgentId: 'agent' }, { derivedAuthorAgentId: 'agent' }, { createdByRunId: 'run' },
    { derivedCreatedByRunId: 'run' }, { deletedAt: '2026-10-08T00:00:00Z' }]) {
    const f = fixture(t);
    const input = await f.input('comment', { body: 'Note' });
    f.state.post = value => Object.assign(value, change);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(humanTask(f.store, f.api, input), { code: 'operation_uncertain' });
    }
    assert.equal(f.writes().length, 1);
    const operation = JSON.parse(f.store.db.prepare("SELECT data FROM operations WHERE id LIKE 'human-task:%'").get().data);
    assert.equal(operation.state, 'uncertain');
    assert.equal(operation.commentId, undefined);
  }
});

test('comment receipts accept exactly 10000 rows and report changed task ownership after posting honestly', async t => {
  const f = fixture(t);
  f.state.comments.push(...Array.from({ length: 9999 }, (_, i) => ({ id: `old-${i}`, companyId: 'company', issueId: 'task' })));
  f.state.post = () => { f.state.task.assigneeUserId = 'other-human'; };
  const result = await humanTask(f.store, f.api, await f.input('comment', { body: 'Note' }));
  assert.equal(f.store.operation(result.operationId).commentId, 'comment-9999');
  assert.equal(result.task.assigneeUserId, 'other-human');
  assert.equal(result.outcome.confirmed, false);
  assert.equal(f.writes().length, 1);
});

test('uncertain comments survive restart and never resend, even when another comment has identical text', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'human-comments-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const committed of [true, false]) {
    const file = join(directory, `${committed}.sqlite`);
    const f = fixture(t, file);
    f.state.comments.push({ id: 'old', companyId: 'company', issueId: 'task', body: 'Same text', clientRequestId: 'other' });
    const input = await f.input('comment', { body: 'Same text' });
    f.state.post = () => { if (!committed) f.state.comments.pop(); throw new Error('Lost response'); };
    await assert.rejects(humanTask(f.store, f.api, input), /Lost response/);
    const reopened = new Store(file); t.after(() => reopened.close());
    for (let attempt = 0; attempt < 2; attempt++) {
      if (committed) {
        const result = await humanTask(reopened, f.api, input);
        assert.equal(result.reconciled, true);
        assert.equal(result.outcome.confirmed, true);
      } else await assert.rejects(humanTask(reopened, f.api, input), { code: 'operation_uncertain' });
    }
    assert.equal(f.writes().length, 1);
  }
});

test('comment readback rejects wrong body, scope, duplicate identity and excessive rows without replay', async t => {
  for (const problem of ['body', 'company', 'issue', 'missing-company', 'missing-issue', 'duplicate', 'repeat', 'limit']) {
    const f = fixture(t);
    const input = await f.input('comment', { body: 'Note' });
    f.state.post = value => {
      if (problem === 'body') value.body = 'Different';
      if (problem === 'company') value.companyId = 'foreign';
      if (problem === 'issue') value.issueId = 'foreign';
      if (problem === 'missing-company') delete value.companyId;
      if (problem === 'missing-issue') delete value.issueId;
      if (problem === 'duplicate') f.state.comments.push({ ...value, id: 'duplicate' });
      if (problem === 'repeat') f.state.comments.push({ ...value });
      if (problem === 'limit') {
        f.state.comments.push(...Array.from({ length: 10000 }, (_, i) => ({ id: `extra-${i}`, companyId: 'company', issueId: 'task' })));
      }
    };
    await assert.rejects(humanTask(f.store, f.api, input));
    await assert.rejects(humanTask(f.store, f.api, input));
    assert.equal(f.writes().length, 1);
  }
});

test('reopen is explicit, terminal-only and human-owned, and returns actual disposition', async t => {
  for (const status of ['done', 'cancelled']) {
    for (const payload of [{}, { status: 'todo' }, { status: 'in_progress' }]) {
      const f = fixture(t); f.state.task.status = status;
      const result = await humanTask(f.store, f.api, await f.input('reopen', payload));
      assert.equal(result.task.status, payload.status ?? 'todo');
      assert.equal(result.outcome.confirmed, true);
      assert.deepEqual(f.writes().map(call => call.body), [{ status: payload.status ?? 'todo' }]);
    }
  }
  for (const status of ['todo', 'in_progress', 'in_review', 'blocked']) {
    const f = fixture(t); f.state.task.status = status;
    await assert.rejects(humanTask(f.store, f.api, await f.input('reopen', {})), { code: 'invalid_status' });
    assert.equal(f.writes().length, 0);
  }
  for (const payload of [undefined, { status: 'done' }, { status: 'cancelled' }, { status: 'blocked' }, { resume: true }]) {
    const f = fixture(t); f.state.task.status = 'done';
    await assert.rejects(humanTask(f.store, f.api, await f.input('reopen', payload)));
    assert.equal(f.writes().length, 0);
  }
  const f = fixture(t); f.state.task.status = 'done';
  f.state.patch = () => { f.state.task.status = 'in_review'; return { status: 'todo' }; };
  const result = await humanTask(f.store, f.api, await f.input('reopen', {}));
  assert.equal(result.task.status, 'in_review');
  assert.equal(result.outcome.confirmed, false);
  assert.equal(result.state, 'recorded');
});

test('cancel journals its reason without backend comments or intentional changes to parents or siblings', async t => {
  const f = fixture(t);
  f.state.task.parentId = 'parent';
  f.state.resources.set('/api/issues/parent', { id: 'parent', companyId: 'company', status: 'in_progress' });
  f.state.children.push({ id: 'child', status: 'todo' });
  for (const reason of [undefined, '', '  ']) {
    await assert.rejects(humanTask(f.store, f.api, { ...await f.input('cancel'), reason }));
  }
  const input = { ...await f.input('cancel'), reason: 'No longer required [Agent](agent://agent)' };
  const result = await humanTask(f.store, f.api, input);
  assert.equal(result.task.status, 'cancelled');
  assert.equal(result.outcome.confirmed, true);
  assert.equal(f.state.comments.length, 0);
  assert.equal(f.store.operation(result.operationId).request.reason, input.reason);
  assert.equal(f.store.operation(result.operationId).clientRequestId, undefined);
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0], { method: 'PATCH', path: '/api/issues/task', body: { status: 'cancelled' } });
  assert.equal(f.state.calls.some(call => call.path.includes('/comments')), false);
  assert.equal(f.state.children[0].status, 'todo');
  assert.equal(f.state.resources.get('/api/issues/parent').status, 'in_progress');
});

test('reopen and cancel cannot bypass agent ownership or use edit as a terminal-status escape', async t => {
  for (const action of ['reopen', 'cancel']) {
    for (const assignees of [{ assigneeUserId: null }, { assigneeUserId: null, assigneeAgentId: 'agent' }, { assigneeAgentId: 'agent' }]) {
      const f = fixture(t); Object.assign(f.state.task, assignees, { status: 'done' });
      const input = { ...await f.input(action, action === 'reopen' ? {} : undefined), reason: 'Human request' };
      await assert.rejects(humanTask(f.store, f.api, input), { code: 'human_assignment_required' });
      assert.equal(f.writes().length, 0);
    }
  }
  for (const status of ['done', 'cancelled']) {
    const f = fixture(t); f.state.task.status = status;
    await assert.rejects(humanTask(f.store, f.api, await f.input('edit', { status: 'todo' })), { code: 'invalid_status' });
    assert.equal(f.writes().length, 0);
  }
});

test('all new mutations check revision both before and after validation', async t => {
  for (const action of ['comment', 'reopen', 'cancel']) {
    for (const during of [false, true]) {
      const f = fixture(t); f.state.task.status = 'done';
      const payload = { comment: { body: 'Note' }, reopen: {} }[action];
      const input = { ...await f.input(action, payload), reason: 'Human request' };
      await assert.rejects(humanTask(f.store, f.api, { ...input, expectedRevision: undefined }), { code: 'invalid_request' });
      if (during) {
        let reads = 0;
        f.state.hook = (method, path) => { if (path === '/api/issues/task' && ++reads === 2) f.state.task.description = 'Changed'; };
      } else f.state.task.description = 'Changed';
      await assert.rejects(humanTask(f.store, f.api, input), { code: 'stale_revision' });
      assert.equal(f.writes().length, 0);
    }
  }
});

test('uncertain reopen and cancellation reconcile read-only with exact status and journalled reason', async t => {
  for (const action of ['reopen', 'cancel']) {
    const f = fixture(t); f.state.task.status = 'done';
    const input = { ...await f.input(action, action === 'reopen' ? {} : undefined), reason: 'Human request' };
    f.state.patch = body => {
      f.state.task.status = body.status;
      throw new Error('Lost reply');
    };
    await assert.rejects(humanTask(f.store, f.api, input));
    const result = await humanTask(f.store, f.api, input);
    assert.equal(result.reconciled, true);
    assert.equal(result.outcome.confirmed, true);
    assert.equal(f.writes().length, 1);
    assert.equal(f.store.operation(result.operationId).request.reason, input.reason);
    assert.equal(f.state.calls.some(call => call.path.includes('/comments')), false);
  }
});

test('relationship edits and creation validate graphs and preserve parent and dependencies independently', async t => {
  const f = fixture(t);
  f.state.resources.set('/api/issues/parent', { id: 'parent', companyId: 'company', parentId: 'ancestor' });
  f.state.resources.set('/api/issues/ancestor', { id: 'ancestor', companyId: 'company' });
  f.state.resources.set('/api/issues/dependency', { id: 'dependency', companyId: 'company', blockedByIssueIds: ['leaf'] });
  f.state.resources.set('/api/issues/leaf', { id: 'leaf', companyId: 'company' });
  const payload = { parentId: 'parent', blockedByIssueIds: ['dependency'] };
  let result = await humanTask(f.store, f.api, await f.input('edit', payload, 'set'));
  assert.equal(result.outcome.confirmed, true);
  assert.deepEqual(f.writes()[0].body, payload);
  result = await humanTask(f.store, f.api, await f.input('edit', { parentId: null }, 'clear-parent'));
  assert.equal(result.task.parentId, null);
  assert.deepEqual(result.task.blockedByIssueIds, ['dependency']);
  assert.deepEqual(f.writes()[1].body, { parentId: null });
  await humanTask(f.store, f.api, await f.input('edit', { parentId: 'parent' }, 'parent'));
  result = await humanTask(f.store, f.api, await f.input('edit', { blockedByIssueIds: [] }, 'clear-dependencies'));
  assert.equal(result.task.parentId, 'parent');
  assert.deepEqual(result.task.blockedByIssueIds, []);
  assert.deepEqual(f.writes()[3].body, { blockedByIssueIds: [] });
  assert.ok(f.writes().every(call => call.path === '/api/issues/task'));
  result = await humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create-graph', payload: { title: 'Child', ...payload } });
  assert.equal(result.task.parentId, 'parent');
  assert.deepEqual(result.task.blockedByIssueIds, ['dependency']);
  assert.equal(result.outcome.confirmed, true);
  assert.ok(f.state.calls.some(call => call.path === '/api/issues/ancestor'));
  assert.ok(f.state.calls.some(call => call.path === '/api/issues/leaf'));
});

test('relationship validation refuses self, transitive cycles, foreign graphs and read limits without PATCH', async t => {
  for (const field of ['parentId', 'blockedByIssueIds']) {
    for (const problem of ['self', 'cycle', 'existing-cycle', 'foreign', 'limit']) {
      const f = fixture(t);
      const edge = next => field === 'parentId' ? { parentId: next } : { blockedByIssueIds: [next] };
      for (let i = 0; i < 101; i++) f.state.resources.set(`/api/issues/node-${i}`,
        { id: `node-${i}`, companyId: 'company', ...(i < 100 ? edge(`node-${i + 1}`) : {}) });
      if (problem !== 'limit') f.state.resources.set('/api/issues/node-1', { id: 'node-1', companyId: problem === 'foreign' ? 'foreign' : 'company',
        ...(problem === 'cycle' ? edge('task') : problem === 'existing-cycle' ? edge('node-0') : {}) });
      const payload = edge(problem === 'self' ? 'task' : 'node-0');
      await assert.rejects(humanTask(f.store, f.api, await f.input('edit', payload)),
        { code: problem === 'foreign' ? 'forbidden' : problem === 'limit' ? 'graph_limit' : 'relationship_cycle' });
      assert.equal(f.writes().length, 0);
    }
  }
  for (const blockedByIssueIds of [null, 'id', [null], [''], ['a', 'a'], Array.from({ length: 101 }, (_, i) => `id-${i}`)]) {
    const f = fixture(t);
    await assert.rejects(humanTask(f.store, f.api, await f.input('edit', { blockedByIssueIds })), { code: 'invalid_request' });
    assert.equal(f.writes().length, 0);
  }
});

function acceptedRun(f, candidate = 'candidate') {
  const result = { candidate, key: candidate, summary: 'Result' };
  const run = runFor(f, { nativeState: 'settled', result, publication: { state: 'recorded' }, settlement: { outcome: 'completed' },
    review: { status: 'accepted', candidate, interactionId: `review-${candidate}` } });
  f.state.interactions.push({ id: run.review.interactionId, status: 'accepted', kind: 'request_confirmation',
    idempotencyKey: `relay-review:${run.id}:${digest(result)}`, payload: { target: { type: 'custom', key: 'herdr-relay-candidate', revisionId: candidate, label: run.id } } });
  return run;
}

test('settled rejected history is allowed, but latest authoritative result must be accepted for edit, assign and complete', async t => {
  for (const action of ['edit', 'assign', 'complete']) {
    for (const latestAccepted of [true, false]) {
      const f = fixture(t);
      const old = acceptedRun(f, 'old');
      if (latestAccepted) f.store.save({ ...old, review: { ...old.review, status: 'rejected' } }, 'test');
      const latest = acceptedRun(f, 'latest');
      if (!latestAccepted) f.store.save({ ...latest, review: { ...latest.review, status: 'rejected' } }, 'test');
      runFor(f, { nativeState: 'settled', settlement: { outcome: 'failed' } });
      const payload = { edit: { title: 'New' }, assign: { assigneeUserId: 'other' } }[action];
      const input = await f.input(action, payload);
      if (latestAccepted) assert.equal((await humanTask(f.store, f.api, input)).outcome.confirmed, true);
      else {
        await assert.rejects(humanTask(f.store, f.api, input), { code: 'acceptance_required' });
        assert.equal(f.writes().length, 0);
      }
    }
  }
});

test('no-review completion must be recorded for the exact latest result and match creator policy and decision', async t => {
  for (const policy of ['none', 'agent_decides']) {
    for (const problem of ['none', 'policy', 'candidate', 'decision', 'company', 'task', 'run', 'status', 'state', 'unpublished']) {
      const f = fixture(t);
      f.store.saveOperation({ id: 'operator-task:policy', runId: '', state: 'recorded', receipt: { id: 'task' },
        request: { companyId: 'company', relayReviewPolicy: problem === 'policy' ? 'human' : policy } });
      const result = { candidate: 'candidate', key: 'result', summary: 'Result',
        ...(policy === 'agent_decides' ? { reviewDecision: { mode: 'none', reason: 'Low risk' } } : {}) };
      const run = runFor(f, { nativeState: 'settled', result, settlement: { outcome: 'completed' },
        publication: { state: problem === 'unpublished' ? 'pending' : 'recorded' } });
      const completion = { id: `no-review-completion:${run.id}`, runId: run.id, companyId: 'company', taskId: 'task',
        state: 'recorded', status: 'done', policy: 'none', candidate: result.candidate, decision: result.reviewDecision ?? null };
      const field = { candidate: 'candidate', decision: 'decision', company: 'companyId', task: 'taskId', run: 'runId', status: 'status', state: 'state' }[problem];
      if (field) completion[field] = 'different';
      f.store.saveOperation(completion);
      const input = await f.input('complete');
      if (problem === 'none') assert.equal((await humanTask(f.store, f.api, input)).outcome.confirmed, true);
      else {
        await assert.rejects(humanTask(f.store, f.api, input));
        assert.equal(f.writes().length, 0);
      }
    }
  }
});

test('only known inert normal execution policies permit mutations', async t => {
  for (const executionPolicy of [null, { mode: 'normal' }, { mode: 'normal', commentRequired: true, stages: [], monitor: null, maxReviewRounds: null }]) {
    const f = fixture(t); f.state.task.executionPolicy = executionPolicy;
    assert.equal((await humanTask(f.store, f.api, await f.input('complete'))).outcome.confirmed, true);
  }
  for (const executionPolicy of [{}, { stages: [] }, { mode: 'other' }, { mode: 'normal', unknown: false },
    { mode: 'normal', stages: [{}] }, { mode: 'normal', stages: null }, { mode: 'normal', monitor: {} },
    { mode: 'normal', monitor: false }, { mode: 'normal', maxReviewRounds: 1 }, { mode: 'normal', authorizationPolicy: {} },
    { mode: 'normal', reviewPreset: null }, { mode: 'normal', commentRequired: 'false' }]) {
    for (const action of ['edit', 'assign', 'complete', 'reopen', 'cancel', 'comment']) {
      const f = fixture(t); f.state.task.executionPolicy = executionPolicy;
      const payload = { edit: { title: 'New' }, assign: { assigneeUserId: 'other' }, reopen: {}, comment: { body: 'Note' } }[action];
      await assert.rejects(humanTask(f.store, f.api, { ...await f.input(action, payload), reason: 'Human request' }), { code: 'review_required' });
      assert.equal(f.writes().length, 0);
    }
  }
});

test('every uncertain human-task write fences all different keys and authorities for the same task', async t => {
  for (const pendingAction of ['edit', 'assign', 'complete', 'reopen', 'cancel', 'comment']) {
    const f = fixture(t); f.state.task.status = pendingAction === 'reopen' ? 'done' : 'todo';
    const payloads = { edit: { title: 'New' }, assign: { assigneeUserId: 'other' }, reopen: {}, comment: { body: 'Note' } };
    const pending = { ...await f.input(pendingAction, payloads[pendingAction], 'uncertain'), reason: 'Human request' };
    f.state.hook = method => { if (method !== 'GET') throw new Error('Lost write'); };
    await assert.rejects(humanTask(f.store, f.api, pending), /Lost write/);
    f.state.hook = null;
    for (const action of ['edit', 'assign', 'complete', 'reopen', 'cancel', 'comment']) {
      const input = { ...await f.input(action, payloads[action], `different-${action}`), reason: 'Human request' };
      await assert.rejects(humanTask(f.store, f.api, input, { authority: { kind: 'native', bindingId: 'different' } }), { code: 'operation_uncertain' });
    }
    assert.equal(f.writes().length, 1);
  }
});

test('uncertain operation appearing during validation is fenced before dispatch', async t => {
  const f = fixture(t);
  const input = await f.input('edit', { title: 'New' });
  let reads = 0;
  f.state.hook = (method, path) => {
    if (path === '/api/issues/task' && ++reads === 2) f.store.saveOperation({ id: 'human-task:other', runId: '', state: 'uncertain',
      request: { companyId: 'company', taskId: 'task', action: 'comment' } });
  };
  await assert.rejects(humanTask(f.store, f.api, input), { code: 'operation_uncertain' });
  assert.equal(f.writes().length, 0);
});

test('recorded responses explicitly report whether requested fields actually matched', async t => {
  const f = fixture(t);
  f.state.patch = () => ({ ...f.state.task, title: 'Requested' });
  const input = await f.input('edit', { title: 'Requested' });
  const result = await humanTask(f.store, f.api, input);
  assert.equal(result.state, 'recorded');
  assert.equal(result.task.title, 'Human work');
  assert.deepEqual(result.outcome, { confirmed: false });
  assert.equal((await humanTask(f.store, f.api, input)).outcome.confirmed, false);
  assert.equal(f.writes().length, 1);
});

test('cancellation reports backend review disposition rather than claiming cancellation', async t => {
  const f = fixture(t);
  f.state.patch = () => {
    f.state.task.status = 'in_review';
    return { ...f.state.task, status: 'cancelled' };
  };
  const result = await humanTask(f.store, f.api, { ...await f.input('cancel'), reason: 'Requested cancellation' });
  assert.equal(result.task.status, 'in_review');
  assert.equal(result.outcome.confirmed, false);
  assert.equal(result.state, 'recorded');
});

test('comments check authority at send and readback boundaries without replay after revocation', async t => {
  for (const afterSend of [false, true]) {
    const f = fixture(t);
    const input = await f.input('comment', { body: 'Note' });
    let valid = true;
    let reads = 0;
    f.state.hook = (method, path) => { if (!afterSend && path.endsWith('/interactions') && ++reads === 2) valid = false; };
    f.state.post = () => { valid = false; };
    await assert.rejects(humanTask(f.store, f.api, input, { check: () => assert.ok(valid, 'revoked') }), /revoked/);
    assert.equal(f.writes().length, afterSend ? 1 : 0);
    if (afterSend) {
      f.state.hook = null;
      assert.equal((await humanTask(f.store, f.api, input)).reconciled, true);
      assert.equal(f.writes().length, 1);
    }
  }
});

test('creation applies bounded same-company ancestry and dependency validation through the existing wrapper', async t => {
  for (const field of ['parentId', 'blockedByIssueIds']) {
    for (const problem of ['foreign', 'cycle']) {
      const f = fixture(t);
      const edge = id => field === 'parentId' ? { parentId: id } : { blockedByIssueIds: [id] };
      f.state.resources.set('/api/issues/related', { id: 'related', companyId: 'company', ...edge('next') });
      f.state.resources.set('/api/issues/next', { id: 'next', companyId: problem === 'foreign' ? 'foreign' : 'company', ...edge('related') });
      await assert.rejects(humanTask(f.store, f.api, { action: 'create', companyId: 'company', key: 'create',
        payload: { title: 'Child', ...edge('related') } }), { code: problem === 'foreign' ? 'forbidden' : 'relationship_cycle' });
      assert.equal(f.writes().length, 0);
    }
  }
});
