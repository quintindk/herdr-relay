import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoPendingRelayOutboxes } from '../src/upgrade-native-decisions.mjs';

test('plugin-ID upgrade preserves empty outboxes across channels and refuses pending or unknown state', t => {
  const root = mkdtempSync('/tmp/opencode/relay-outbox-test-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const channel of ['latest', 'preview']) mkdirSync(join(root, channel, 'tui'), { recursive: true });
  const file = join(root, 'latest/tui/plugin.herdr.relay.previous.tui.enrolment-outbox.json');
  const empty = JSON.stringify({ pending: null, sessionCreation: null });
  writeFileSync(file, empty);
  writeFileSync(join(root, 'preview/tui/plugin.herdr.relay.tui.human-outbox.json'), '{"pending":null}');
  assert.deepEqual(assertNoPendingRelayOutboxes(root), { outboxesChecked: 2 });
  assert.equal(readFileSync(file, 'utf8'), empty);
  for (const state of [{ pending: { key: 'original-key', command: { id: 'exact-command' } } }, { pending: null, sessionCreation: { id: 'original-session' } }, { pending: null, future: true }]) {
    const before = JSON.stringify(state); writeFileSync(file, before);
    assert.throws(() => assertNoPendingRelayOutboxes(root), { code: 'upgrade_pending_decisions' });
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  writeFileSync(file, '{broken');
  assert.throws(() => assertNoPendingRelayOutboxes(root), { code: 'upgrade_plugin_state_unavailable' });
});
