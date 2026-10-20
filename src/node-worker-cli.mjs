#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { call } from './client.mjs';
import { requireValue } from './protocol.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    context: { type: 'string' }, execution: { type: 'string' }, run: { type: 'string' }, key: { type: 'string' }, file: { type: 'string' },
  } });
  const action = positionals[0];
  const agentAction = ['questions', 'answer', 'forward', 'tasks', 'task', 'comments', 'relations', 'agents'].includes(action);
  requireValue((agentAction || ['read', 'ask', 'submit', 'delegate', 'wait-children', 'delay', 'review-child', 'children'].includes(action) && values.execution && values.run) && values.context,
    'invalid_request', 'Usage: node-worker-cli read|ask|submit --context FILE --execution ID --run ID [--key KEY --file JSON]');
  const connection = JSON.parse(readFileSync(values.context, 'utf8'));
  const payload = values.file ? JSON.parse(readFileSync(values.file, 'utf8')) : undefined;
  const result = await call(connection, 'POST', agentAction ? `/agent/${action}` : `/work/${action}`, agentAction ? {
    ...(payload ?? {}), ...(values.key ? { key: values.key } : {}),
  } : { executionId: values.execution, runId: values.run, ...(values.key ? { key: values.key } : {}), ...(payload ? { payload } : {}) });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'worker_failed', message: error.message })); process.exitCode = 1;
}
