import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { BackendStore } from '../src/backend-store.mjs';
import { compactBackendDatabase, compactNodeDatabase, isEphemeralPresenceEvent, isEphemeralPresenceReceipt } from '../src/database-compact.mjs';
import { executionCliInvocation, readOnlyCliInvocation } from '../src/native-cli-surface.mjs';
import { NodeJournal } from '../src/node-journal.mjs';
import { nodeResourceStore } from '../src/node-resources.mjs';
import { digest } from '../src/protocol.mjs';
import { serviceLock } from '../src/service-lock.mjs';

const owner = { type: 'user', id: 'owner' }, node = { type: 'node', id: 'node' };
const at = '2026-11-24T08:00:00.000Z', padding = 'presence'.repeat(200);
const nodeIdentity = { nodeId: node.id, instanceId: 'instance' };
const noArtifacts = { strandedCandidates: [], retainedOriginals: [] };
const heartbeat = { id: node.id, name: 'Node', revision: 1, lastSeenAt: at };
const presenceHeartbeat = event('heartbeat', 'node.heartbeat', heartbeat);
const presenceAdvert = event('advertise', 'agent.advertise', { id: 'agent', nodeId: node.id, revision: 2, availability: 'available', lastSeenAt: at });
const impossibleDate = '2026-02-30T08:00:00.000Z';
const ambiguousEvents = ['{"type":"agent.advertise","type":"task.create"}', '{"type":"node.heartbeat"}\0junk',
  '{"type":"node.heartbeat"}', JSON.stringify({ ...presenceAdvert, entityId: 'other-agent' }),
  JSON.stringify({ ...presenceHeartbeat, revision: 2 }),
  JSON.stringify({ ...presenceHeartbeat, data: { ...heartbeat, lastSeenAt: {} } }),
  JSON.stringify({ ...presenceAdvert, data: { ...presenceAdvert.data, availability: 'impossible' } }),
  JSON.stringify({ ...presenceHeartbeat, at: impossibleDate }),
  JSON.stringify({ ...presenceAdvert, data: { ...presenceAdvert.data, lastSeenAt: impossibleDate } })];
const execute = promisify(execFile), cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const filesFor = path => ['', '-wal', '-shm'].map(suffix => path + suffix).filter(existsSync);
const captureFiles = path => filesFor(path).map(file => [file, statSync(file).ino, readFileSync(file)]);
const query = (db, sql) => db.prepare(sql).all();
const schema = db => query(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name');
const rows = (db, table, clause = '') => query(db, `SELECT * FROM ${table} ${clause} ORDER BY rowid`);
const snapshotTables = (db, exclude) => Object.fromEntries(query(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
  .filter(({ name }) => !exclude.includes(name)).map(({ name }) => [name, rows(db, name)]));
const verifyWorkspace = (dir, database, backups = []) => {
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith(database)).sort(), [database, ...backups]);
  assert.equal(statSync(join(dir, database)).mode & 0o777, 0o600);
};

function verifyRetiredOriginal(path, [, inode, bytes]) {
  assert.equal(statSync(path).ino, inode);
  assert.equal(statSync(path).mode & 0o7777, 0o600);
  const retired = readFileSync(path);
  assert.deepEqual([...retired.subarray(18, 20)], [1, 1]); // Rollback journal read/write versions.
  // Journal mode, change counter and version-valid-for may change when SQLite
  // retires WAL. No other original bytes may change in the fixture.
  for (const [offset, width] of [[18, 2], [24, 4], [92, 4]]) bytes.copy(retired, offset, offset, offset + width);
  assert.deepEqual(retired, bytes);
}

