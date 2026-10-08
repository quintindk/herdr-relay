import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/store.mjs';
import { humanTask } from '../src/human-tasks.mjs';
import { createOperatorTask } from '../src/operations.mjs';
import { digest } from '../src/protocol.mjs';
import { attachTaskReference, finishTaskReference, lookupTaskReference, reserveTaskReference, taskReferences } from '../src/task-references.mjs';

const reference = { companyId: 'company', namespace: 'crm', externalId: 'CASE-1', url: 'https://example.com/cases/1' };
const identity = { companyId: reference.companyId, namespace: reference.namespace, externalId: reference.externalId };
const input = { ...reference, taskId: 'task', key: 'attach' };
const rows = store => store.db.prepare('SELECT * FROM operations ORDER BY id').all();
const changes = store => store.db.prepare('SELECT total_changes() AS n').get().n;

function fixture(t, file = ':memory:') {
  const store = new Store(file);
  t.after(() => store.close());
  const state = { task: { id: 'task', companyId: 'company', identifier: 'TEST-1', title: 'Follow-up', description: 'Details',
    status: 'done', priority: 'medium', assigneeUserId: 'human', assigneeAgentId: null,
    token: 'secret-token', assigneeAdapterOverrides: { apiKey: 'secret-key' } }, calls: [], hook: null };
  const api = async (method, path) => {
    assert.equal(method, 'GET', 'References must never mutate backend tasks');
    state.calls.push({ method, path });
    await state.hook?.(method, path);
    if (path === '/api/companies/company') return { id: 'company' };
    if (path.endsWith('/interactions')) return [];
    assert.equal(path, `/api/issues/${encodeURIComponent(state.task.id)}`);
    return structuredClone(state.task);
  };
  return { store, api, state };
}

test('attach journals an immutable reference and exposes only public fields without reopening a done task', async t => {
  const f = fixture(t);
  const result = await attachTaskReference(f.store, f.api, input);
  assert.equal(result.state, 'attached');
  assert.equal(result.task.status, 'done');
  assert.deepEqual(result.reference, { ...reference, taskId: 'task' });
  assert.deepEqual(taskReferences(f.store, 'company', 'task'), [result.reference]);
  assert.deepEqual(await lookupTaskReference(f.store, f.api, identity), result);
  assert.equal(rows(f.store).length, 2);
  const stored = f.store.operation(`task-reference:${digest(['company', 'crm', 'CASE-1'])}`);
  assert.equal(stored.taskId, 'task');
  assert.equal(stored.state, 'attached');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 4);
  for (const value of [result, taskReferences(f.store, 'company', 'task')]) {
    assert.doesNotMatch(JSON.stringify(value), /secret|authority|ownerKey|updatedAt|operationId/);
  }
});

test('duplicate attachments and all reads perform no writes, including another key and owner', async t => {
  const f = fixture(t);
  const result = await attachTaskReference(f.store, f.api, input);
  const before = rows(f.store), count = changes(f.store);
  assert.deepEqual(await attachTaskReference(f.store, f.api, input), result);
  assert.deepEqual(await attachTaskReference(f.store, f.api, { ...input, key: 'other' }, { authority: { kind: 'native', bindingId: 'other' } }), result);
  taskReferences(f.store, 'company', 'task');
  await lookupTaskReference(f.store, f.api, identity);
  assert.equal(await lookupTaskReference(f.store, f.api, { ...identity, externalId: 'unknown' }), null);
  assert.deepEqual(rows(f.store), before);
  assert.equal(changes(f.store), count);
});

test('company and namespace isolate identities, public refs are detached and ordered', async t => {
  const f = fixture(t);
  for (const [index, value] of [reference, { ...reference, namespace: 'support' }, { ...reference, companyId: 'another' }].entries()) {
    reserveTaskReference(f.store, value, `create-${index}`);
    finishTaskReference(f.store, value, `create-${index}`, 'task');
  }
  const refs = taskReferences(f.store, 'company', 'task');
  assert.equal(refs.length, 2);
  assert.deepEqual(new Set(refs.map(ref => ref.namespace)), new Set(['crm', 'support']));
  assert.equal(taskReferences(f.store, 'another', 'task').length, 1);
  assert.deepEqual(taskReferences(f.store, 'company', 'other-task'), []);
  const expected = structuredClone(refs);
  refs[0].url = 'https://changed.example';
  assert.deepEqual(taskReferences(f.store, 'company', 'task'), expected);
  f.state.task.companyId = 'another';
  assert.equal((await lookupTaskReference(f.store, f.api, { ...identity, companyId: 'another' })).task.companyId, 'another');
});

