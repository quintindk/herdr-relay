import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readPrivateJson } from './private-files.mjs';
import { requireValue, RelayError } from './protocol.mjs';

// Plugin IDs scope SDK storage. Never abandon a confirmed or uncertain command
// under an earlier ID. Empty old files stay intact for rollback and inspection.
export function assertNoPendingRelayOutboxes(stateDirectory) {
  if (!existsSync(stateDirectory)) return { outboxesChecked: 0 };
  let outboxesChecked = 0;
  for (const channel of readdirSync(stateDirectory, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const directory = join(stateDirectory, channel.name, 'tui');
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter(name => /^plugin\.herdr\.relay\..*\.(?:enrolment|human)-outbox\.json$/.test(name))) {
      let state;
      try { state = readPrivateJson(join(directory, name)); }
      catch { throw new RelayError('upgrade_plugin_state_unavailable', 'Cannot inspect a durable Relay outbox. No pending command was discarded', 409); }
      requireValue(state && typeof state === 'object' && !Array.isArray(state), 'upgrade_plugin_state_unavailable', 'Unsupported durable Relay outbox');
      requireValue(Object.entries(state).every(([key, value]) => ['pending', 'sessionCreation'].includes(key) && value === null),
        'upgrade_pending_decisions', 'A durable Relay outbox contains pending or unrecognised state. Reconcile it with the installed plugin before upgrading. Its original key and payload are unchanged', 409);
      outboxesChecked++;
    }
  }
  return { outboxesChecked };
}

// OpenCode configuration reload cancels pending forms/permissions. Inspect known
// running services only, without starting/reloading one or resolving a decision.
export async function assertNoOpenCodeDecisions({ nodeConfig, configDirectory }, dependencies = {}) {
  const standard = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode');
  const canonical = path => existsSync(path) ? realpathSync(path) : resolve(path);
  const outboxes = dependencies.stateDirectory || configDirectory && canonical(configDirectory) === canonical(standard)
    ? assertNoPendingRelayOutboxes(dependencies.stateDirectory ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'opencode'))
    : { outboxesChecked: 0 };
  let clients = dependencies.clients;
  if (!clients) {
    const [{ OpenCode }, { Service }] = await Promise.all([import('@opencode/client'), import('@opencode/client/service')]);
    const config = readPrivateJson(nodeConfig), endpoints = new Map();
    const db = new DatabaseSync(join(config.stateDirectory, 'node.sqlite'), { readOnly: true });
    let entries;
    try { entries = [...(config.bindings ?? []), ...db.prepare("SELECT value FROM settings WHERE key LIKE 'native-binding:%'").all().map(row => JSON.parse(row.value))]; }
    finally { db.close(); }
    for (const entry of entries) if (entry.harness?.startsWith('opencode-v2') && entry.url && entry.authFile) {
      const url = new URL(entry.url);
      requireValue(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password,
        'upgrade_plugin_state_unavailable', 'Only existing authenticated local OpenCode services may be inspected');
      const auth = readPrivateJson(entry.authFile);
      requireValue(typeof auth.password === 'string' && auth.password, 'upgrade_plugin_state_unavailable', 'Existing native authentication is unavailable');
      endpoints.set(url.origin, { url: url.origin, auth: { type: 'basic', username: 'opencode', password: auth.password } });
    }
    if (canonical(configDirectory) === canonical(standard)) {
      const endpoint = await (dependencies.discover ?? Service.discover)({ version: version => version.startsWith('2.') });
      if (endpoint) endpoints.set(new URL(endpoint.url).origin, endpoint);
    }
    clients = [...endpoints.values()].map(endpoint => {
      const url = new URL(endpoint.url);
      requireValue(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) && endpoint.auth?.type === 'basic' && endpoint.auth.username === 'opencode',
        'upgrade_plugin_state_unavailable', 'Existing authenticated OpenCode 2 service required');
      return OpenCode.make({ baseUrl: url.origin, headers: Service.headers(endpoint),
        fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(5000) }) });
    });
  }
  const result = { servicesChecked: clients.length, locationsChecked: 0, pendingForms: 0, pendingPermissions: 0, ...outboxes };
  try {
    for (const client of clients) {
      const locations = await client.debug.location.list();
      requireValue(Array.isArray(locations) && locations.length <= 500, 'upgrade_plugin_state_unavailable', 'Bounded loaded-location inspection is required');
      for (const location of locations) {
        const [forms, permissions] = await Promise.all([client.form.list({ location }), client.permission.request.list({ location })]);
        requireValue(Array.isArray(forms.data) && Array.isArray(permissions.data), 'upgrade_plugin_state_unavailable', 'Pending-decision inspection returned an unsupported response');
        result.locationsChecked++; result.pendingForms += forms.data.length; result.pendingPermissions += permissions.data.length;
      }
    }
  } catch (error) {
    if (error.code === 'upgrade_plugin_state_unavailable') throw error;
    throw new RelayError('upgrade_plugin_state_unavailable', 'Cannot verify pending OpenCode decisions. Existing services/configuration are unchanged', 503);
  }
  requireValue(result.pendingForms === 0 && result.pendingPermissions === 0, 'upgrade_pending_decisions',
    'OpenCode has pending forms or permission requests. Resolve/close them before reloading the Relay plugin; none were approved or cancelled', 409);
  return result;
}
