import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { autoAttachmentCandidate, registerEnrolmentCommands } from '../enrolment-commands.mjs';

function fixture(t) {
  const f = { session: 'ses_current', runtime: 'one', commands: [], calls: [], events: new Map(), toasts: [], records: [],
    createdSessions: new Map(), creates: [], navigations: [], model: { providerID: 'fixture', modelID: 'selected', variant: 'high' },
    outbox: { pending: null }, enrolments: [{ id: 'wright', name: 'Wright', directory: '/workspace', autoAttach: true,
      installedSchedules: 2, obligations: [], receiver: { state: 'active', conversationId: 'ses_old', generation: 1 } }] };
  f.confirm = async () => true;
  f.runCli = async args => {
    f.calls.push(args);
    if (args[1] === 'enrolments') return structuredClone(f.enrolments);
    if (args[0] === 'node') return { state: 'installed' };
    if (f.failure) throw Error('lost child-process reply');
    const sessionId = args[args.indexOf('--session') + 1];
    f.enrolments[0].receiver = { state: 'active', conversationId: sessionId, generation: 2 };
    return { configFile: '/private/node.json', agentId: 'wright', sessionId, generation: 2 };
  };
  f.createSession = async input => {
    f.creates.push(input);
    const session = { ...structuredClone(input), time: { created: Date.now() } };
    f.createdSessions.set(input.id, session);
    return session;
  };
  const ctx = { options: { ownerContextFile: '/private/owner.json', nativeNodeConfigFile: '/private/node.json' },
    location: { directory: '/workspace' },
    client: { rpc: () => ({ inspect: async () => ({ generation: f.runtime }) }),
      session: { get: async ({ sessionID }) => {
        if (f.createdSessions.has(sessionID)) return f.createdSessions.get(sessionID);
        if (sessionID === f.outbox.sessionCreation?.id) throw Object.assign(Error('Session not found'), { status: 404 });
        return { id: sessionID, location: { directory: '/workspace' } };
      }, create: input => f.createSession(input) } },
    data: { on: (name, callback) => { f.events.set(name, callback); return () => f.events.delete(name); } },
    storage: { store: () => [f.outbox, async update => update(f.outbox)] },
    ui: { model: { current: () => f.model }, router: { navigate: destination => {
      f.navigations.push(destination); f.session = destination.sessionID; f.track(f.session);
    } }, toast: { show: value => f.toasts.push(value) }, dialog: {
      confirm: options => f.confirm(options), prompt: async () => 'Wright', select: async () => 'wright',
    } },
    keymap: { layer: factory => { f.commands.push(...factory().commands); } },
  };
  f.stop = registerEnrolmentCommands(ctx, { selectedSession: () => f.session, runCli: args => f.runCli(args), record: e => f.records.push(e),
    interval: callback => { f.tick = callback; return {}; }, clear: () => { f.cleared = true; },
    observeSelection: listener => { f.track = listener; return () => {}; } });
  t.after(f.stop);
  f.run = name => f.commands.find(c => c.slash.name === name).run();
  return f;
}

test('human-only attach command confirms exact receiver, persists immutable intent and starts only its Relay node', async t => {
  const f = fixture(t);
  let preview;
  f.confirm = async options => { preview = options.message; return true; };
  await f.run('relay-attach');
  assert.match(preview, /ses_current/); assert.match(preview, /ses_old/);
  const call = f.calls.find(args => args[1] === 'attach');
  assert.ok(call.includes('--generation')); assert.equal(call[call.indexOf('--generation') + 1], '1');
  assert.equal(f.outbox.pending, null);
  assert.ok(f.calls.some(args => args[0] === 'node' && args[1] === 'ensure'));
  assert.equal(f.records.at(-1).type, 'receiver_attached');
});