test('changed or missing URL and reassignment conflict rather than overwrite', async t => {
  const f = fixture(t);
  await attachTaskReference(f.store, f.api, input);
  const before = rows(f.store), count = changes(f.store);
  for (const value of [{ ...reference, url: 'https://other.example' }, identity]) {
    assert.throws(() => reserveTaskReference(f.store, value, 'another'), { code: 'task_reference_conflict' });
    await assert.rejects(attachTaskReference(f.store, f.api, { ...value, taskId: 'task', key: 'new' }), { code: 'task_reference_conflict' });
  }
  await assert.rejects(attachTaskReference(f.store, f.api, { ...input, taskId: 'other', key: 'new' }), { code: 'task_reference_conflict' });
  assert.deepEqual(rows(f.store), before);
  assert.equal(changes(f.store), count);
});

test('lookup and attach validate fresh backend company and identity, including duplicate reads', async t => {
  for (const mutation of [{ companyId: 'foreign' }, { id: 'foreign' }, { title: { token: 'secret' } }]) {
    const f = fixture(t);
    await attachTaskReference(f.store, f.api, input);
    Object.assign(f.state.task, mutation);
    // Let the stub return a mismatched identity rather than enforcing its path.
    const api = async () => structuredClone(f.state.task);
    const before = changes(f.store);
    await assert.rejects(lookupTaskReference(f.store, api, identity));
    await assert.rejects(attachTaskReference(f.store, api, input));
    await assert.rejects(attachTaskReference(f.store, api, { ...input, externalId: 'new', key: 'new' }));
    assert.equal(changes(f.store), before);
  }
});

test('attachment keys retain exact request and source but are isolated by durable owner', async t => {
  const f = fixture(t);
  const authority = { kind: 'native', bindingId: 'one', conversationId: 'chat', sessionCreatedAt: 1,
    sourceMessageId: 'message', sourceDigest: 'source', epoch: 'epoch', bindingRevision: 1 };
  await attachTaskReference(f.store, f.api, input, { authority });
  for (const change of [{ externalId: 'different' }, { taskId: 'different' }, { expectedRevision: 'different' }, { url: 'https://different.example' }]) {
    await assert.rejects(attachTaskReference(f.store, f.api, { ...input, ...change }, { authority }), { code: 'operation_conflict' });
  }
  for (const change of [{ sourceDigest: 'different' }, { sourceMessageId: 'different' }, { epoch: 'different' }, { bindingRevision: 2 }]) {
    await assert.rejects(attachTaskReference(f.store, f.api, input, { authority: { ...authority, ...change } }), { code: 'operation_conflict' });
  }
  await attachTaskReference(f.store, f.api, { ...input, externalId: 'another' }, { authority: { ...authority, bindingId: 'two' } });
  const journals = rows(f.store).filter(row => row.id.startsWith('task-reference-attach:')).map(row => JSON.parse(row.data));
  assert.equal(journals.length, 2);
  assert.deepEqual(journals[0].request.authority.bindingId === 'one' ? journals[0].request.authority : journals[1].request.authority, authority);
  assert.ok(journals.every(journal => journal.owner.sourceDigest === undefined));
});

test('optional revisions use human task inspection and exact retries ignore the now-stale revision', async t => {
  const f = fixture(t);
  const inspect = () => humanTask(f.store, f.api, { action: 'inspect', companyId: 'company', taskId: 'task' });
  const expectedRevision = (await inspect()).revision;
  await assert.rejects(attachTaskReference(f.store, f.api, { ...input, expectedRevision: 'stale' }), { code: 'stale_revision' });
  assert.equal(rows(f.store).length, 0);
  await attachTaskReference(f.store, f.api, { ...input, expectedRevision });
  const attached = await inspect();
  assert.notEqual(attached.revision, expectedRevision);
  assert.deepEqual(attached.task.references, [{ ...reference, taskId: 'task' }]);
  await assert.rejects(attachTaskReference(f.store, f.api,
    { ...input, key: 'another-reference', externalId: 'another-reference', expectedRevision }), { code: 'stale_revision' });
  f.state.task.title = 'Changed';
  assert.equal((await attachTaskReference(f.store, f.api, { ...input, expectedRevision })).task.title, 'Changed');
  await assert.rejects(attachTaskReference(f.store, f.api, { ...input, key: 'new', externalId: 'new', expectedRevision }), { code: 'stale_revision' });
});

test('authority callbacks surround awaits and transaction writes, even when a read fails', async t => {
  for (const failure of ['before', 'after', 'transaction', 'read-fails']) {
    const f = fixture(t);
    let valid = failure !== 'before', checks = 0;
    const check = () => { checks++; assert.ok(valid, 'authority revoked'); };
    if (['after', 'read-fails'].includes(failure)) f.state.hook = () => {
      valid = false;
      if (failure === 'read-fails') throw new Error('lost read');
    };
    if (failure === 'transaction') {
      const transaction = f.store.transaction.bind(f.store);
      f.store.transaction = fn => { valid = false; return transaction(fn); };
    }
    await assert.rejects(attachTaskReference(f.store, f.api, input, { check }), /authority revoked/);
    assert.equal(rows(f.store).length, 0);
    assert.ok(checks >= (failure === 'before' ? 1 : 3));
  }
});

