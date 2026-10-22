#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { call } from './client.mjs';
import { requireValue } from './protocol.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    context: { type: 'string' }, execution: { type: 'string' }, run: { type: 'string' }, key: { type: 'string' }, file: { type: 'string' },
  } });
  const action = positionals[0];
  const agentAction = ['questions', 'answer', 'forward', 'tasks', 'task', 'comments', 'relations', 'agents', 'status', 'schedules',
    'schedule-install', 'schedule-pause', 'schedule-resume', 'schedule-cancel', 'interactive-context', 'interactive-grants', 'interactive-status',
    'interactive-prepare', 'interactive-dispatch', 'interactive-cancel'].includes(action);
  requireValue((agentAction || ['read', 'ask', 'submit', 'delegate', 'wait-children', 'delay', 'review-child', 'children'].includes(action) && values.execution && values.run) && values.context,
    'invalid_request', 'Usage: node-worker-cli read|ask|submit --context FILE --execution ID --run ID [--key KEY --file JSON]');
  const connection = JSON.parse(readFileSync(values.context, 'utf8'));
  const payload = values.file ? JSON.parse(readFileSync(values.file, 'utf8')) : undefined;
  const result = await call(connection, 'POST', agentAction ? `/agent/${action}` : `/work/${action}`, agentAction ? {
    ...(action.startsWith('schedule-') || ['interactive-prepare', 'interactive-dispatch', 'interactive-cancel'].includes(action) ? { payload } : payload ?? {}), ...(values.key ? { key: values.key } : {}),
  } : { executionId: values.execution, runId: values.run, ...(values.key ? { key: values.key } : {}), ...(payload ? { payload } : {}) });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(JSON.stringify({ code: error.code ?? 'worker_failed', message: error.message })); process.exitCode = 1;
});