for (const invalidation of ['decline', 'switch', 'roundtrip', 'reconnect', 'reload', 'dispose']) test(`attachment confirmation refuses ${invalidation} without publishing an enrolment or claiming a chat`, async t => {
  const f = fixture(t);
  f.confirm = async () => {
    if (invalidation === 'switch') f.session = 'ses_elsewhere';
    if (invalidation === 'roundtrip') { f.track('ses_elsewhere'); f.track('ses_current'); }
    if (invalidation === 'reconnect') f.events.get('server.connected')();
    if (invalidation === 'reload') f.runtime = 'two';
    if (invalidation === 'dispose') f.stop();
    return invalidation !== 'decline';
  };
  await f.run('relay-attach');
  assert.equal(f.calls.filter(args => args[1] === 'attach').length, 0);
  assert.equal(f.outbox.pending, null);
});

test('confirmed lost reply is reconciled with its original key and original chat after a session change', async t => {
  const f = fixture(t);
  f.failure = true;
  await f.run('relay-attach');
  const pending = structuredClone(f.outbox.pending);
  assert.ok(pending);
  f.failure = false; f.session = 'ses_another';
  await f.run('relay-attach');
  const calls = f.calls.filter(args => args[1] === 'attach');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1][calls[1].indexOf('--session') + 1], 'ses_current');
  assert.equal(f.outbox.pending, null);
});

test('automatic attachment requires a fresh selected root chat and an unambiguous previously designated origin', () => {
  const enrolment = { id: 'wright', autoAttach: true, directory: '/workspace', receiver: { state: 'active', conversationId: 'ses_old' } };
  const input = { created: { sessionID: 'ses_new', location: { directory: '/workspace' } }, selected: 'ses_new', previous: 'ses_old', enrolments: [enrolment] };
  assert.equal(autoAttachmentCandidate(input), enrolment);
  assert.equal(autoAttachmentCandidate({ ...input, selected: 'ses_elsewhere' }), null);
  assert.equal(autoAttachmentCandidate({ ...input, previous: 'ses_unrelated' }), null);
  assert.equal(autoAttachmentCandidate({ ...input, enrolments: [enrolment, { ...enrolment, id: 'other' }] }), null);
  assert.equal(autoAttachmentCandidate({ ...input, created: { ...input.created, parentID: 'ses_parent' } }), null);
});

test('broadcast creation does not attach until this TUI selects it, and disposal releases listeners and timer', async t => {
  const f = fixture(t);
  f.session = 'ses_old';
  await setImmediate();
  f.events.get('session.created')({ data: { sessionID: 'ses_new', location: { directory: '/workspace' } } });
  f.tick();
  assert.equal(f.calls.filter(args => args[1] === 'attach').length, 0);
  f.session = 'ses_new'; f.tick();
  for (let i = 0; i < 10 && !f.records.some(e => e.type === 'receiver_attached'); i++) await setImmediate();
  assert.equal(f.calls.filter(args => args[1] === 'attach').length, 1);
  f.stop(); assert.equal(f.events.size, 0); assert.equal(f.cleared, true);
});

test('new-chat continuity survives Home and native creation arriving after route selection', async t => {
  const f = fixture(t);
  f.session = 'ses_old'; await setImmediate();
  f.session = null; f.track(null);
  f.session = 'ses_new'; f.track('ses_new');
  await setImmediate();
  f.events.get('session.created')({ created: Date.now(), data: { sessionID: 'ses_new', location: { directory: '/workspace' } } });
  f.tick();
  for (let i = 0; i < 10 && !f.records.some(e => e.type === 'receiver_attached'); i++) await setImmediate();
  assert.equal(f.calls.filter(args => args[1] === 'attach').length, 1);
});

test('a definitively refused attachment clears only its TUI retry slot so a fresh human claim can be made', async t => {
  const f = fixture(t);
  const original = f.runCli;
  f.runCli = async args => {
    if (args[1] === 'attach') throw Object.assign(Error('Backend definitively refused claim'), { code: 'attachment_refused' });
    return original(args);
  };
  await f.run('relay-attach');
  assert.equal(f.outbox.pending, null);
  assert.equal(f.records.at(-1).type, 'attachment_refused');
});

