import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRelease } from '../scripts/check-release.mjs';

function input() {
  const version = '0.2.0-rc.3';
  const lock = () => ({ version, packages: { '': { version } } });
  return { root: { version }, rootLock: lock(), plugin: { version }, pluginLock: lock(),
    manifest: `name = "herdr-relay"\nversion = "${version}"\n`, notesExist: true, tag: `v${version}` };
}

test('release metadata accepts aligned versions for a branch or exact version tag', () => {
  assert.deepEqual(checkRelease(input()), { version: '0.2.0-rc.3', tag: 'v0.2.0-rc.3' });
  assert.equal(checkRelease({ ...input(), tag: '' }).tag, null);
});

test('release metadata refuses mismatched tags, manifests, lockfiles and absent notes', () => {
  for (const update of [{ tag: 'v0.2.0-rc.2' }, { manifest: 'version = "0.2.0"' }, { notesExist: false },
    { plugin: { version: '0.2.0' } }, { rootLock: { version: '0.2.0', packages: { '': { version: '0.2.0' } } } }]) {
    assert.throws(() => checkRelease({ ...input(), ...update }));
  }
});