function directory(t) {
  const dir = mkdtempSync(join(process.env.RELAY_TEST_SCRATCH ?? '/tmp/opencode', 'relay-compaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function inspect(path, fn) {
  const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

function event(id, type, data) {
  return { id, type, entityId: data.id, revision: data.revision, at, actor: node, data };
}

test('presence receipt classifier also proves the original action and payload by SHA-256', () => {
  const heartbeat = { id: node.id, name: 'Node', lastSeenAt: at };
  const advert = { id: 'agent', expectedRevision: 1, availability: 'available' };
  const advertisement = { id: advert.id, nodeId: node.id, revision: 2, availability: advert.availability, bindingRevision: 3, conversationId: 'conversation' };
  const observation = { ...advertisement, id: 'observed_12abc', capabilities: ['observation_only'] };
  const heartbeatHash = digest({ action: 'node.heartbeat', payload: { id: node.id } });
  const advertHash = payload => digest({ action: 'agent.advertise', payload });
  const observationHash = advertHash({ ...advert, id: observation.id, conversationId: observation.conversationId });
  const check = (actor, key, value, hash = heartbeatHash) => isEphemeralPresenceReceipt(actor, key, hash, JSON.stringify(value));
  assert.equal(check('node:node', 'heartbeat:1', heartbeat), true);
  const machine = { platform: 'linux', hostname: 'node' };
  assert.equal(check('node:node', 'heartbeat:1', { ...heartbeat, machine }, digest({ action: 'node.heartbeat', payload: { id: node.id, machine } })), true);
  for (const extra of [{}, { bindingRevision: 3 }, { conversationId: 'conversation' }, { bindingRevision: 3, conversationId: 'conversation' }]) {
    assert.equal(check('node:node', 'advertise:agent:198772', advertisement, advertHash({ ...advert, ...extra })), true);
  }
  assert.equal(check('node:node', 'observe:observed_12abc:32', observation, observationHash), true);
  assert.equal(check('node:node', 'observe:observed_12abc:32', observation, digest({ action: 'agent.register', payload: observation })), false);
  assert.equal(check('node:node', 'advertise:agent:1', advertisement, advertHash({ ...advert, bindingRevision: 4 })), false);
  assert.equal(check('node:node', 'advertise:agent:1', { ...advertisement, deletedAt: at }, advertHash(advert)), false);
  assert.equal(check('node:node', 'heartbeat:1', heartbeat, 'a'.repeat(64)), false);
  for (const key of ['task.create', 'task-create-1', 'heartbeat-custom', 'task_attachment.attach', 'agent.enrol', 'agent.attach', 'agent.rename',
    'agent.delete', 'node.enrol', 'execution.request', 'schedule.install', 'credential.issue', 'grant.request', 'message.send', 'owner_message.send',
    'heartbeat:-1', 'heartbeat:1:2', 'heartbeat:1\n']) assert.equal(check('node:node', key, heartbeat), false, key);
  for (const [actor, key, value, hash] of [
    ['user:node', 'heartbeat:1', heartbeat], ['node:other', 'heartbeat:1', heartbeat], [null, 'heartbeat:1', heartbeat],
    ['node:node', null, heartbeat], ['node:node', 'heartbeat:1', { ...heartbeat, lastSeenAt: undefined }],
    ['node:node', 'heartbeat:1', { ...heartbeat, name: false }], ['node:node', 'advertise::1', advertisement, advertHash(advert)],
    ['node:node', 'advertise:agent:1', { ...advertisement, availability: 1 }, advertHash(advert)],
    ['node:node', 'observe:observed_A:1', observation, observationHash], ['node:node', 'observe:observed_a:1', { ...observation, capabilities: 'observation_only' }, observationHash],
    ['node:node', 'observe:observed_a:1', { ...observation, capabilities: ['other'] }, observationHash],
    ['node:other', 'observe:observed_a:1', observation, observationHash], ['node:node', 'heartbeat:1', null],
  ]) assert.equal(check(actor, key, value, hash), false, `${actor} ${key} ${JSON.stringify(value)}`);
  for (const malformed of ['{broken', `${JSON.stringify(heartbeat)}\0junk`]) {
    assert.equal(isEphemeralPresenceReceipt('node:node', 'heartbeat:1', heartbeatHash, malformed), false);
  }
});

test('event classifier retains ambiguous contents, including encoded duplicate keys', () => {
  assert.equal(isEphemeralPresenceEvent(JSON.stringify(presenceAdvert), 'agent.advertise'), true);
  assert.equal(isEphemeralPresenceEvent(JSON.stringify(presenceHeartbeat), 'node.heartbeat'), true);
  const sameType = JSON.stringify(presenceHeartbeat).replace('"type":"node.heartbeat"', '"type":"node.heartbeat","t\\u0079pe":"node.heartbeat"');
  const duplicateDataKey = JSON.stringify(presenceHeartbeat).replace('"name":"Node"', '"name":"Node","name":"Node"');
  for (const raw of [...ambiguousEvents, '{"type":"task.create","type":"agent.advertise"}',
    sameType, duplicateDataKey, '[]', 'null', '{not JSON']) {
    assert.equal(isEphemeralPresenceEvent(raw), false, raw);
  }
  for (const record of [
    { ...presenceHeartbeat, at: '2026-11-24T08:00:00Z' },
    { ...presenceHeartbeat, data: { ...heartbeat, name: ' \t' } },
    { ...presenceHeartbeat, data: { ...heartbeat, lastSeenAt: '2026-99-24T08:00:00.000Z' } },
    { ...presenceAdvert, data: { ...presenceAdvert.data, lastSeenAt: null } },
    { ...presenceAdvert, data: { ...presenceAdvert.data, deletedAt: at } },
  ]) assert.equal(isEphemeralPresenceEvent(JSON.stringify(record)), false);
  assert.equal(isEphemeralPresenceEvent(JSON.stringify(presenceAdvert), 'node.heartbeat'), false);
});

test('backend compaction preserves the complete durable ledger and a node cursor at the trailing legacy sequence', async t => {
  const dir = directory(t), path = join(dir, 'backend.sqlite'), store = new BackendStore(path);
  const journal = new NodeJournal(join(dir, 'node.sqlite'), { nodeId: node.id, instanceId: store.instance });
  t.after(() => journal.close());
  let sourceSchema, durableTables, durableChanges, durableReceipts, presenceAnchor;
  const legacyChanges = 4900, legacyReceipts = legacyChanges * 3;
  let token, registerReceipt;
  try {
    const command = (actor, key, action, payload) => store.command(actor, { key, action, payload });
    token = store.bootstrap().token;
    command(owner, 'node-enrol', 'node.enrol', { id: node.id, name: 'Node' });
    const nodeCredential = store.enrolCredential(owner, node.id, 'node-credential');
    assert.ok(nodeCredential.token);
    command(node, 'agent-register', 'agent.register', { id: 'agent', nodeId: node.id, directory: '/workspace', name: 'Agent', mode: 'interactive' });
    command(node, 'observe:observed_ab:1', 'agent.register', { id: 'observed_ab', nodeId: node.id, name: 'Observed agent',
      mode: 'interactive', capabilities: ['observation_only'] });
    registerReceipt = store.db.prepare("SELECT * FROM receipts WHERE actor='node:node' AND key='observe:observed_ab:1'").get();
    assert.ok(registerReceipt);
    const task = command(owner, 'task-create-1', 'task.create', { id: 'task', title: 'Original task', reference: 'REL-1' });
    store.db.prepare('INSERT INTO task_aliases VALUES (?,?,?)').run('linear:team', 'DEF-32', task.id);
    const bytes = Buffer.from('durable content'), sha256 = createHash('sha256').update(bytes).digest('hex');
    await store.blobs.putStream(sha256, Readable.from([bytes]), { expectedSize: bytes.length });
    command(owner, 'task-attach', 'task.attach', { taskId: task.id, name: 'report.txt', sha256, size: bytes.length });
    command(owner, 'execution-request', 'execution.request', { id: 'exec', taskId: task.id, taskRevision: task.revision,
      targetAgentId: 'agent', instructions: 'Complete the task' });
    command(owner, 'schedule-install', 'schedule.install', { id: 'schedule', definition: { nodeId: node.id, targetAgentId: 'agent',
      instructions: 'Check again', at, enabled: true } });

    const receipt = store.db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?)');
    const change = store.db.prepare('INSERT INTO changes(seq,id,at,data) VALUES (?, ?, ?, ?)');
    store.transaction(() => {
      receipt.run('node:node', 'heartbeat-custom', 'custom', JSON.stringify({ id: node.id, name: 'Node', lastSeenAt: at }));
      receipt.run('node:node', 'heartbeat:1', 'wrong-node', JSON.stringify({ id: 'other', name: 'Node', lastSeenAt: at }));
      receipt.run('node:node', 'heartbeat:2', 'malformed', '{invalid json');
      receipt.run('node:node', 'advertise:agent:3', 'wrong-shape', JSON.stringify({ nodeId: node.id, state: 'available' }));
      receipt.run('node:node', 'observe:observed_abcd:4', 'not-observation', JSON.stringify({ nodeId: node.id, capabilities: ['other'] }));
      store.db.exec('UPDATE changes SET seq=100 WHERE seq=(SELECT MAX(seq) FROM changes)');
      // This record must survive, even though it has no $.type.
      change.run(99, 'type-less', at, '{ "legacyEnvelope": true }');
      for (const [i, raw] of ambiguousEvents.entries()) change.run(90 + i, `ambiguous-${i}`, at, raw);
    });
    durableTables = snapshotTables(store.db, ['changes', 'receipts']);
    durableChanges = rows(store.db, 'changes');
    durableReceipts = rows(store.db, 'receipts');
    store.transaction(() => {
      for (let seq = 101; seq <= 5000; seq++) {
        const heartbeat = { id: node.id, name: 'Node', revision: 1, lastSeenAt: at, padding };
        const advert = { id: 'agent', nodeId: node.id, revision: 2, availability: 'available', lastSeenAt: at, bindingRevision: 1, conversationId: 'conversation', padding };
        const observed = { ...advert, id: 'observed_abcd', capabilities: ['observation_only'] };
        change.run(seq, `legacy-${seq}`, at, JSON.stringify(seq % 2 === 0 ? event(`legacy-${seq}`, 'node.heartbeat', heartbeat) :
          event(`legacy-${seq}`, 'agent.advertise', seq % 3 === 0 ? advert : observed)));
        receipt.run('node:node', `heartbeat:${seq}`, digest({ action: 'node.heartbeat', payload: { id: node.id } }), JSON.stringify(heartbeat));
        receipt.run('node:node', `advertise:agent:${seq}`, digest({ action: 'agent.advertise', payload: { id: advert.id,
          expectedRevision: 1, availability: advert.availability, bindingRevision: advert.bindingRevision, conversationId: advert.conversationId } }), JSON.stringify(advert));
        receipt.run('node:node', `observe:observed_abcd:${seq}`, digest({ action: 'agent.advertise', payload: { id: observed.id,
          expectedRevision: 1, availability: observed.availability, conversationId: observed.conversationId } }), JSON.stringify(observed));
      }
    });
    presenceAnchor = store.db.prepare('SELECT * FROM changes WHERE seq=5000').get();
    assert.equal(JSON.parse(presenceAnchor.data).type, 'node.heartbeat');
    store.db.exec('ANALYZE');
    sourceSchema = schema(store.db);
    assert.equal(Number(store.db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx='changes_at'").get().stat.split(' ')[0]), durableChanges.length + legacyChanges);
    journal.reconcileSnapshot(store.snapshot());
  } finally { store.close(); }

  const cursor = journal.cursor();
  assert.deepEqual(JSON.parse(Buffer.from(cursor, 'base64url')), { instance: store.instance, after: 5000 });
  const files = captureFiles(path), dirBefore = readdirSync(dir);
  const counts = { entitiesCount: durableTables.entities.length, changesTotal: durableChanges.length + legacyChanges, changesRemovable: legacyChanges - 1,
    changesRetained: durableChanges.length + 1, receiptsTotal: durableReceipts.length + legacyReceipts, receiptsRemovable: legacyReceipts,
    receiptsRetained: durableReceipts.length, highWaterSeq: 5000 };
  assert.deepEqual(compactBackendDatabase({ stateDir: dir }), { state: 'compact_plan', database: path,
    role: 'backend', schema: 2, applied: false, sizeBytes: statSync(path).size, ...counts, ...noArtifacts });
  assert.deepEqual(captureFiles(path), files);
  assert.deepEqual(readdirSync(dir), dirBefore);

  const unlock = serviceLock(dir);
  try { assert.throws(() => compactBackendDatabase({ stateDir: dir, apply: true }), { code: 'already_running', status: 409 }); }
  finally { unlock(); }
  const marker = join(dir, 'maintenance.json');
  writeFileSync(marker, '{}');
  assert.throws(() => compactBackendDatabase({ stateDir: dir, apply: true }), { code: 'maintenance_active', status: 409 });
  assert.deepEqual(captureFiles(path), files);
  rmSync(marker);

  const result = compactBackendDatabase({ stateDir: dir, apply: true });
  const { bytesBefore, bytesAfter, bytesReclaimed, sizeReductionBytes } = result;
  assert.deepEqual(result, { state: 'compacted', database: path, role: 'backend', schema: 2, applied: true,
    bytesBefore, bytesAfter, bytesReclaimed, sizeReductionBytes, originalRetained: false, keptOriginalPath: null, ...counts, ...noArtifacts });
  assert.ok(bytesBefore > bytesAfter * 30);
  assert.equal(bytesReclaimed, bytesBefore - bytesAfter);
  assert.equal(bytesReclaimed, sizeReductionBytes);
  verifyWorkspace(dir, 'backend.sqlite');
  inspect(path, db => {
    assert.deepEqual(schema(db), sourceSchema);
    assert.deepEqual(snapshotTables(db, ['changes', 'receipts']), durableTables);
    assert.deepEqual(rows(db, 'changes'), [...durableChanges, presenceAnchor]);
    assert.deepEqual(rows(db, 'receipts'), durableReceipts);
    assert.deepEqual(db.prepare("SELECT * FROM receipts WHERE actor='node:node' AND key='observe:observed_ab:1'").get(), registerReceipt);
    assert.deepEqual(rows(db, 'changes', "WHERE id LIKE 'ambiguous-%'").map(row => row.data), ambiguousEvents);
    assert.equal(Number(db.prepare("SELECT stat FROM sqlite_stat1 WHERE idx='changes_at'").get().stat.split(' ')[0]), counts.changesRetained);
    assert.deepEqual(query(db, 'SELECT name, seq FROM sqlite_sequence').map(({ name, seq }) => [name, seq]), [['changes', 5000]]);
  });

  const compacted = new BackendStore(path);
  try {
    assert.equal(compacted.authenticate(token).id, owner.id);
    assert.deepEqual(compacted.events({ cursor }).items, []);
    // 0.3.0 uses this bound in the otherwise identical events cursor guard.
    const legacyBound = t.mock.method(compacted, 'highWaterSeq', () =>
      compacted.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM changes').get().seq);
    assert.equal(compacted.highWaterSeq(), 5000);
    assert.deepEqual(compacted.events({ cursor }).items, []);
    legacyBound.mock.restore();
    const poll = () => journal.poll(async (method, request) => {
      assert.equal(method, 'GET');
      const url = new URL(request, 'http://relay');
      assert.equal(url.pathname, '/v1/events');
      return compacted.events({ cursor: url.searchParams.get('cursor') });
    });
    await poll();
    assert.equal(journal.cursor(), cursor);
    const next = compacted.command(owner, { key: 'task-create-2', action: 'task.create', payload: { id: 'next', title: 'New task' } });
    assert.equal(next.reference, 'REL-2');
    assert.equal(compacted.db.prepare('SELECT MAX(seq) AS seq FROM changes').get().seq, 5001);
    await poll();
    assert.deepEqual(JSON.parse(Buffer.from(journal.cursor(), 'base64url')), { instance: store.instance, after: 5001 });
    assert.deepEqual(journal.cached('task').find(row => row.entity.id === 'next').entity, next);
  } finally { compacted.close(); }
});

test('backend compaction removes all earlier presence rows when the tail is durable', t => {
  const dir = directory(t), path = join(dir, 'backend.sqlite'), store = new BackendStore(path);
  try {
    const insert = store.db.prepare('INSERT INTO changes(seq,id,at,data) VALUES (?, ?, ?, ?)');
    for (const [seq, envelope] of [[10, presenceHeartbeat], [20, presenceAdvert]]) {
      insert.run(seq, envelope.id, at, JSON.stringify(envelope));
    }
    store.command(owner, { key: 'task-tail', action: 'task.create', payload: { id: 'task', title: 'Durable tail' } });
    // Also cover the read-only plan path for a database with committed WAL frames.
    const plan = compactBackendDatabase({ stateDir: dir });
    assert.deepEqual([plan.changesTotal, plan.changesRemovable, plan.changesRetained, plan.highWaterSeq], [3, 2, 1, 21]);
  } finally { store.close(); }

  const result = compactBackendDatabase({ stateDir: dir, apply: true });
  assert.deepEqual([result.changesTotal, result.changesRemovable, result.changesRetained, result.highWaterSeq], [3, 2, 1, 21]);
  inspect(path, db => assert.deepEqual(rows(db, 'changes').map(row => [row.seq, JSON.parse(row.data).type]), [[21, 'task.create']]));
});

test('backend compaction preserves an already divergent SQLite high-water mark without inventing an event', t => {
  const dir = directory(t), path = join(dir, 'backend.sqlite'), store = new BackendStore(path);
  let cursor;
  try {
    store.command(owner, { key: 'task-tail', action: 'task.create', payload: { id: 'task', title: 'Externally truncated' } });
    cursor = store.snapshot().cursor;
    store.db.exec('DELETE FROM changes');
  } finally { store.close(); }
  const result = compactBackendDatabase({ stateDir: dir, apply: true });
  assert.equal(result.changesRetained, 0);
  assert.equal(result.highWaterSeq, 1);
  inspect(path, db => {
    assert.equal(db.prepare('SELECT MAX(seq) AS seq FROM changes').get().seq, null);
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'").get().seq, 1);
  });
  const compacted = new BackendStore(path);
  try { assert.deepEqual(compacted.events({ cursor }).items, []); }
  finally { compacted.close(); }
});

for (const keepOriginal of [false, true]) test(`node compaction preserves every local table (${keepOriginal ? 'keep original' : 'reclaim immediately'})`, t => {
  const dir = directory(t), path = join(dir, 'node.sqlite'), journal = new NodeJournal(path, nodeIdentity);
  let tables, inbox, sourceSchema;
  const legacyInbox = 6200;
  try {
    journal.consume({ cursor: 'original-cursor', items: [event('task-event', 'task.create', { id: 'task', revision: 1, reference: 'REL-1' }),
      event('execution-event', 'execution.request', { id: 'exec', runId: 'run', revision: 1, targetNodeId: node.id }),
      event('notice-event', 'question.ask', { id: 'question', revision: 1, prompt: 'Question?', addressedTo: { type: 'agent', id: 'agent' } })] });
    journal.queue({ key: 'queued', action: 'execution.admit', payload: { id: 'exec' } });
    journal.archive({ ...journal.work('exec'), invocation: { runId: 'run' } });
    const resources = nodeResourceStore(journal);
    resources.saveOperation({ id: 'op', state: 'applied', details: { path: '/workspace' } });
    journal.db.exec(`INSERT INTO schedules VALUES ('schedule', '{"definition":{"revision":1}}');
      INSERT INTO occurrences VALUES ('occurrence', 'schedule', 'completed', '{"id":"occurrence"}');
      INSERT INTO local_notifications VALUES ('local', '{"id":"local"}');
      INSERT INTO inbox(rowid,id,data) VALUES (-9223372036854775808, 'malformed', '{not valid json');
      CREATE TABLE extra (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, bytes BLOB);
      INSERT INTO extra VALUES (-1, 'left' || char(0) || 'right', x'0001ff'), (101, 'deleted id', x'ff');
      DELETE FROM extra WHERE id=101;`);
    for (const [i, raw] of ambiguousEvents.entries()) journal.db.prepare('INSERT INTO inbox VALUES (?, ?)').run(`ambiguous-${i}`, raw);
    tables = snapshotTables(journal.db, ['inbox']);
    inbox = rows(journal.db, 'inbox');
    sourceSchema = schema(journal.db);
    const insert = journal.db.prepare('INSERT INTO inbox VALUES (?, ?)');
    journal.transaction(() => {
      for (let i = 0; i < legacyInbox; i++) {
        const presence = i % 2 === 0 ? presenceHeartbeat : presenceAdvert;
        insert.run(`legacy-${i}`, JSON.stringify({ ...presence, id: `legacy-${i}`, data: { ...presence.data, padding } }));
      }
    });
  } finally { journal.close(); }

  const counts = { inboxTotal: inbox.length + legacyInbox, inboxRemovable: legacyInbox, inboxRetained: inbox.length,
    workCount: tables.work.length, outboxCount: tables.outbox.length, schedulesCount: tables.schedules.length,
    noticesCount: tables.notices.length, cachedEntitiesCount: tables.cached_entities.length };
  const before = captureFiles(path);
  const configFile = join(dir, 'node.json');
  writeFileSync(configFile, JSON.stringify({ stateDirectory: dir }), { mode: 0o600 });
  assert.deepEqual(compactNodeDatabase({ configFile }), { state: 'compact_plan', role: 'node', database: path, schema: 1, applied: false,
    sizeBytes: statSync(path).size, ...counts, ...noArtifacts });
  const unlock = serviceLock(dir);
  try { assert.throws(() => compactNodeDatabase({ configFile, apply: true }), { code: 'already_running', status: 409 }); }
  finally { unlock(); }
  assert.deepEqual(captureFiles(path), before);

  const result = compactNodeDatabase({ configFile, apply: true, keepOriginal });
  const { bytesBefore, bytesAfter, bytesReclaimed, sizeReductionBytes, keptOriginalPath } = result;
  assert.deepEqual(result, { state: 'compacted', role: 'node', database: path, schema: 1, applied: true,
    bytesBefore, bytesAfter, bytesReclaimed, sizeReductionBytes, originalRetained: keepOriginal, keptOriginalPath,
    ...counts, ...noArtifacts, retainedOriginals: keepOriginal ? [keptOriginalPath] : [] });
  assert.ok(bytesBefore > bytesAfter * 30);
  assert.equal(sizeReductionBytes, bytesBefore - bytesAfter);
  assert.equal(bytesReclaimed, keepOriginal ? 0 : sizeReductionBytes);
  if (keepOriginal) {
    assert.ok(keptOriginalPath.startsWith(path + '.pre-compact-'));
    verifyRetiredOriginal(keptOriginalPath, before[0]);
    inspect(keptOriginalPath, db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, counts.inboxTotal));
  } else assert.equal(keptOriginalPath, null);
  verifyWorkspace(dir, 'node.sqlite', keepOriginal ? [keptOriginalPath.slice(dir.length + 1)] : []);
  inspect(path, db => {
    assert.deepEqual(schema(db), sourceSchema);
    assert.deepEqual(snapshotTables(db, ['inbox']), tables);
    assert.deepEqual(rows(db, 'inbox'), inbox);
    assert.deepEqual(rows(db, 'inbox', "WHERE id LIKE 'ambiguous-%'").map(row => row.data), ambiguousEvents);
    assert.equal(db.prepare('SELECT hex(data) AS data FROM extra').get().data, '6C656674007269676874');
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='extra'").get().seq, 101);
  });
  const reopened = new NodeJournal(path, nodeIdentity);
  try {
    assert.equal(reopened.cursor(), 'original-cursor');
    assert.equal(reopened.work('exec').execution.runId, 'run');
    assert.equal(nodeResourceStore(reopened).operation('op').state, 'applied');
  } finally { reopened.close(); }
});

test('compaction refuses symlinked paths, unsafe directory permissions, and unsupported schemas', t => {
  const dir = directory(t), target = join(dir, 'target.sqlite'), source = join(dir, 'backend.sqlite');
  new BackendStore(target).close();
  const before = captureFiles(target);
  const compact = (stateDir = dir, apply = false) => compactBackendDatabase({ stateDir, apply });
  symlinkSync(target, source);
  for (const apply of [false, true]) assert.throws(() => compact(dir, apply), { code: 'invalid_database', status: 400 });
  assert.deepEqual(captureFiles(target), before);
  assert.equal(existsSync(join(dir, 'service-lock.sqlite')), false);
  rmSync(source);
  new BackendStore(source).close();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    symlinkSync(target, source + suffix);
    for (const apply of [false, true]) assert.throws(() => compact(dir, apply), { code: 'invalid_database', status: 400 });
    rmSync(source + suffix);
  }
  const dirAlias = join(dir, 'alias');
  symlinkSync(dir, dirAlias);
  mkdirSync(join(dir, 'inner'), { mode: 0o700 });
  for (const unsafe of [dirAlias, join(dirAlias, 'inner')]) assert.throws(() => compact(unsafe), { code: 'invalid_database', status: 400 });
  chmodSync(dir, 0o770);
  for (const apply of [false, true]) assert.throws(() => compact(dir, apply), { code: 'invalid_database', status: 400 });
  chmodSync(dir, 0o700);
  symlinkSync(target, join(dir, 'service-lock.sqlite'));
  assert.throws(() => compact(dir, true), { code: 'invalid_database', status: 400 });
  rmSync(join(dir, 'service-lock.sqlite'));
  assert.deepEqual(captureFiles(target), before);

  for (const version of [99, 1]) {
    const db = new DatabaseSync(source);
    try { db.exec(`PRAGMA user_version=${version}`); } finally { db.close(); }
    const unsupported = captureFiles(source);
    for (const apply of [false, true]) assert.throws(() => compact(dir, apply), { code: 'unsupported_schema', status: 400 });
    assert.deepEqual(captureFiles(source), unsupported);
  }
  verifyWorkspace(dir, 'backend.sqlite');
});

test('apply refuses non-private source databases and sidecars without changing permissions or linking the original', t => {
  const dir = directory(t), path = join(dir, 'backend.sqlite');
  new BackendStore(path).close();
  const before = captureFiles(path);
  const refuse = (file, mode) => {
    const files = readdirSync(dir);
    for (const keepOriginal of [false, true]) {
      assert.throws(() => compactBackendDatabase({ stateDir: dir, apply: true, keepOriginal }), { code: 'invalid_database', status: 400 });
      assert.equal(statSync(file).mode & 0o7777, mode);
      assert.equal(statSync(path).nlink, 1);
      assert.deepEqual(readdirSync(dir), files);
    }
  };
  for (const mode of [0o644, 0o640, 0o700]) {
    chmodSync(path, mode);
    refuse(path, mode);
  }
  chmodSync(path, 0o600);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = path + suffix;
    writeFileSync(sidecar, '', { mode: 0o644 });
    chmodSync(sidecar, 0o644);
    refuse(sidecar, 0o644);
    rmSync(sidecar);
  }
  assert.deepEqual(captureFiles(path), before);
  verifyWorkspace(dir, 'backend.sqlite');
});

test('failed pre-swap verification leaves the original inode and removes temporary databases', t => {
  const dir = directory(t), path = join(dir, 'backend.sqlite'), store = new BackendStore(path);
  store.db.exec(`INSERT INTO task_reference_claims VALUES ('BAD-1', 'bad', 'BAD', 1)`);
  store.close();
  const before = captureFiles(path);
  assert.throws(() => compactBackendDatabase({ stateDir: dir, apply: true, keepOriginal: true }), { code: 'task_identity_recovery_required' });
  assert.deepEqual(captureFiles(path), before);
  verifyWorkspace(dir, 'backend.sqlite');
  const unlock = serviceLock(dir); unlock();
});

for (const fault of ['replacement rename', 'live identity check']) test(`failed ${fault} preserves the original live filename and inode`, t => {
  const dir = directory(t), path = join(dir, 'node.sqlite'), other = join(dir, 'different.sqlite');
  new NodeJournal(path, nodeIdentity).close();
  new NodeJournal(other, { ...nodeIdentity, nodeId: 'someone-else' }).close();
  const before = captureFiles(path), rename = fs.renameSync;
  let first = true;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    // The old live name must still exist just before atomic replacement.
    if (first && from.includes('.compact-')) {
      first = false;
      assert.equal(statSync(to).ino, before[0][1]);
      if (fault === 'replacement rename') throw Error('injected rename failure');
      rename(from, to);
      writeFileSync(to, readFileSync(other));
    } else rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => compactNodeDatabase({ stateDir: dir, apply: true }),
      fault === 'replacement rename' ? /injected rename failure/ : { code: 'invalid_database', message: 'Live database identity does not match source' });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  verifyRetiredOriginal(path, before[0]);
  verifyWorkspace(dir, 'node.sqlite');
  const unlock = serviceLock(dir); unlock();
});

for (const role of ['backend', 'node']) test(`${role} fences Relay and external SQLite writers on both sides of cutover`, t => {
  const dir = directory(t), path = join(dir, `${role}.sqlite`);
  const open = name => role === 'backend' ? new BackendStore(name) : new NodeJournal(name, nodeIdentity);
  open(path).close();
  const previousConnection = open(join(dir, 'separate.sqlite'));
  const writer = `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    try { db.exec("PRAGMA busy_timeout=0; INSERT INTO settings VALUES ('lost-write', 'must not commit')"); console.log('committed'); }
    catch (error) { console.log(error.errcode); }
    finally { db.close(); }`;
  let probes = 0;
  const probe = () => {
    const refused = { code: 'database_compacting', status: 409 };
    assert.throws(() => open(path), refused);
    assert.throws(() => previousConnection.transaction(() => assert.fail('transaction entered')), refused);
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', writer, path], { encoding: 'utf8' }).trim(), '5');
    probes++;
  };
  const compact = role === 'backend' ? compactBackendDatabase : compactNodeDatabase;
  try {
    assert.equal(compact({ stateDir: dir, apply: true, _hooks: { beforeSwap: probe, afterSwap: probe } }).state, 'compacted');
    assert.equal(probes, 2);
    assert.equal(statSync(join(dir, 'compact-lock.sqlite')).mode & 0o777, 0o600);
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', writer, path], { encoding: 'utf8' }).trim(), 'committed');
    assert.doesNotThrow(() => open(path).close());
    assert.doesNotThrow(() => previousConnection.transaction(() => {}));
  } finally { previousConnection.close(); }
});

test('normal lock probes are compatible across four processes, but an active compactor excludes them', async t => {
  const dir = directory(t), path = join(dir, 'node.sqlite'), lock = join(dir, 'compact-lock.sqlite');
  new NodeJournal(path, nodeIdentity).close();
  const probeModule = new URL('../src/compact-lock.mjs', import.meta.url).href;
  const activeProbe = `import { assertNotCompacting } from ${JSON.stringify(probeModule)};
    try { assertNotCompacting(process.argv[1]); console.log('allowed'); }
    catch (error) { console.log(error.code + ':' + error.status); }`;
  compactNodeDatabase({ stateDir: dir, apply: true, _hooks: { beforeSwap: () => {
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', activeProbe, dir], { encoding: 'utf8' }).trim(), 'database_compacting:409');
  } } });
  assert.ok(statSync(lock).size >= 512);

  const normalProbe = `import { assertNotCompacting } from ${JSON.stringify(probeModule)};
    for (let i = 0; i < 500; i++) assertNotCompacting(process.argv[1]);
    console.log(500);`;
  // Keep a normal shared reader pinned so a mistaken exclusive probe fails
  // deterministically, even if the four child loops happen not to overlap.
  const reader = new DatabaseSync(lock, { readOnly: true });
  try {
    reader.exec('BEGIN; SELECT 1 FROM sqlite_master LIMIT 1');
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      execute(process.execPath, ['--input-type=module', '-e', normalProbe, dir])));
    assert.deepEqual(results.map(result => result.stdout.trim()), ['500', '500', '500', '500']);
  } finally { reader.close(); }
});

