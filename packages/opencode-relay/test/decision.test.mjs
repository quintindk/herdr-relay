import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionPresenter } from '../decision.mjs';

const proposal = { requestId: 'request', sessionId: 'session-a', sourceMessageId: 'user-a',
  action: 'answer', targetId: 'question-a', revision: 'revision-1', details: 'Answer: South Africa North' };

function fixture(overrides = {}) {
  const source = { id: 'user-a', type: 'user', text: 'Use South Africa North', createdAt: 1 };
  const dialogs = [];
  const presenter = decisionPresenter({ clientId: 'client-a', selectedSession: () => 'session-a',
    readSource: async () => source, confirm: async value => { dialogs.push(value); return true; },
    now: () => 123, ...overrides });
  return { presenter, source, dialogs };
}

test('decision binds the displayed action, target, revision, exact proposal and current source', async () => {
  const { presenter, dialogs } = fixture();
  const receipt = await presenter.present(proposal);
  assert.equal(receipt.decision, 'confirmed');
  assert.equal(receipt.sourceMessageId, 'user-a');
  assert.equal(receipt.authority, 'unverified_client_local');
  assert.match(dialogs[0].message, /question-a\nRevision: revision-1/);
  assert.match(dialogs[0].message, /South Africa North/);
  const different = await presenter.present({ ...proposal, revision: 'revision-2' });
  assert.notEqual(receipt.proposalDigest, different.proposalDigest);
});

test('false and dismissed confirmations never produce approval', async () => {
  for (const answer of [false, undefined]) {
    const { presenter } = fixture({ confirm: async () => answer });
    assert.equal((await presenter.present(proposal)).decision, answer === false ? 'declined' : 'dismissed');
  }
});

test('session changes, disposal and explicit generation invalidation fence in-flight confirmation', async () => {
  for (const action of ['switch', 'dispose', 'invalidate']) {
    let resolve;
    let selected = 'session-a';
    const { presenter } = fixture({ selectedSession: () => selected,
      confirm: () => new Promise(done => { resolve = done; }) });
    const pending = presenter.present(proposal);
    await new Promise(done => setImmediate(done));
    if (action === 'switch') selected = 'session-b';
    if (action === 'dispose') presenter.dispose();
    if (action === 'invalidate') presenter.invalidate();
    resolve(true);
    await assert.rejects(pending, { code: 'stale_decision_context' });
  }
});

test('changed source and known synthetic sources cannot approve a decision', async () => {
  const item = fixture({ confirm: async () => { item.source.text = 'Different instruction'; return true; } });
  await assert.rejects(item.presenter.present(proposal), { code: 'decision_source_changed' });
  for (const marker of ['synthetic', 'notification', 'worker']) {
    const { presenter } = fixture({ readSource: async () => ({ id: 'user-a', type: 'user', text: 'text', [marker]: true }) });
    await assert.rejects(presenter.present(proposal), { code: 'invalid_decision_source' });
  }
});

test('only one dialog may be pending and errors release the local reservation', async () => {
  let resolve;
  const { presenter } = fixture({ confirm: () => new Promise(done => { resolve = done; }) });
  const pending = presenter.present(proposal);
  await new Promise(done => setImmediate(done));
  await assert.rejects(presenter.present(proposal), { code: 'decision_already_pending' });
  resolve(false);
  await pending;
  await assert.rejects(presenter.present({ ...proposal, revision: '' }), { code: 'invalid_decision_proposal' });
  presenter.dispose();
  await assert.rejects(presenter.present(proposal), { code: 'decision_presenter_disposed' });
});