test('a concurrent new reference invalidates revision-guarded attachment', async t => {
  const f = fixture(t);
  const { revision } = await humanTask(f.store, f.api, { action: 'inspect', companyId: 'company', taskId: 'task' });
  f.state.hook = (method, path) => {
    if (!path.endsWith('/interactions')) return;
    const other = { ...reference, externalId: 'concurrent' };
    reserveTaskReference(f.store, other, 'concurrent-owner');
    finishTaskReference(f.store, other, 'concurrent-owner', 'task');
  };
  await assert.rejects(attachTaskReference(f.store, f.api, { ...input, expectedRevision: revision }), { code: 'stale_revision' });
  assert.deepEqual(taskReferences(f.store, 'company', 'task').map(value => value.externalId), ['concurrent']);
});

test('reference and journal commit atomically, with safe retries after local failure', async t => {
  const f = fixture(t);
  const save = f.store.saveOperation.bind(f.store);
  f.store.saveOperation = operation => {
    if (operation.id.startsWith('task-reference-attach:')) throw new Error('journal failed');
    return save(operation);
  };
  await assert.rejects(attachTaskReference(f.store, f.api, input), /journal failed/);
  assert.equal(rows(f.store).length, 0);
  f.store.saveOperation = save;
  await attachTaskReference(f.store, f.api, input);
  assert.equal(rows(f.store).length, 2);
});

test('overlapping attachment creators cannot overwrite a reference or reuse a journal key', async t => {
  for (const sameKey of [false, true]) {
    const f = fixture(t);
    const api = async (method, path) => {
      assert.equal(method, 'GET');
      await new Promise(resolve => setImmediate(resolve));
      return { ...f.state.task, id: decodeURIComponent(path.split('/').at(-1)) };
    };
    const results = await Promise.allSettled([
      attachTaskReference(f.store, api, input),
      attachTaskReference(f.store, api, { ...input, taskId: 'other', key: sameKey ? input.key : 'other' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, sameKey ? 'operation_conflict' : 'task_reference_conflict');
    assert.equal(rows(f.store).length, 2);
  }
  const f = fixture(t);
  const results = await Promise.all([attachTaskReference(f.store, f.api, input), attachTaskReference(f.store, f.api, input)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(rows(f.store).length, 2);
  assert.equal(changes(f.store), 2);
});

test('reservations survive restart and uncertain creation, with no reassignment or implicit release', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-references-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite');
  const store = new Store(file);
  const reserved = reserveTaskReference(store, reference, 'create-owner');
  assert.deepEqual(reserved, { state: 'reserved', ...reference, taskId: null });
  store.close();
  const f = fixture(t, file);
  const before = changes(f.store);
  assert.deepEqual(reserveTaskReference(f.store, reference, 'create-owner'), reserved);
  assert.deepEqual(await lookupTaskReference(f.store, f.api, identity), { state: 'reserved', reference: { ...reference, taskId: null } });
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual(taskReferences(f.store, 'company', 'task'), []);
  assert.throws(() => reserveTaskReference(f.store, reference, 'another-owner'), { code: 'task_reference_reserved' });
  assert.throws(() => finishTaskReference(f.store, reference, 'another-owner', 'other'), { code: 'task_reference_reserved' });
  await assert.rejects(attachTaskReference(f.store, f.api, input), { code: 'task_reference_reserved' });
  assert.equal(changes(f.store), before);
  const finished = finishTaskReference(f.store, reference, 'create-owner', 'task');
  const after = changes(f.store);
  assert.deepEqual(finishTaskReference(f.store, reference, 'create-owner', 'task'), finished);
  assert.deepEqual(reserveTaskReference(f.store, reference, 'new-creator'), finished);
  assert.throws(() => finishTaskReference(f.store, reference, 'create-owner', 'other'), { code: 'task_reference_conflict' });
  assert.throws(() => finishTaskReference(f.store, reference, 'new-creator', 'task'), { code: 'task_reference_reserved' });
  assert.throws(() => finishTaskReference(f.store, { ...reference, url: 'https://other.example' }, 'create-owner', 'task'), { code: 'task_reference_conflict' });
  assert.equal(changes(f.store), after);
  assert.equal((await lookupTaskReference(f.store, f.api, identity)).task.status, 'done');
});

test('independent SQLite connections race to reserve one identity for concurrent creators', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-reference-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite');
  const f = fixture(t, file);
  const gate = new SharedArrayBuffer(4);
  const workers = [1, 2].map(number => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { Store } = await import(workerData.storeModule);
      const { reserveTaskReference } = await import(workerData.referenceModule);
      const store = new Store(workerData.file);
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try { parentPort.postMessage({ result: reserveTaskReference(store, workerData.reference, workerData.owner) }); }
      catch (error) { parentPort.postMessage({ code: error.code }); }
      finally { store.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { file, gate, reference, owner: `creator-${number}`,
    storeModule: new URL('../src/store.mjs', import.meta.url).href,
    referenceModule: new URL('../src/task-references.mjs', import.meta.url).href } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  let ready = 0;
  const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', value => {
      if (value !== 'ready') return resolve(value);
      if (++ready === workers.length) {
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
      }
    });
  })));
  assert.equal(results.filter(value => value.result?.state === 'reserved').length, 1);
  assert.equal(results.filter(value => value.code === 'task_reference_reserved').length, 1);
  assert.equal(rows(f.store).length, 1);
});

