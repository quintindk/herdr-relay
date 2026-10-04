import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { recordEvent, inbox, acknowledgeEvent } from '../src/inbox.mjs';
import { systemdUnit } from '../src/installation.mjs';
import { overview, renderOverview } from '../src/views.mjs';

test('source event and checkpoint are atomic, deduplicated and recoverable after restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-inbox-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = new Store(join(root, 'state.sqlite'));
  for (const id of ['monitor', 'driver', 'foreign']) store.register({ id, companyId: id === 'foreign' ? 'other' : 'company',
    agentId: id, harness: 'opencode', instanceId: 'instance', conversationId: id });
  const input = { source: 'fixture-inbox', eventId: 'source-1', cursor: '1', recipient: 'driver', summary: 'Customer asked for a demo', reference: 'fixture://message/1' };
  const event = recordEvent(store, 'monitor', input);
  store.close();
  store = new Store(join(root, 'state.sqlite'));
  t.after(() => store.close());
  assert.equal(recordEvent(store, 'monitor', input).id, event.id);
  assert.equal(inbox(store, 'driver').length, 1);
  assert.equal(inbox(store, 'monitor').length, 0);
  assert.throws(() => recordEvent(store, 'monitor', { ...input, summary: 'Changed' }), { code: 'event_conflict' });
  assert.throws(() => recordEvent(store, 'monitor', { ...input, eventId: 'source-2', cursor: '2' }), { code: 'stale_cursor' });
  recordEvent(store, 'monitor', { ...input, eventId: 'source-2', cursor: '2', expectedCursor: '1' });
  assert.throws(() => recordEvent(store, 'monitor', { ...input, recipient: 'foreign' }), { code: 'forbidden' });
  assert.throws(() => acknowledgeEvent(store, 'monitor', event.id), { code: 'forbidden' });
  assert.equal(acknowledgeEvent(store, 'driver', event.id).state, 'read');
  assert.equal(acknowledgeEvent(store, 'driver', event.id).state, 'read');
});

test('service unit quotes paths and rejects directive injection', () => {
  const input = { node: '/usr/bin/node', cli: '/home/user/Relay App/src/cli.mjs', stateDirectory: '/home/user/.state/relay', paperclipUrl: 'http://127.0.0.1:3100' };
  const unit = systemdUnit(input);
  assert.ok(unit.includes('"/home/user/Relay App/src/cli.mjs"'));
  assert.ok(unit.includes('Restart=on-failure'));
  assert.throws(() => systemdUnit({ ...input, cli: '/tmp/a\nExecStart=/bin/false' }), { code: 'invalid_installation' });
});

test('overview strips terminal controls from task and agent labels', () => {
  const run = { id: 'run', request: { bindingId: 'agent\x1b[2J', taskId: 'task' }, deliveryState: 'acknowledged', nativeState: 'claimed', publication: { state: 'pending' } };
  const rendered = renderOverview(overview([], [run]));
  assert.ok(!rendered.includes('\x1b'));
  assert.ok(rendered.includes('unsettled'));
});
