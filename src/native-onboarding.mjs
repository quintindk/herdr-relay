import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { nativeBackendClient } from './backend-client.mjs';
import { digest, requireValue } from './protocol.mjs';
import { writePrivateJson, createPrivateJson, readPrivateJson } from './private-files.mjs';
import { DatabaseSync } from 'node:sqlite';
import { canonicalDirectory } from './interactive-contract.mjs';

export const defaultNodeConfig = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-native/node.json');
export const defaultOwnerContext = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend/owner.json');
export const defaultOperatorContext = (configFile = defaultNodeConfig()) => join(dirname(resolve(configFile)), 'operator.json');
export const boardContext = () => existsSync(defaultOperatorContext()) ? defaultOperatorContext() : defaultOwnerContext();
export const contextClient = context => nativeBackendClient({ ...context, url: context.url ?? 'http://127.0.0.1:3210' });

export function cloudflareTransportFromFile(file) {
  const entries = Object.fromEntries(readFileSync(file, 'utf8').split('\n').flatMap(line => {
    const match = /^\s*(?:export\s+)?(CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) return [];
    const value = match[2]; return [[match[1], /^("|').*\1$/.test(value) ? value.slice(1, -1) : value]];
  }));
  requireValue(entries.CF_ACCESS_CLIENT_ID && entries.CF_ACCESS_CLIENT_SECRET, 'missing_access_credentials', 'Private Access file must contain the existing service-token pair');
  return { cloudflareAccess: { clientId: entries.CF_ACCESS_CLIENT_ID, clientSecret: entries.CF_ACCESS_CLIENT_SECRET } };
}

export async function createNodeBundle({ api, output, key, name, url, mode, roots, maxAgents = 100, transport = {} }) {
  requireValue(output && key && name && url, 'invalid_request', 'Bootstrap requires --output, --key, --name and --url');
  requireValue(typeof key === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(key) && typeof name === 'string' && name.trim() && name.length <= 256 &&
    ['roots', 'localUser'].includes(mode) && (mode === 'localUser' ? roots === undefined || Array.isArray(roots) && !roots.length : Array.isArray(roots) && roots.length > 0 && roots.length <= 32 && roots.every(canonicalDirectory)) &&
    Number.isSafeInteger(maxAgents) && maxAgents > 0 && maxAgents <= 100, 'invalid_bootstrap', 'Validate the explicit node scope and enrolment limit before issuing credentials');
  requireValue(Object.keys(transport).every(k => ['cloudflareAccess', 'trustedHttpProxyOrigin'].includes(k)), 'invalid_transport', 'Only explicit ingress/proxy settings are supported');
  nativeBackendClient({ url, ...transport, token: 'transport-validation' });
  const path = resolve(output), intentPath = `${path}.intent`;
  requireValue(!existsSync(path) || existsSync(intentPath), 'configuration_conflict', 'Refuse issuing credentials over an unrelated existing output file');
  const info = await api('GET', '/v1/info');
  requireValue(info.features?.scopedNodeBootstrap, 'backend_upgrade_required', 'Backend must be upgraded before scoped node onboarding');
  if (existsSync(path)) requireValue(readPrivateJson(path).instanceId === info.instanceId,
    'backend_identity_mismatch', 'Existing bundle belongs to an old backend. Use a new output/key after an explicit reset');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const scope = { key, name, url, mode, ...(roots?.length ? { roots } : {}), maxAgents, transport };
  let intent;
  if (existsSync(intentPath)) {
    intent = readPrivateJson(intentPath);
    requireValue(intent.scopeDigest === digest(scope), 'operation_conflict', 'Bootstrap request changed under its original output/key');
  } else {
    intent = { scopeDigest: digest(scope), request: { key, id: `node_${randomUUID()}`, name, mode, ...(roots?.length ? { roots } : {}), maxAgents } };
    try { writePrivateJson(intentPath, intent, true); }
    catch (error) { if (error.code !== 'EEXIST') throw error; intent = readPrivateJson(intentPath); requireValue(intent.scopeDigest === digest(scope), 'operation_conflict', 'Concurrent bootstrap selected another request'); }
  }
  const result = await api('POST', '/v1/node-bootstrap', intent.request);
  const bundle = { format: 'relay-node-bootstrap/1', backend: { url, ...transport }, ...result };
  const created = createPrivateJson(path, bundle);
  return { state: created ? 'created' : 'existing', nodeId: result.nodeId, name: result.name, instanceId: result.instanceId, bundle: path,
    warning: 'Private file contains scoped bearer credentials. Transfer privately. Never send it to an agent or commit it.' };
}

export async function joinNode({ bundleFile, configFile = defaultNodeConfig() }) {
  requireValue(bundleFile, 'invalid_request', 'Explicit private --bundle required');
  requireValue((statSync(bundleFile).mode & 0o077) === 0, 'unsafe_permissions', 'Copy the bootstrap bundle into a private Linux directory with mode 0600 before joining');
  let bundle;
  try { bundle = JSON.parse(readFileSync(bundleFile, 'utf8')); } catch { requireValue(false, 'invalid_bundle', 'Cannot parse private node bundle'); }
  requireValue(bundle?.format === 'relay-node-bootstrap/1' && bundle.protocol === 'relay/0.2' && bundle.nodeId && bundle.instanceId && typeof bundle.backend?.url === 'string' &&
    bundle.nodeToken && bundle.operatorToken, 'invalid_bundle', 'A scoped native node bootstrap bundle is required');
  const nodeApi = contextClient({ ...bundle.backend, token: bundle.nodeToken });
  const operatorApi = contextClient({ ...bundle.backend, token: bundle.operatorToken });
  const [info, node, operator] = await Promise.all([nodeApi('GET', '/v1/info'), nodeApi('GET', '/v1/identity'), operatorApi('GET', '/v1/identity')]);
  requireValue(info.protocol === bundle.protocol && info.instanceId === bundle.instanceId && node.instanceId === bundle.instanceId && operator.instanceId === bundle.instanceId,
    'backend_identity_mismatch', 'Bundle belongs to a different backend instance. Do not reuse an old journal after reset');
  requireValue(node.type === 'node' && node.id === bundle.nodeId && !node.scope && operator.type === 'user' && operator.id === bundle.userId &&
    operator.scope?.kind === 'node_operator' && operator.scope.nodeId === bundle.nodeId, 'invalid_bundle', 'Node and scoped human/operator credentials must be distinct and correctly scoped');
  const path = resolve(configFile), directory = dirname(path);
  const config = { identityVersion: 2, nodeId: bundle.nodeId, name: bundle.name, stateDirectory: directory,
    backend: { ...bundle.backend, token: bundle.nodeToken }, bindings: [] };
  const operatorFile = defaultOperatorContext(path);
  const operatorContext = { protocol: bundle.protocol, instanceId: bundle.instanceId, nodeId: bundle.nodeId, userId: bundle.userId,
    ...bundle.backend, token: bundle.operatorToken, scope: operator.scope };
  // Validate every existing file before creating any new one. Existing node
  // config may contain additional operator policy, but its identity cannot move.
  if (existsSync(path)) {
    requireValue((statSync(path).mode & 0o077) === 0, 'unsafe_permissions', 'Existing node config must be private');
    const previous = readPrivateJson(path);
    requireValue(previous.identityVersion === 2 && previous.nodeId === config.nodeId && previous.stateDirectory === directory &&
      digest(previous.backend) === digest(config.backend), 'configuration_conflict', 'Existing node belongs to another identity or transport');
  }
  for (const [file, expected] of [[operatorFile, operatorContext], [join(directory, 'backend-instance.json'), { ...info, url: bundle.backend.url }]]) {
    if (existsSync(file)) {
      requireValue((statSync(file).mode & 0o077) === 0, 'unsafe_permissions', 'Existing node contexts must be private');
      const previous = readPrivateJson(file);
      requireValue(file === operatorFile ? digest(previous) === digest(expected) : previous.instanceId === bundle.instanceId && previous.url === bundle.backend.url,
        'backend_identity_mismatch', 'Existing local context is pinned to another backend. Archive it explicitly before joining');
    }
  }
  const journalFile = join(directory, 'node.sqlite');
  if (existsSync(journalFile)) {
    const journal = new DatabaseSync(journalFile, { readOnly: true });
    try {
      const row = journal.prepare('SELECT value FROM settings WHERE key=?').get('identity');
      const identity = row && JSON.parse(row.value);
      requireValue(identity?.nodeId === bundle.nodeId && identity.instanceId === bundle.instanceId, 'backend_identity_mismatch',
        'Existing journal belongs to another installation. Archive it explicitly; do not erase identity pins');
    } finally { journal.close(); }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = !existsSync(path);
  if (created) createPrivateJson(path, config);
  createPrivateJson(operatorFile, operatorContext);
  if (!existsSync(join(directory, 'backend-instance.json'))) createPrivateJson(join(directory, 'backend-instance.json'), { ...info, url: bundle.backend.url });
  requireValue((statSync(path).mode & 0o077) === 0 && (statSync(operatorFile).mode & 0o077) === 0, 'unsafe_permissions', 'Private node/operator contexts must not be accessible to other users');
  return { state: created ? 'joined' : 'existing', nodeId: bundle.nodeId, name: bundle.name, instanceId: bundle.instanceId,
    configFile: path, operatorContextFile: operatorFile, nodeStartManagedSeparately: true, rootOwnerCredentialTransferred: false };
}

export async function revokeNodeBundle({ api, bundleFile, key }) {
  requireValue(bundleFile && key, 'invalid_request', 'Explicit bundle and immutable revocation key required');
  const bundle = readPrivateJson(bundleFile);
  requireValue(bundle.format === 'relay-node-bootstrap/1', 'invalid_bundle', 'Scoped bootstrap bundle required');
  for (const [kind, credential] of [['node', bundle.nodeCredential], ['operator', bundle.operatorCredential]]) {
    requireValue(credential?.id, 'invalid_bundle', 'Bundle lacks credential revocation references');
    await api('POST', '/v1/commands', { key: `${key}:${kind}`, action: 'credential.revoke', payload: { id: credential.id } });
  }
  return { state: 'revoked', nodeId: bundle.nodeId, credentials: 2 };
}
