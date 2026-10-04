import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import { bindPlacement, reconcilePlacement } from '../src/placement.mjs';

test('restored placement retains exact terminal and conversation and refuses a reused occupant', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.register({ id: 'worker', companyId: 'company', agentId: 'agent', harness: 'opencode', instanceId: 'instance', conversationId: 'session' });
  let pane = { pane_id: 'w1:p1', terminal_id: 'terminal-original', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'opencode', agent_session: { value: 'session' } };
  const inspect = async () => pane;
  await bindPlacement(store, { bindingId: 'worker', paneId: pane.pane_id }, inspect);
  assert.equal((await reconcilePlacement(store, 'worker', inspect)).state, 'verified');
  pane = { ...pane, terminal_id: 'replacement-terminal' };
  assert.equal((await reconcilePlacement(store, 'worker', inspect)).state, 'unresolved');
  assert.equal(store.operation('placement:worker').terminalId, 'terminal-original');
});
