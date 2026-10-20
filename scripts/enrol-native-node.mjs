import { parseArgs } from 'node:util';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nativeBackendClient } from '../src/backend-client.mjs';
import { digest, requireValue } from '../src/protocol.mjs';

const { values } = parseArgs({ options: { owner: { type: 'string' }, output: { type: 'string' },
  id: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' }, 'state-dir': { type: 'string' } } });
requireValue(values.owner && values.output && values.id && values.name && values['state-dir'], 'invalid_request',
  'Usage: enrol-native-node --owner PRIVATE_CONTEXT --output NODE_CONFIG --id ID --name NAME --state-dir DIR [--url HTTPS_ORIGIN]');
const path = resolve(values.output);
if (existsSync(path)) {
  const previous = JSON.parse(readFileSync(path, 'utf8'));
  requireValue(previous.nodeId === values.id && previous.stateDirectory === resolve(values['state-dir']) &&
    (!values.url || previous.backend.url === values.url), 'configuration_conflict', 'Existing node config does not match requested identity');
  console.log(JSON.stringify({ state: 'existing', nodeId: previous.nodeId, config: path }));
} else {
  const owner = JSON.parse(readFileSync(values.owner, 'utf8'));
  const url = values.url ?? owner.url ?? 'http://127.0.0.1:3210';
  const api = nativeBackendClient({ ...owner, url });
  await api('POST', '/v1/commands', { key: `node-enrol:${digest(values.id)}`, action: 'node.enrol', payload: { id: values.id, name: values.name } });
  const credential = await api('POST', '/v1/node-credentials', { nodeId: values.id, key: `node-credential:${digest(values.id)}` });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ nodeId: values.id, stateDirectory: resolve(values['state-dir']),
    backend: { url, token: credential.token, ...(owner.cloudflareAccess ? { cloudflareAccess: owner.cloudflareAccess } : {}) }, bindings: [] }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: 'enrolled', nodeId: values.id, config: path, bindings: 0 }));
}
