import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requireValue } from './protocol.mjs';

export const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const releaseVersion = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8')).version;
export const compatibility = Object.freeze({ protocol: 'relay/0.2', backendSchema: 1, nodeSchema: 1 });
function fingerprint(directory) {
  const hash = createHash('sha256');
  const visit = relative => {
    const path = join(directory, relative), stat = lstatSync(path);
    requireValue(!stat.isSymbolicLink(), 'invalid_release', 'Installed Relay package content must not contain symlinks');
    if (stat.isDirectory()) for (const name of readdirSync(path).sort().filter(name => !['node_modules', '.git', '.firecrawl'].includes(name))) visit(join(relative, name));
    else { requireValue(stat.isFile(), 'invalid_release', 'Only regular package files are supported'); hash.update(`${relative}\0${stat.mode & 0o111}\0`); hash.update(readFileSync(path)); hash.update('\0'); }
  };
  visit(''); return hash.digest('hex');
}
export function releaseInfo(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  requireValue(manifest.name === 'herdr-relay' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version), 'invalid_release', 'A versioned Relay package is required');
  // RC4 predates compatibility metadata. It is the sole explicit adoption baseline.
  const contract = manifest.relayCompatibility ?? (manifest.version === '0.2.0-rc.4' ? compatibility : null);
  requireValue(contract && Object.keys(compatibility).every(key => contract[key] === compatibility[key]),
    'upgrade_incompatible', 'Only explicitly compatible relay/0.2, schema-1 upgrades and rollbacks are supported');
  return { directory, version: manifest.version, compatibility: contract, fingerprint: fingerprint(directory) };
}