test('integrated creation retries the same backend key after committed or uncommitted lost responses', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'task-reference-create-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const committed of [false, true]) {
    const file = join(directory, `${committed}.sqlite`);
    let store = new Store(file);
    const created = new Map(), bodies = [];
    let fail = true;
    const api = async (method, path, body) => {
      if (method === 'GET') return { id: 'company' };
      assert.equal(method, 'POST');
      assert.equal(path, '/api/companies/company/issues');
      bodies.push(structuredClone(body));
      if (committed || !fail) created.set(body.idempotencyKey,
        created.get(body.idempotencyKey) ?? { id: `task-${created.size}`, companyId: 'company' });
      if (fail) throw new Error('lost create response');
      return created.get(body.idempotencyKey);
    };
    const create = async ownerKey => {
      const reserved = reserveTaskReference(store, reference, ownerKey);
      if (reserved.state === 'attached') return reserved;
      const operation = await createOperatorTask(store, api,
        { companyId: 'company', key: ownerKey, payload: { title: 'Follow-up' } });
      return finishTaskReference(store, reference, ownerKey, operation.receipt.id);
    };
    try {
      await assert.rejects(create('owner'), /lost create response/);
      store.close();
      store = new Store(file);
      await assert.rejects(create('different-owner'), { code: 'task_reference_reserved' });
      fail = false;
      const result = await create('owner');
      assert.equal(result.taskId, 'task-0');
      assert.equal(created.size, 1);
      assert.deepEqual(bodies[0], bodies[1]);
      const before = changes(store);
      assert.deepEqual(await create('later-owner'), result);
      assert.equal(bodies.length, 2);
      assert.equal(changes(store), before);
    } finally { store.close(); }
  }
});

test('arbitrary fields, undefined optionals, invalid identity and unsafe URLs are rejected before writes', async t => {
  const f = fixture(t);
  const invalid = [null, [], {}, ...['companyId', 'namespace', 'externalId'].flatMap(field => ['', ' ', null, 42].map(value => ({ ...reference, [field]: value }))),
    ...['engagement', 'dueAt', 'createdAt', 'taskId', 'ownerKey', 'authority', 'token', 'status'].map(field => ({ ...reference, [field]: 'injected' })),
    ...[undefined, null, '', 'relative', 'javascript:alert(1)', 'file:///tmp/x', 'https://user:password@example.com', ' https://example.com'].map(url => ({ ...reference, url }))];
  for (const value of invalid) {
    assert.throws(() => reserveTaskReference(f.store, value, 'owner'), { code: 'invalid_request' });
    assert.throws(() => finishTaskReference(f.store, value, 'owner', 'task'), { code: 'invalid_request' });
  }
  for (const field of ['engagement', 'dueAt', 'createdAt', 'ownerKey', 'authority', 'token', 'payload', 'idempotencyKey']) {
    await assert.rejects(attachTaskReference(f.store, f.api, { ...input, [field]: 'injected' }), { code: 'invalid_request' });
    await assert.rejects(lookupTaskReference(f.store, f.api, { ...identity, [field]: 'injected' }), { code: 'invalid_request' });
  }
  for (const value of [{ ...input, key: '' }, { ...input, taskId: '' }, { ...input, expectedRevision: undefined }, { ...input, expectedRevision: 3 }]) {
    await assert.rejects(attachTaskReference(f.store, f.api, value), { code: 'invalid_request' });
  }
  assert.throws(() => reserveTaskReference(f.store, reference, ''), { code: 'invalid_request' });
  assert.throws(() => finishTaskReference(f.store, reference, 'owner', 'task'), { code: 'task_reference_not_reserved' });
  assert.equal(rows(f.store).length, 0);
  assert.equal(f.state.calls.length, 0);
});
