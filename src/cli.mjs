#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { call, credentials, stateDirectory } from './client.mjs';
import { startService } from './service.mjs';
import { requireValue } from './protocol.mjs';

const help = `herdr-relay (development)
  service --paperclip-url URL [--state-dir DIR]
  status
  agent list
  agent register --file binding.json --context-out worker.json
  work list
  work inspect RUN
  work read RUN
  work acknowledge RUN
  work submit RUN --key KEY --summary-file FILE --candidate ID
  operation cancel RUN
  operation settle RUN --outcome completed|cancelled|failed --evidence TEXT
  operator-context --context-out FILE

All responses are JSON. Use --context FILE or RELAY_CONTEXT for scoped credentials.
Operator credentials default to $XDG_STATE_HOME/herdr-relay/admin-token.
Pull settlement is operator-attested. Native OpenCode settlement requires a
matching terminal response. Cancellation does not automatically interrupt OpenCode.`;

export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(
    ['context', 'file', 'context-out', 'paperclip-url', 'state-dir', 'key', 'summary-file', 'candidate', 'outcome', 'evidence']
      .map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  const [group, action, id] = positionals;
  if (values.help || !group) { console.log(help); return; }
  if (values['state-dir']) process.env.RELAY_STATE_DIR = values['state-dir'];
  if (group === 'service') {
    requireValue(values['paperclip-url'], 'invalid_request', '--paperclip-url is required');
    const service = await startService({ directory: stateDirectory(), paperclipUrl: values['paperclip-url'] });
    console.log(JSON.stringify({ listening: service.socketPath }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await service.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const connection = credentials(values.context);
  const writeContext = data => {
    requireValue(values['context-out'], 'invalid_request', '--context-out is required');
    writeFileSync(values['context-out'], `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 });
  };
  let result;
  if (group === 'status') result = await call(connection, 'GET', '/health');
  else if (group === 'operator-context') {
    await call(connection, 'GET', '/bindings');
    writeContext(connection);
    result = { written: values['context-out'] };
  } else if (group === 'agent' && action === 'list') result = await call(connection, 'GET', '/bindings');
  else if (group === 'agent' && action === 'register') {
    requireValue(values.file && values['context-out'], 'invalid_request', '--file and --context-out are required');
    // A lost registration response is recoverable by repeating identical input.
    // Never overwrite a context belonging to another binding.
    const input = JSON.parse(readFileSync(values.file, 'utf8'));
    if (existsSync(values['context-out'])) {
      const existing = JSON.parse(readFileSync(values['context-out'], 'utf8'));
      requireValue(existing.bindingId === input.id && existing.socketPath === connection.socketPath,
        'context_conflict', 'Context file belongs to a different binding');
    }
    result = await call(connection, 'POST', '/bindings', input);
    if (result.token) writeFileSync(values['context-out'], `${JSON.stringify({ socketPath: connection.socketPath, token: result.token, bindingId: result.binding.id })}\n`, { mode: 0o600 });
    delete result.token;
  } else if (group === 'work' && action === 'list') result = await call(connection, 'GET', '/runs');
  else if (group === 'work' && action === 'inspect' && id) result = await call(connection, 'GET', `/runs/${encodeURIComponent(id)}`);
  else if (group === 'work' && action === 'read' && id) result = {
    run: await call(connection, 'GET', `/runs/${encodeURIComponent(id)}`),
    task: await call(connection, 'GET', `/runs/${encodeURIComponent(id)}/task`),
  };
  else if (group === 'work' && action === 'acknowledge' && id) result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/acknowledge`, {});
  else if (group === 'work' && action === 'submit' && id) {
    requireValue(values['summary-file'], 'invalid_request', '--summary-file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/submit`, {
      key: values.key, summary: readFileSync(values['summary-file'], 'utf8'), candidate: values.candidate,
    });
  } else if (group === 'operation' && action === 'cancel' && id) result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/cancel`, {});
  else if (group === 'operation' && action === 'settle' && id) result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/settle`, { outcome: values.outcome, evidence: values.evidence });
  else throw new Error(help);
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ code: error.code ?? 'command_failed', message: error.message }));
  process.exitCode = 1;
});