test('a dormant external SQLite handle on the old inode cannot append to the new live WAL', async t => {
  const dir = directory(t), path = join(dir, 'node.sqlite');
  new NodeJournal(path, nodeIdentity).close();
  // Opening a DatabaseSync handle alone does not lock the SQLite database.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    process.stdin.once('data', () => {
      try { db.exec("PRAGMA busy_timeout=0; INSERT INTO settings VALUES ('stale-fd', 'must not commit')"); console.log('committed'); }
      catch (error) { console.log(error.errcode); }
      finally { db.close(); }
    });
    console.log('opened');`, path]);
  t.after(() => child.kill());
  const exited = once(child, 'close');
  assert.equal((await once(child.stdout, 'data'))[0].toString().trim(), 'opened');
  const compacted = compactNodeDatabase({ stateDir: dir, apply: true, keepOriginal: true });
  const response = once(child.stdout, 'data');
  child.stdin.end('write');
  assert.equal((await response)[0].toString().trim(), '1032'); // SQLITE_READONLY_DBMOVED
  assert.deepEqual(await exited, [0, null]);
  for (const name of [path, compacted.keptOriginalPath]) inspect(name,
    db => assert.equal(db.prepare("SELECT value FROM settings WHERE key='stale-fd'").get(), undefined));
});

for (const [code, failRollbackSync] of [['EIO', false], ['EIO', true], ['EBADF', false], ['EROFS', false]]) test(`post-swap fsync ${code} retains the original${failRollbackSync ? ' even if rollback sync fails' : ''}`, t => {
  const dir = directory(t), path = join(dir, 'node.sqlite');
  new NodeJournal(path, nodeIdentity).close();
  const before = captureFiles(path);
  let syncs = 0, rejectedHandle;
  const fsyncDir = fd => {
    if (++syncs === 2 || failRollbackSync && syncs === 3) throw Object.assign(new Error('injected directory fsync failure'), { code });
    fs.fsyncSync(fd);
  };
  try {
    assert.throws(() => compactNodeDatabase({ stateDir: dir, apply: true, _hooks: { fsyncDir,
      afterSwap: () => { rejectedHandle = new DatabaseSync(path); } } }), error => {
      assert.equal(error.code, code);
      if (failRollbackSync) assert.match(error.message, /rollback durability could not be confirmed/);
      return true;
    });
    assert.throws(() => rejectedHandle.exec("INSERT INTO settings VALUES ('stale-fd', 'must not commit')"), { errcode: 1032 });
  } finally { rejectedHandle?.close(); }
  verifyRetiredOriginal(path, before[0]);
  const { retainedOriginals, strandedCandidates } = compactNodeDatabase({ stateDir: dir });
  assert.deepEqual(strandedCandidates, []);
  assert.equal(retainedOriginals.length, 1);
  verifyRetiredOriginal(retainedOriginals[0], before[0]);
});

test('plans report interrupted artifacts and apply clears only private abandoned candidates', t => {
  const dir = directory(t), path = join(dir, 'node.sqlite');
  new NodeJournal(path, nodeIdentity).close();
  const notV4 = `${path}.compact-00000000-0000-0000-0000-000000000000.sqlite`;
  const wrongVariant = `${path}.compact-00000000-0000-4000-7000-000000000001.sqlite`;
  const abandoned = `${path}.compact-00000000-0000-4000-8000-000000000001.sqlite`;
  const symlink = `${path}.compact-00000000-0000-4000-8000-000000000002.sqlite`;
  const unsafe = `${path}.compact-00000000-0000-4000-8000-000000000003.sqlite`;
  const manual = `${path}.compact-manual-recovery.sqlite`, note = `${path}.compact-readme`;
  const retained = `${path}.pre-compact-previous`;
  writeFileSync(retained, readFileSync(path), { mode: 0o600 });
  for (const suffix of ['', '-shm', '-wal', '-journal']) writeFileSync(abandoned + suffix, 'partial', { mode: 0o600 });
  symlinkSync(retained, symlink);
  writeFileSync(unsafe, 'not private', { mode: 0o644 });
  writeFileSync(manual, 'manual recovery', { mode: 0o600 });
  writeFileSync(note, 'operator note', { mode: 0o600 });
  writeFileSync(notV4, 'non-v4 recovery', { mode: 0o600 });
  writeFileSync(wrongVariant, 'non-RFC variant recovery', { mode: 0o600 });
  const plan = compactNodeDatabase({ stateDir: dir });
  assert.deepEqual(plan.strandedCandidates, [notV4, wrongVariant, abandoned, symlink, unsafe, manual, note]);
  assert.deepEqual(plan.retainedOriginals, [retained]);
  const original = readFileSync(retained);
  const done = compactNodeDatabase({ stateDir: dir, apply: true });
  assert.deepEqual(done.strandedCandidates, [notV4, wrongVariant, symlink, unsafe, manual, note]);
  assert.deepEqual(done.retainedOriginals, [retained]);
  assert.ok(['', '-shm', '-wal', '-journal'].every(suffix => !existsSync(abandoned + suffix)));
  assert.deepEqual(readFileSync(retained), original);
  assert.equal(readFileSync(manual, 'utf8'), 'manual recovery');
  assert.equal(readFileSync(note, 'utf8'), 'operator note');
  assert.equal(readFileSync(notV4, 'utf8'), 'non-v4 recovery');
  assert.equal(readFileSync(wrongVariant, 'utf8'), 'non-RFC variant recovery');
});

test('an existing hard link to the original inode prevents actual space reclamation', t => {
  const dir = directory(t), path = join(dir, 'node.sqlite'), retained = `${path}.pre-compact-interrupted`;
  const journal = new NodeJournal(path, nodeIdentity);
  try {
    const insert = journal.db.prepare('INSERT INTO inbox VALUES (?, ?)');
    journal.transaction(() => {
      for (let i = 0; i < 250; i++) {
        insert.run(`legacy-${i}`, JSON.stringify({ ...presenceHeartbeat, id: `legacy-${i}`, data: { ...heartbeat, padding } }));
      }
    });
  } finally { journal.close(); }
  linkSync(path, retained);
  const original = statSync(retained);
  const result = compactNodeDatabase({ stateDir: dir, apply: true, keepOriginal: false });
  assert.equal(result.bytesReclaimed, 0);
  assert.ok(result.sizeReductionBytes > 0);
  assert.deepEqual(result.retainedOriginals, [retained]);
  assert.equal(statSync(retained).ino, original.ino);
  assert.equal(statSync(retained).nlink, 1);
  inspect(retained, db => assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get().n, 250));
});

test('node plan includes committed WAL frames, and apply checkpoints recoverable WAL without dropping it', t => {
  const dir = directory(t), path = join(dir, 'node.sqlite'), journal = new NodeJournal(path, nodeIdentity);
  const legacy = JSON.stringify({ ...presenceHeartbeat, id: 'legacy' });
  journal.db.prepare('INSERT INTO inbox VALUES (?,?)').run('legacy', legacy);
  journal.consume({ cursor: 'wal-cursor', items: [event('durable', 'task.create', { id: 'task', revision: 1 })] });
  const files = captureFiles(path);
  try {
    const plan = compactNodeDatabase({ stateDir: dir });
    assert.equal(plan.inboxTotal, 2);
    assert.equal(plan.inboxRemovable, 1);
    assert.equal(plan.sizeBytes, files.reduce((sum, file) => sum + file[2].length, 0));
    assert.deepEqual(captureFiles(path), files);
  } finally { journal.close(); }

  // Recreate the files left by a crash after WAL commits but before checkpoint.
  for (const [name, , bytes] of files) if (!name.endsWith('-shm')) writeFileSync(name, bytes, { mode: 0o600 });
  const crashed = captureFiles(path);
  assert.throws(() => compactNodeDatabase({ stateDir: dir }), { code: 'database_busy', status: 409 });
  assert.deepEqual(captureFiles(path), crashed);
  assert.equal(compactNodeDatabase({ stateDir: dir, apply: true }).inboxRetained, 1);
  verifyWorkspace(dir, 'node.sqlite');
  const reopened = new NodeJournal(path, nodeIdentity);
  try { assert.equal(reopened.cursor(), 'wal-cursor'); }
  finally { reopened.close(); }
});

test('public CLI compaction defaults to a plan and is fenced from worker and agent scopes', async t => {
  const dir = directory(t), backend = join(dir, 'herdr-relay-backend'), nodeDir = join(dir, 'herdr-relay-native');
  mkdirSync(backend, { mode: 0o700 }); mkdirSync(nodeDir, { mode: 0o700 });
  new BackendStore(join(backend, 'backend.sqlite')).close();
  new NodeJournal(join(nodeDir, 'node.sqlite'), nodeIdentity).close();
  const configFile = join(nodeDir, 'node.json');
  writeFileSync(configFile, JSON.stringify({ stateDirectory: nodeDir }), { mode: 0o600 });
  const env = { ...process.env, XDG_STATE_HOME: dir };
  delete env.RELAY_CLI_READ_ONLY;
  delete env.RELAY_CLI_EXECUTION_ID;
  const call = async (tokens, extraEnv) => JSON.parse((await execute(process.execPath, [cli, ...tokens], { env: { ...env, ...extraEnv } })).stdout);
  for (const [role, opt, location] of [['backend', '--state-dir', backend], ['node', '--config', configFile]]) {
    const args = [role, 'compact'];
    for (const invocation of [args, ['native', ...args]]) {
      assert.equal(executionCliInvocation(invocation), false);
      assert.equal(readOnlyCliInvocation(invocation), false);
    }
    await assert.rejects(call([...args, '--apply'], { RELAY_CLI_EXECUTION_ID: 'exec' }), /execution_cli_scope/);
    await assert.rejects(call([...args, '--apply'], { RELAY_CLI_READ_ONLY: '1' }), /agent_cli_read_only/);
    assert.deepEqual(await call(args), await call([...args, opt, location]));
    assert.equal((await call(args)).state, 'compact_plan');
    const applied = await call([...args, opt, location, '--apply', '--keep-original']);
    assert.equal(applied.state, 'compacted');
    assert.ok(existsSync(applied.keptOriginalPath));
  }
});
