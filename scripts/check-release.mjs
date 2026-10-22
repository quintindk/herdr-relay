import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// Run before packing. A tag cannot silently publish a different package version.
export function checkRelease({ root, rootLock, plugin, pluginLock, manifest, tag = '', notesExist }) {
  const version = root.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
  for (const value of [rootLock.version, rootLock.packages[''].version, plugin.version,
    pluginLock.version, pluginLock.packages[''].version]) assert.equal(value, version, 'Release version metadata differs');
  assert.match(manifest, new RegExp(`^version = "${version.replaceAll('.', '\\.')}"$`, 'm'));
  if (tag) assert.equal(tag, `v${version}`, 'Tag must match the exact package version');
  assert.equal(notesExist, true, 'Version-specific release notes are required');
  return { version, tag: tag || null };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  const root = json('package.json');
  console.log(JSON.stringify(checkRelease({ root, rootLock: json('package-lock.json'),
    plugin: json('packages/opencode-relay/package.json'), pluginLock: json('packages/opencode-relay/package-lock.json'),
    manifest: readFileSync('herdr-plugin.toml', 'utf8'), tag: process.env.RELEASE_TAG,
    notesExist: existsSync(`docs/release-${root.version}.md`) })));
}
