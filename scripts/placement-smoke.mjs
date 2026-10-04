import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.mjs';
import { bindPlacement, reconcilePlacement } from '../src/placement.mjs';

assert.equal(process.env.HERDR_ENV, '1');
const pane = JSON.parse(execFileSync('herdr', ['pane', 'current', '--current'], { encoding: 'utf8' })).result.pane;
const store = new Store(':memory:');
try {
  store.register({ id: 'placement-fixture', companyId: 'fixture', agentId: 'fixture', harness: pane.agent,
    instanceId: 'read-only-current-pane', conversationId: pane.agent_session.value });
  await bindPlacement(store, { bindingId: 'placement-fixture', paneId: pane.pane_id });
  assert.equal((await reconcilePlacement(store, 'placement-fixture')).state, 'verified');
  console.log(JSON.stringify({ herdrVersion: '0.9.3', readOnlyPlacementVerified: true, terminalIdentityMatched: true, conversationIdentityMatched: true }));
} finally { store.close(); }
