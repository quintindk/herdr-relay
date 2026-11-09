import assert from 'node:assert/strict';
import test from 'node:test';
import { enrolmentOutboxes, enrolmentOutboxName } from '../enrolment-outbox.mjs';

const pending = (directory, key = 'original', config = '/private/node.json') => ({ key, args: ['agent', 'attach', '--config', config,
  '--session', 'ses_original', '--directory', directory, '--key', key, '--agent', 'agent', '--generation', '1'] });

function fixture() {
  const states = new Map([['enrolment-outbox', { pending: null, sessionCreation: null }]]);
  const f = { states, legacy: states.get('enrolment-outbox') };
  f.storage = { store(name, options) {
    if (!states.has(name)) states.set(name, structuredClone(options.initial));
    const state = states.get(name);
    return [state, async update => {
      await f.beforeUpdate?.(name);
      const draft = JSON.parse(JSON.stringify(state)); update(draft);
      Object.assign(state, draft);
    }];
  } };
  f.outboxes = enrolmentOutboxes(f.storage, '/private/node.json');
  return f;
}

test('durable outbox names isolate workspaces and node configurations without exposing their paths', () => {
  const name = enrolmentOutboxName('/private/node.json', '/infra');
  assert.match(name, /^enrolment-outbox-[a-f0-9]{64}$/);
  assert.equal(name, enrolmentOutboxName('/private/node.json', '/infra'));
  assert.notEqual(name, enrolmentOutboxName('/private/node.json', '/blender'));
  assert.notEqual(name, enrolmentOutboxName('/another/node.json', '/infra'));
});

test('a legacy Blender retry neither enters nor blocks the Infra outbox', async () => {
  const f = fixture(), original = pending('/blender'); f.legacy.pending = structuredClone(original);
  const infra = await f.outboxes.forDirectory('/infra');
  assert.equal(infra.outbox.pending, null); assert.deepEqual(f.legacy.pending, original);
  await infra.updateOutbox(draft => { draft.pending = pending('/infra', 'infra'); });
  const blender = await f.outboxes.forDirectory('/blender');
  assert.deepEqual(blender.outbox.pending, original); assert.equal(f.legacy.pending, null);
  assert.equal(infra.outbox.pending.key, 'infra');
});

test('legacy migration retains the original key, arguments and model across reactive storage', async () => {
  const f = fixture(), original = pending('/workspace');
  f.legacy.pending = new Proxy(structuredClone(original), {});
  const creation = { id: 'ses_created', location: { directory: '/workspace' }, model: { providerID: 'original', id: 'model', variant: 'high' } };
  f.legacy.sessionCreation = new Proxy(structuredClone(creation), {});
  const scope = await f.outboxes.forDirectory('/workspace');
  assert.deepEqual(scope.outbox.pending, original); assert.deepEqual(scope.outbox.sessionCreation, creation);
  assert.equal(f.legacy.pending, null); assert.equal(f.legacy.sessionCreation, null);
  assert.equal(await f.outboxes.forDirectory('/workspace'), scope);
});

test('a migration failure keeps original evidence and retries the same saved operation', async () => {
  const f = fixture(), original = pending('/workspace'); f.legacy.pending = structuredClone(original);
  f.beforeUpdate = name => { if (name === 'enrolment-outbox') throw Error('Lost migration acknowledgement'); };
  await assert.rejects(f.outboxes.forDirectory('/workspace'), /Lost migration/);
  assert.deepEqual(f.legacy.pending, original);
  assert.deepEqual(f.states.get(enrolmentOutboxName('/private/node.json', '/workspace')).pending, original);
  f.beforeUpdate = null;
  assert.deepEqual((await f.outboxes.forDirectory('/workspace')).outbox.pending, original);
  assert.equal(f.legacy.pending, null);
});

test('migration refuses a conflicting workspace slot without overwriting either intent', async () => {
  const f = fixture(), original = pending('/workspace'), other = pending('/workspace', 'other');
  const scope = await f.outboxes.forDirectory('/workspace'); scope.outbox.pending = structuredClone(other);
  f.legacy.pending = structuredClone(original);
  await assert.rejects(f.outboxes.forDirectory('/workspace'), { code: 'enrolment_outbox_conflict' });
  assert.deepEqual(f.legacy.pending, original); assert.deepEqual(scope.outbox.pending, other);
});

test('migration never clears another TUI operation that replaced the legacy slot', async () => {
  const f = fixture(), original = pending('/workspace'), replacement = pending('/elsewhere', 'replacement');
  f.legacy.pending = structuredClone(original);
  f.beforeUpdate = name => { if (name === 'enrolment-outbox') f.legacy.pending = structuredClone(replacement); };
  const scope = await f.outboxes.forDirectory('/workspace');
  assert.deepEqual(scope.outbox.pending, original); assert.deepEqual(f.legacy.pending, replacement);
});

test('legacy retries for a different node configuration and malformed keys remain untouched', async () => {
  for (const original of [pending('/workspace', 'original', '/foreign/node.json'), { ...pending('/workspace'), key: 'changed' },
    { ...pending('/workspace'), key: undefined }, { key: 'original', args: [...pending('/workspace').args, '--directory', '/another'] }]) {
    const f = fixture(); f.legacy.pending = structuredClone(original);
    assert.equal((await f.outboxes.forDirectory('/workspace')).outbox.pending, null);
    assert.deepEqual(f.legacy.pending, original);
  }
});
