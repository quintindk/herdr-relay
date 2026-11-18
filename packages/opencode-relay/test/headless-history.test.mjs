import assert from 'node:assert/strict';
import test from 'node:test';
import { portableHeadlessHistory } from '../headless-history.mjs';

test('headless history carries inline text and tool pairs, not old Responses state', () => {
  const user = { id: 'new', role: 'user', content: [{ type: 'text', text: 'Next cron' }] };
  const current = { role: 'assistant', content: [{ type: 'tool-call', id: 'call_live', providerMetadata: { openresponses: { itemId: 'fc_live' } } }] };
  const earlier = { id: 'old', role: 'assistant', native: { responseId: 'resp_old', serviceTier: 'auto' },
    content: [
      { type: 'text', text: 'Earlier result', providerMetadata: { openai: { itemId: 'msg_old', phase: 'final_answer' }, other: { itemId: 'keep' } } },
      { type: 'reasoning', text: '', providerMetadata: { openresponses: { itemId: 'rs_old', reasoningEncryptedContent: 'opaque' } } },
      { type: 'tool-call', id: 'call_old', name: 'relay_work_submit', input: { key: 'done' }, providerMetadata: { 'openai-compatible': { itemId: 'fc_old' } } },
    ] };
  const tool = { role: 'tool', content: [{ type: 'tool-result', id: 'call_old', name: 'relay_work_submit', result: { type: 'text', value: 'Recorded' } }] };
  const checkpoint = { role: 'assistant', content: [{ type: 'compaction', provider: 'github-copilot', id: 'cp_old', encrypted: 'opaque' }] };
  const messages = [checkpoint, earlier, tool, user, current];
  const before = structuredClone(messages);
  const projected = portableHeadlessHistory(messages, user.id);
  assert.deepEqual(messages, before);
  assert.deepEqual(projected[0].native, { serviceTier: 'auto' });
  assert.deepEqual(projected[0].content[0], { type: 'text', text: 'Earlier result', providerMetadata: { openai: { phase: 'final_answer' }, other: { itemId: 'keep' } } });
  assert.equal(projected[0].content.length, 2);
  assert.deepEqual(projected[0].content[1].providerMetadata, {});
  assert.equal(projected[0].content[1].id, projected[1].content[0].id);
  assert.equal(projected[1], tool);
  assert.equal(projected[2], user);
  assert.equal(projected[3], current);
});

test('a compacted window without the exact user anchor carries only portable Responses history', () => {
  const message = { id: 'missing-user', role: 'assistant', content: [
    { type: 'compaction', provider: 'github-copilot', text: 'Portable summary' },
    { type: 'text', text: 'Recorded', providerMetadata: { 'github-copilot': { itemId: 'msg_old' } } },
  ] };
  const [projected] = portableHeadlessHistory([message], 'missing-user');
  assert.equal(projected.content[0], message.content[0]);
  assert.deepEqual(projected.content[1].providerMetadata, {});
  assert.equal(projected.content[1].text, 'Recorded');
});

test('reasoning and context from unrelated protocols are not scrubbed', () => {
  const message = { role: 'assistant', content: [
    { type: 'reasoning', text: '', encrypted: 'opaque', providerMetadata: { anthropic: { signature: 'fixture' } } },
    { type: 'compaction', provider: 'anthropic', text: 'Summary' },
  ] };
  assert.equal(portableHeadlessHistory([message])[0], message);
});
