import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { exportPaperclipTasks, planPaperclipImport, importPaperclipTasks } from '../src/paperclip-migration.mjs';
import { BackendStore } from '../src/backend-store.mjs';
import { serviceLock } from '../src/service-lock.mjs';
import { requireValue } from '../src/protocol.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string' }, company: { type: 'string' }, output: { type: 'string' }, file: { type: 'string' },
    owner: { type: 'string' }, 'state-dir': { type: 'string' }, 'confirm-digest': { type: 'string' },
    'source-frozen': { type: 'boolean' }, 'legacy-relay-settled': { type: 'boolean' },
  } });
  const action = positionals[0];
  requireValue(['export', 'plan', 'import'].includes(action), 'invalid_request', 'Use export, plan or import');
  if (action === 'export') {
    requireValue(values.source && values.company && values.output, 'invalid_request', 'Export requires --source PRIVATE_CONTEXT --company ID --output NEW_FILE');
    const config = JSON.parse(readFileSync(values.source, 'utf8'));
    const origin = new URL(config.url);
    requireValue(!origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash &&
      (origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname)) &&
      (typeof config.token === 'string' && config.token || config.localTrusted === true && origin.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(origin.hostname)), 'invalid_source', 'Explicit source origin and operator token or loopback localTrusted required');
    const api = async (method, path) => {
      requireValue(method === 'GET' && path.startsWith('/api/'), 'invalid_request', 'Export is read-only');
      const response = await fetch(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} });
      requireValue(response.ok && response.headers.get('content-type')?.includes('application/json'),
        'source_read_failed', `Paperclip returned HTTP ${response.status}`);
      return response.json();
    };
    const bundle = await exportPaperclipTasks(api, { sourceUrl: origin.origin, companyId: values.company });
    writeFileSync(resolve(values.output), `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const { ordered, ...plan } = planPaperclipImport(bundle);
    console.log(JSON.stringify({ state: 'exported', file: resolve(values.output), ...plan }, null, 2));
  } else {
    requireValue(values.file, 'invalid_request', 'Explicit --file export.json required');
    const bundle = JSON.parse(readFileSync(resolve(values.file), 'utf8'));
    const { ordered, ...plan } = planPaperclipImport(bundle);
    if (action === 'plan') {
      if (values.output) {
        writeFileSync(resolve(values.output), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ state: 'planned', file: resolve(values.output), ready: plan.ready, counts: plan.counts, digest: plan.digest }));
      } else console.log(JSON.stringify(plan, null, 2));
    }
    else {
      requireValue(values.owner && values['state-dir'] && values['confirm-digest'] === bundle.digest &&
        values['source-frozen'] && values['legacy-relay-settled'], 'cutover_required',
      'Import requires --owner FILE --state-dir DIR --confirm-digest DIGEST --source-frozen --legacy-relay-settled');
      const owner = JSON.parse(readFileSync(values.owner, 'utf8'));
      const directory = resolve(values['state-dir']);
      requireValue(existsSync(join(directory, 'backend.sqlite')), 'backend_not_found', 'Import requires an existing initialised backend database');
      const unlock = serviceLock(directory);
      let store;
      try {
        store = new BackendStore(join(directory, 'backend.sqlite'), { userId: owner.userId ?? 'owner' });
        const receipt = importPaperclipTasks(store, store.authenticate(owner.token), bundle);
        console.log(JSON.stringify({ state: 'imported', ...receipt }, null, 2));
      } finally { store?.close(); unlock(); }
    }
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'migration_failed', message: error.message }));
  process.exitCode = 1;
}
