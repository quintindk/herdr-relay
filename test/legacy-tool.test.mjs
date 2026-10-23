import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '../src/legacy-tool.mjs';

test('legacy tool compatibility retains definition identity and exact strict Zod validation without the V1 SDK', async () => {
  const definition = { description: 'Scoped fixture', args: { key: tool.schema.string().min(1) }, execute: async input => input.key };
  assert.equal(tool(definition), definition);
  const schema = tool.schema.object(definition.args).strict();
  assert.deepEqual(schema.parse({ key: 'same-key' }), { key: 'same-key' });
  assert.equal(schema.safeParse({ key: '' }).success, false);
  assert.equal(schema.safeParse({ key: 'same-key', token: 'must-not-be-accepted' }).success, false);
  assert.equal(await tool(definition).execute({ key: 'same-key' }), 'same-key');
});
