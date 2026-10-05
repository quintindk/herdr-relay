#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { call, credentials, stateDirectory } from './client.mjs';
import { startService } from './service.mjs';
import { requireValue } from './protocol.mjs';
import { candidate } from './candidate.mjs';
import { systemdUnit, installService, uninstallService } from './installation.mjs';
import { renderOverview, watchOverview } from './views.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const help = `herdr-relay (development)
  service --paperclip-url URL [--state-dir DIR] [--backend-context FILE] [--herdr-config FILE]
  status
  company provision --file company.json
  agent list
  agent discover
  agent observed
  agent prepare-pull|release-pull --file reservation.json
  agent configure-bridge|arm-bridge|disarm-bridge --file bridge.json
  agent register --file binding.json --context-out worker.json
  agent rebind --file continuation.json
  agent provision --file agent.json
  agent controller --file controller.json
  agent rotate ID --key KEY --context-out FILE
  work list
  work inspect RUN
  work read RUN
  work acknowledge RUN
  work submit RUN --key KEY --summary-file FILE --candidate ID
  work submit RUN --file submission.json
  work progress RUN --key KEY --summary-file FILE
  work ask RUN --key KEY --question-file FILE
  work interactions RUN
  task list RUN
  task inspect RUN --task CHILD_ID
  work wait-child RUN --task CHILD_ID
  task create RUN --key KEY --file task.json
  task create --company COMPANY_ID --key KEY --file task.json
  task assign RUN --key KEY --file assignment.json
  task update RUN --key KEY --file changes.json [--task TARGET_TASK_ID]
  work answer RUN --key KEY --interaction ID --file answers.json
  candidate inspect --directory REPOSITORY_ROOT
  result request|inspect|accept|reject CALLER_RUN --file review.json
  result retire CALLER_RUN --file review.json
  result check CALLER_RUN --file evidence.json
  resource provision|finalise|retire|reconcile --file resource.json
  runtime launch|stop|resume --file runtime.json
  inbox list
  inbox read EVENT_ID
  inbox wait [--timeout SECONDS]
  inbox acknowledge EVENT_ID
  event record --file event.json
  event checkpoint --source SOURCE
  view [--watch]
  service-unit --paperclip-url URL [--state-dir DIR]
  install --paperclip-url URL [--state-dir DIR] [--backend-context FILE] [--herdr-config FILE]
  uninstall [--state-dir DIR]
  schedule create|stop --file schedule.json
  placement bind|reconcile --file placement.json
  operation inspect OPERATION_ID
  operation list
  backend recover RUN
  operation cancel RUN
  operation settle RUN --outcome completed|cancelled|failed|waiting --evidence TEXT
  operator-context --context-out FILE

