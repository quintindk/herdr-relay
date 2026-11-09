import assert from 'node:assert/strict';
import test from 'node:test';
import { assertInteractiveUpgradeCompatibility } from '../src/upgrade-safety.mjs';

test('active collaborative jobs require compatible code, not an unrelated work-settlement gate', () => {
  const identity = { collaborationWork: [{ id: 'job', state: 'waiting_children' }] };
  assert.throws(() => assertInteractiveUpgradeCompatibility(identity, { compatibility: {} }), { code: 'upgrade_collaboration_protocol_required' });
  assert.doesNotThrow(() => assertInteractiveUpgradeCompatibility(identity, { compatibility: { collaboration: 1 } }));
  assert.doesNotThrow(() => assertInteractiveUpgradeCompatibility({ collaborationWork: [] }, { compatibility: {} }));
});
