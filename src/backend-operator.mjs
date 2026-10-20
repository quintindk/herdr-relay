#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { nativeBackendClient } from './backend-client.mjs';
import { requireValue } from './protocol.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    context: { type: 'string' }, file: { type: 'string' }, url: { type: 'string' }, cursor: { type: 'string' },
  } });
  requireValue(values.context, 'invalid_request', 'Explicit private context required');
  const context = JSON.parse(readFileSync(values.context, 'utf8'));
  const api = nativeBackendClient({ ...context, url: values.url ?? context.url ?? 'http://127.0.0.1:3210' });
  const [action, collection, id] = positionals;
  let result;
  if (action === 'command') {
    requireValue(values.file, 'invalid_request', 'Command JSON file required');
    result = await api('POST', '/v1/commands', JSON.parse(readFileSync(values.file, 'utf8')));
  } else if (action === 'read') {
    requireValue(['info', 'tasks', 'comments', 'executions', 'questions', 'agents', 'nodes', 'events', 'schedules', 'occurrences'].includes(collection), 'invalid_request', 'Known collection required');
    result = await api('GET', `/v1/${collection}${id ? `/${encodeURIComponent(id)}` : ''}${values.cursor ? `?cursor=${encodeURIComponent(values.cursor)}` : ''}`);
  } else requireValue(false, 'invalid_request', 'Use command --file FILE or read COLLECTION [ID]');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'operator_failed', message: error.message })); process.exitCode = 1;
}