Protocol responses are JSON. View and service-unit commands render text.
Use --context FILE or RELAY_CONTEXT for scoped credentials.
Operator credentials default to $XDG_STATE_HOME/herdr-relay/admin-token.
Pull settlement is operator-attested. Native settlement requires a matching
terminal response. Automatic interruption requires a dedicated owned runtime.`;

export async function main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(
    ['context', 'file', 'context-out', 'paperclip-url', 'state-dir', 'key', 'company', 'summary-file', 'question-file', 'candidate', 'outcome', 'evidence', 'interaction', 'directory', 'source', 'backend-context', 'herdr-config', 'task', 'timeout']
      .map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['watch', { type: 'boolean' }]])) });
  const [group, action, id] = positionals;
  if (values.company !== undefined) requireValue(group === 'task' && action === 'create' && !id,
    'invalid_request', '--company is only valid for operator task creation without RUN_ID');
  if (group === 'adapter-stdio') {
    const { serveAdapterStdio } = await import('./remote-adapter.mjs');
    await serveAdapterStdio();
    return;
  }
  if (values.help || !group) { console.log(help); return; }
  if (group === 'candidate' && action === 'inspect') {
    console.log(JSON.stringify(candidate(values.directory ?? process.cwd()), null, 2));
    return;
  }
  if (values['state-dir']) process.env.RELAY_STATE_DIR = values['state-dir'];
  if (['service-unit', 'install', 'uninstall'].includes(group)) {
    const config = { node: process.execPath, cli: fileURLToPath(import.meta.url), stateDirectory: stateDirectory(),
      paperclipUrl: values['paperclip-url'], backendContextFile: values['backend-context'], herdrConfigFile: values['herdr-config'] };
    console.log(group === 'service-unit' ? systemdUnit(config) : JSON.stringify(group === 'install' ? installService(config) : uninstallService(stateDirectory())));
    return;
  }
  if (group === 'service') {
    requireValue(values['paperclip-url'], 'invalid_request', '--paperclip-url is required');
    const service = await startService({ directory: stateDirectory(), paperclipUrl: values['paperclip-url'], backendContextFile: values['backend-context'], herdrConfigFile: values['herdr-config'] });
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
  if (group === 'view' && values.watch) {
    await watchOverview(() => call(credentials(values.context), 'GET', '/overview'));
    return;
  }
  const connection = credentials(values.context);
  const writeContext = data => {
    requireValue(values['context-out'], 'invalid_request', '--context-out is required');
    writeFileSync(values['context-out'], `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 });
  };
  let result;
  if (group === 'status') result = await call(connection, 'GET', '/health');
  else if (group === 'company' && action === 'provision') {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', '/companies/provision', JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'backend' && action === 'recover' && id) result = await call(connection, 'POST', '/backend/recover', { runId: id });
  else if (group === 'operation' && action === 'inspect' && id) result = await call(connection, 'POST', '/operations/inspect', { id });
  else if (group === 'operation' && action === 'list') result = await call(connection, 'GET', '/operations');
  else if (group === 'placement' && ['bind', 'reconcile'].includes(action)) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/placement/${action}`, JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'schedule' && ['create', 'stop'].includes(action)) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', action === 'create' ? '/schedules' : '/schedules/stop', JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'runtime' && ['launch', 'stop', 'resume'].includes(action)) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/runtimes/${action}`, JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'view') {
    if (values.watch) await watchOverview(() => call(connection, 'GET', '/overview'));
    else console.log(renderOverview(await call(connection, 'GET', '/overview')));
    return;
  }
  else if (group === 'inbox' && action === 'list') result = await call(connection, 'GET', '/inbox');
  else if (group === 'inbox' && action === 'read' && id) {
    result = (await call(connection, 'GET', '/inbox')).find(event => event.id === id);
    requireValue(result, 'event_not_found', 'Event is not in your inbox', 404);
  }
  else if (group === 'inbox' && action === 'wait') {
    const timeout = Number(values.timeout ?? 60);
    requireValue(Number.isFinite(timeout) && timeout > 0 && timeout <= 86400, 'invalid_timeout', 'Timeout must be between 0 and 86400 seconds');
    const end = Date.now() + timeout * 1000;
    do {
      result = (await call(connection, 'GET', '/inbox')).filter(event => event.state === 'unread');
      if (result.length || Date.now() >= end) break;
      await delay(Math.min(1000, end - Date.now()));
    } while (true);
  }
  else if (group === 'inbox' && action === 'acknowledge' && id) result = await call(connection, 'POST', '/inbox/acknowledge', { eventId: id });
  else if (group === 'event' && action === 'checkpoint') result = await call(connection, 'POST', '/checkpoint', { source: values.source });
  else if (group === 'event' && action === 'record') {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', '/events', JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'resource' && ['provision', 'finalise', 'retire', 'reconcile'].includes(action)) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/resources/${action === 'provision' ? 'worktree' : action}`, JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'operator-context') {
    await call(connection, 'GET', '/bindings');
    writeContext(connection);
    result = { written: values['context-out'] };
  } else if (group === 'agent' && action === 'list') result = await call(connection, 'GET', '/bindings');
  else if (group === 'agent' && action === 'discover') result = await call(connection, 'GET', '/peers');
  else if (group === 'agent' && action === 'observed') result = await call(connection, 'GET', '/herdr/agents');
  else if (group === 'agent' && ['prepare-pull', 'release-pull', 'configure-bridge', 'arm-bridge', 'disarm-bridge'].includes(action)) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/herdr/${action}`, JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'agent' && action === 'rebind') {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', '/bindings/rebind', JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'agent' && action === 'provision') {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', '/agents/provision', JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'agent' && action === 'controller') {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', '/bindings/controller', JSON.parse(readFileSync(values.file, 'utf8')));
  }
  else if (group === 'agent' && action === 'rotate' && id) {
    requireValue(values['context-out'], 'invalid_request', '--context-out is required');
    if (existsSync(values['context-out'])) {
      const existing = JSON.parse(readFileSync(values['context-out'], 'utf8'));
      requireValue(existing.bindingId === id && existing.socketPath === connection.socketPath,
        'context_conflict', 'Output context belongs to another binding');
    }
    result = await call(connection, 'POST', '/bindings/credential', { id, key: values.key });
    writeFileSync(values['context-out'], `${JSON.stringify({ socketPath: connection.socketPath, bindingId: id,
      token: result.token, credentialGeneration: result.binding.credentialGeneration })}\n`, { mode: 0o600 });
    delete result.token;
  }
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
  else if (group === 'work' && action === 'progress' && id) {
    requireValue(values['summary-file'], 'invalid_request', '--summary-file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/progress`, {
      key: values.key, summary: readFileSync(values['summary-file'], 'utf8'),
    });
  }
  else if (group === 'work' && action === 'interactions' && id) result = await call(connection, 'GET', `/runs/${encodeURIComponent(id)}/interactions`);
  else if (group === 'result' && ['request', 'inspect', 'accept', 'reject', 'retire', 'check'].includes(action) && id) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/${action === 'retire' ? 'retire' : action === 'check' ? 'reviewer-check' : 'review'}`, {
      ...JSON.parse(readFileSync(values.file, 'utf8')), action,
    });
  }
  else if (group === 'task' && action === 'list' && id) result = await call(connection, 'GET', `/runs/${encodeURIComponent(id)}/tasks`);
  else if (id && ((group === 'task' && action === 'inspect') || (group === 'work' && action === 'wait-child'))) {
    requireValue(values.task, 'invalid_request', '--task CHILD_ID is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/${action === 'inspect' ? 'child' : 'wait-child'}`, { taskId: values.task });
  }
  else if (group === 'task' && action === 'create' && !id) {
    requireValue(values.company && values.key && values.file, 'invalid_request', '--company, --key and --file are required without RUN_ID');
    result = await call(connection, 'POST', '/tasks', {
      companyId: values.company, key: values.key, payload: JSON.parse(readFileSync(values.file, 'utf8')),
    });
  }
  else if (id && ((group === 'task' && ['create', 'assign', 'update'].includes(action)) || (group === 'work' && action === 'answer'))) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/mutate`, {
      key: values.key, kind: group === 'task' ? `task.${action}` : 'question.answer',
      interactionId: values.interaction, taskId: values.task, payload: JSON.parse(readFileSync(values.file, 'utf8')),
    });
  }
  else if (group === 'work' && action === 'ask' && id) {
    requireValue(values['question-file'], 'invalid_request', '--question-file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/ask`, {
      key: values.key, question: readFileSync(values['question-file'], 'utf8'),
    });
  }
  else if (group === 'work' && action === 'submit' && id) {
    requireValue(values.file || values['summary-file'], 'invalid_request', '--file or --summary-file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/submit`, values.file ? JSON.parse(readFileSync(values.file, 'utf8')) : {
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