for (const command of ['relay-enrol', 'relay-attach']) test(`${command} creates and opens an empty root session from Home before explicit confirmation`, async t => {
  const f = fixture(t);
  f.session = null;
  let confirmedSession;
  f.confirm = async () => { confirmedSession = f.session; return true; };
  await f.run(command);
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.creates[0].location, { directory: '/workspace' });
  assert.deepEqual(f.creates[0].model, { providerID: 'fixture', id: 'selected', variant: 'high' });
  assert.equal(f.creates[0].parentID, undefined);
  assert.equal(f.creates[0].permissions, undefined);
  assert.equal(f.creates[0].text, undefined);
  assert.equal(confirmedSession, f.creates[0].id);
  assert.deepEqual(f.navigations, [{ type: 'session', sessionID: f.creates[0].id }]);
  assert.equal(f.outbox.sessionCreation, null);
  assert.equal(f.records.at(-1).type, 'receiver_attached');
});

test('Home attach without an enrolment reports the prerequisite without creating an unused chat', async t => {
  const f = fixture(t);
  f.session = null; f.enrolments = [];
  await f.run('relay-attach');
  assert.equal(f.creates.length, 0);
  assert.match(f.toasts.at(-1).message, /relay-enrol/);
});

test('a lost Home session-create reply reuses its saved native ID and original model instead of creating another chat', async t => {
  const f = fixture(t);
  f.session = null;
  const create = f.createSession;
  f.createSession = async input => { await create(input); throw Error('Lost session reply'); };
  await f.run('relay-attach');
  assert.equal(f.creates.length, 1);
  const original = structuredClone(f.outbox.sessionCreation);
  assert.ok(original);
  f.model = { providerID: 'other', modelID: 'changed' };
  await f.run('relay-attach');
  assert.equal(f.creates.length, 1);
  assert.equal(f.navigations.at(-1).sessionID, original.id);
  assert.equal(f.outbox.sessionCreation, null);
  assert.equal(f.records.at(-1).sessionId, original.id);
});

test('retrying an undelivered Home create unwraps reactive storage and retains its original native ID', async t => {
  const f = fixture(t);
  f.session = null;
  const create = f.createSession;
  f.createSession = async () => { throw Error('Create was not delivered'); };
  await f.run('relay-attach');
  const id = f.outbox.sessionCreation.id;
  f.outbox.sessionCreation = new Proxy(f.outbox.sessionCreation, {});
  f.createSession = create;
  await f.run('relay-attach');
  assert.equal(f.creates.length, 1);
  assert.equal(f.creates[0].id, id);
  assert.equal(f.records.at(-1).type, 'receiver_attached');
});

test('a dismissed Home attachment cannot be bypassed by its delayed session-created notification', async t => {
  const f = fixture(t);
  f.session = 'ses_old'; await setImmediate();
  f.session = null; f.track(null); f.confirm = async () => false;
  await f.run('relay-attach');
  assert.equal(f.creates.length, 1);
  f.events.get('session.created')({ created: Date.now(), data: { sessionID: f.session, location: { directory: '/workspace' } } });
  f.tick(); await setImmediate();
  assert.equal(f.calls.filter(args => args[1] === 'attach').length, 0);
});

for (const change of ['switch', 'reconnect', 'reload', 'dispose']) test(`Home session creation cannot hijack navigation or publish a grant after ${change}`, async t => {
  const f = fixture(t);
  f.session = null;
  const create = f.createSession;
  f.createSession = async input => {
    const session = await create(input);
    if (change === 'switch') { f.session = 'ses_other'; f.track(f.session); }
    if (change === 'reconnect') f.events.get('server.connected')();
    if (change === 'reload') f.runtime = 'changed';
    if (change === 'dispose') f.stop();
    return session;
  };
  await f.run('relay-enrol');
  assert.equal(f.navigations.length, 0);
  assert.equal(f.calls.filter(args => ['attach', 'enrol'].includes(args[1])).length, 0);
  assert.ok(f.outbox.sessionCreation);
});

test('Home reconciles an already confirmed attachment without creating a new chat', async t => {
  const f = fixture(t);
  f.failure = true; await f.run('relay-attach');
  const pending = structuredClone(f.outbox.pending);
  f.session = null; f.failure = false;
  await f.run('relay-attach');
  assert.equal(f.creates.length, 0);
  assert.deepEqual(f.calls.filter(args => args[1] === 'attach').at(-1), pending.args);
  assert.equal(f.outbox.pending, null);
});
