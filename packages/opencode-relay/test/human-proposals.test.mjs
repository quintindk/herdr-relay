import assert from 'node:assert/strict';
import test from 'node:test';
import { humanSource, registerHumanProposals } from '../human-proposals.mjs';

test('native invocation metadata cannot masquerade as human source', () => {
  const message = { id: 'user', type: 'user', text: 'Use region', time: { created: 1 } };
  assert.equal(humanSource(message).id, 'user');
  for (const metadata of [{ herdrRelayInvocation: 'run' }, { synthetic: true }, { notification: true }]) {
    assert.throws(() => humanSource({ ...message, metadata }), /human-source/);
  }
});

test('proposal tools store source-bound intent without an owner credential or backend mutation', async () => {
  const entries = new Map();
  const tools = [];
  let rpc;
  const context = {
    options: {}, location: { directory: '/work' },
    tool: { transform: async edit => { edit({ add: tool => tools.push(tool) }); return { dispose: async () => {} }; } },
    storage: { set: async (key, value) => entries.set(key, value), scan: async () => ({ entries: [...entries].map(([key, value]) => ({ key, value })) }) },
    session: { get: async () => ({ location: { directory: '/work' } }), context: async () => [{ id: 'source', type: 'user', text: 'Use South Africa North', time: { created: 1 } }] },
    rpc: { register: async (_definition, handlers) => { rpc = handlers; return { dispose: async () => {} }; } },
  };
  const close = await registerHumanProposals(context);
  try {
    const result = await tools.find(tool => tool.name === 'relay_answer').execute({ id: 'question', expectedRevision: 1, body: 'South Africa North' }, { sessionID: 'session' });
    assert.equal(JSON.parse(result.content).state, 'proposed');
    const proposal = (await rpc.list({ sessionId: 'session' })).items[0];
    assert.equal(proposal.authority, 'proposal_only');
    assert.equal(proposal.source.id, 'source');
    assert.equal(entries.size, 1);
  } finally { await close(); }
});
