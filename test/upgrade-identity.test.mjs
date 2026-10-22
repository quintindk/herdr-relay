import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { identityFingerprint } from '../src/upgrade-safety.mjs';

test('only generated node index JSON is canonicalised; changed mapping and private file bytes still change identity', t => {
  const root = mkdtempSync('/tmp/opencode/upgrade-identity-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const index = join(root, 'worker-index.json'), credential = join(root, 'operator.json');
  writeFileSync(index, '{"nodeId":"node","sessions":{"ses_a":"a","ses_b":"b"}}');
  writeFileSync(credential, '{"token":"same","userId":"owner"}');
  const identity = { instanceId: 'backend', nodeId: 'node', files: [index, credential] };
  const before = identityFingerprint(identity), legacy = identityFingerprint(identity, 1);
  writeFileSync(index, '{ "sessions": { "ses_b": "b", "ses_a": "a" }, "nodeId": "node" }\n');
  assert.equal(identityFingerprint(identity), before); assert.notEqual(identityFingerprint(identity, 1), legacy);
  writeFileSync(index, '{"sessions":{"ses_a":"other","ses_b":"b"},"nodeId":"node"}');
  assert.notEqual(identityFingerprint(identity), before);
  writeFileSync(index, '{"nodeId":"node","sessions":{"ses_a":"a","ses_b":"b"}}');
  writeFileSync(credential, '{"userId":"owner","token":"same"}');
  assert.notEqual(identityFingerprint(identity), before);
  assert.throws(() => identityFingerprint(identity, 3), { code: 'upgrade_incompatible' });
  writeFileSync(index, 'invalid JSON'); assert.throws(() => identityFingerprint(identity));
});
