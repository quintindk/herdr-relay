#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { call, credentials, stateDirectory } from './client.mjs';
import { startService } from './service.mjs';
import { requireValue } from './protocol.mjs';
import { candidate } from './candidate.mjs';
import { systemdUnit, installService, uninstallService } from './installation.mjs';
import { renderOverview, watchOverview } from './views.mjs';
import { renderTaskBoard, watchTaskBoard } from './task-board-view.mjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const help = `herdr-relay (development)
  service --paperclip-url URL [--state-dir DIR] [--backend-context FILE] [--herdr-config FILE]
  status
  company provision --file company.json
  agent list
  agent discover
  agent observed
  agent enrolment-candidates
  agent enrol --directory ABSOLUTE_PATH --key KEY --reserved
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
  task list RUN  [worker]
  task inspect RUN --task TASK_ID  [worker, same-company task and comments]
  task comment|reference-attach RUN --task TASK_ID --key KEY --file FILE
  task reference-lookup RUN --namespace NAMESPACE --external-id ID
  work wait-child RUN --task CHILD_ID
  work wait-children RUN --file FILE  (JSON: {"taskIds":["CHILD_ID",...]})
  task create RUN --key KEY --file task.json
  task create --company COMPANY_ID --key KEY --file task.json  [generic operator create, unchanged]
  task capture --company COMPANY_ID --key KEY --file capture.json  [human-safe create]
    Capture file: {"payload":{...},"externalReference":{"namespace":"...","externalId":"...","url":"https://..."}}; externalReference and url are optional.
  task list --company COMPANY_ID [--project ID] [--status todo,blocked] [--agent ID] [--user ID] [--parent ID] [--limit N] [--cursor TOKEN]  [runless query]
  task children --company COMPANY_ID --task TASK_ID [--project ID] [--status todo,blocked] [--agent ID] [--user ID] [--limit N] [--cursor TOKEN]  [runless query]
  task comments --company COMPANY_ID --task TASK_ID [--limit N] [--cursor TOKEN]  [runless query]
  task activity --company COMPANY_ID --from RFC3339 --to RFC3339 [--task TASK_ID] [--limit N] [--cursor TOKEN]  [runless query]
    Limits: positive integers, at most 999 for list/children, 499 for comments, 200 for activity. Activity covers [from,to).
  task reference-lookup --company COMPANY_ID --namespace NAMESPACE --external-id EXTERNAL_ID  [runless reference]
  task reference-attach --company COMPANY_ID --task TASK_ID --key KEY --file reference.json  [runless reference]
    Reference file: {"expectedRevision":"FROM_INSPECT","payload":{"namespace":"...","externalId":"...","url":"https://..."},"reason":"Human instruction"}; url and reason are optional.
  task inspect --company COMPANY_ID --task TASK_ID
  task edit|reassign --company COMPANY_ID --task TASK_ID --key KEY --file changes.json
  task complete --company COMPANY_ID --task TASK_ID --key KEY --file completion.json
  task comment|reopen|cancel --company COMPANY_ID --task TASK_ID --key KEY --file mutation.json  [runless human mutation]
    Mutation files: {"expectedRevision":"FROM_INSPECT","payload":{...},"reason":"Human instruction"}; complete/cancel omit payload, cancel requires reason.
    Comment payload: {"body":"..."}. Reopen payload: {"status":"todo"} or {} (todo by default).
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
  board [--watch] [--json]
  service-unit --paperclip-url URL [--state-dir DIR]
  install --paperclip-url URL [--state-dir DIR] [--backend-context FILE] [--herdr-config FILE]
  uninstall [--state-dir DIR]
  schedule create|stop --file schedule.json
  routine preview --file cron.json
  routine create|list|inspect|pause|resume|cancel|run --file routine.json
    Routine files include companyId, plus scheduleId/key as applicable. Create defaults paused.
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
    ['context', 'file', 'context-out', 'paperclip-url', 'state-dir', 'key', 'company', 'summary-file', 'question-file', 'candidate', 'outcome', 'evidence', 'interaction', 'directory', 'source', 'backend-context', 'herdr-config', 'task', 'timeout', 'project', 'status', 'agent', 'user', 'parent', 'limit', 'cursor', 'from', 'to', 'namespace', 'external-id']
      .map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['watch', { type: 'boolean' }], ['json', { type: 'boolean' }], ['reserved', { type: 'boolean' }]])) });
  const [group, action, id] = positionals;
  const queryOptions = {
    list: ['project', 'status', 'agent', 'user', 'parent', 'limit', 'cursor'],
    children: ['task', 'project', 'status', 'agent', 'user', 'limit', 'cursor'],
    comments: ['task', 'limit', 'cursor'],
    activity: ['task', 'limit', 'cursor', 'from', 'to'],
    'reference-lookup': ['namespace', 'external-id'],
  };
  const query = Object.hasOwn(queryOptions, action);
  const humanMutation = ['edit', 'reassign', 'complete', 'comment', 'reopen', 'cancel', 'reference-attach'].includes(action);
  if (values.company !== undefined) requireValue(group === 'task' && (query || humanMutation || ['create', 'capture', 'inspect'].includes(action)) && positionals.length === 2,
    'invalid_request', '--company is only valid for runless operator task commands');
  for (const option of ['project', 'status', 'agent', 'user', 'parent', 'limit', 'cursor', 'from', 'to', 'namespace', 'external-id']) {
    const workerReference = group === 'task' && id && action === 'reference-lookup' && ['namespace', 'external-id'].includes(option);
    if (values[option] !== undefined) requireValue(workerReference || group === 'task' && values.company && query && queryOptions[action].includes(option),
      'invalid_request', `--${option} is not supported for this command`);
  }
  if (group === 'task' && values.company !== undefined) {
    const allowed = ['context', 'state-dir', 'help', 'company', ...(query ? queryOptions[action] :
      action === 'inspect' ? ['task'] : ['key', 'file', ...(humanMutation ? ['task'] : [])])];
    for (const option of Object.keys(values)) {
      requireValue(allowed.includes(option), 'invalid_request', `--${option} is not supported for this command`);
      requireValue(typeof values[option] !== 'string' || values[option].trim().length > 0,
        'invalid_request', `--${option} must not be empty`);
    }
  }
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
  if (group === 'board') {
    requireValue(!(values.json && values.watch), 'invalid_request', 'Choose --json or --watch');
    const read = signal => call(connection, 'GET', '/task-board', undefined, { signal });
    if (values.watch) await watchTaskBoard(read);
    else {
      const value = await read();
      console.log(values.json ? JSON.stringify(value, null, 2) : renderTaskBoard(value, {
        width: process.stdout.columns ?? 110, height: process.stdout.rows ?? 40,
        colour: Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
      }).text);
    }
    return;
  }
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
  else if (group === 'routine' && ['preview', 'create', 'list', 'inspect', 'pause', 'resume', 'cancel', 'run'].includes(action)) {
    requireValue(values.file && !id, 'invalid_request', 'Routine commands require --file');
    const input = JSON.parse(readFileSync(values.file, 'utf8'));
    requireValue(input && typeof input === 'object' && !Array.isArray(input) && input.action === undefined, 'invalid_request', 'Action comes from the command');
    result = await call(connection, 'POST', action === 'preview' ? '/routines/preview' : '/routines/manage',
      action === 'preview' ? input : { ...input, action });
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
  else if (group === 'agent' && action === 'enrolment-candidates') result = await call(connection, 'GET', '/herdr/enrolment-candidates');
  else if (group === 'agent' && action === 'enrol') result = await call(connection, 'POST', '/herdr/enrol', {
    key: values.key, directory: values.directory, reserved: values.reserved === true,
  });
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
  else if (group === 'task' && query && !id) {
    requireValue(values.company, 'invalid_request', '--company is required');
    if (action === 'reference-lookup') {
      requireValue(values.namespace && values['external-id'], 'invalid_request', '--namespace and --external-id are required');
      result = await call(connection, 'POST', '/tasks/references', { action: 'lookup', companyId: values.company,
        namespace: values.namespace, externalId: values['external-id'] });
    } else {
      if (['children', 'comments'].includes(action)) requireValue(values.task, 'invalid_request', '--task is required');
      if (action === 'activity') requireValue(values.from && values.to, 'invalid_request', '--from and --to are required');
      const input = { companyId: values.company, kind: action };
      for (const [option, field] of Object.entries({ task: 'taskId', project: 'projectId', agent: 'assigneeAgentId',
        user: 'assigneeUserId', parent: 'parentId', cursor: 'cursor', from: 'from', to: 'to' })) {
        if (values[option] !== undefined) input[field] = values[option];
      }
      if (values.status !== undefined) {
        input.statuses = values.status.split(',');
        requireValue(input.statuses.every(status => ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'].includes(status)) &&
          new Set(input.statuses).size === input.statuses.length, 'invalid_request', '--status must be comma-separated distinct task statuses');
      }
      if (values.limit !== undefined) {
        const max = action === 'activity' ? 200 : action === 'comments' ? 499 : 999;
        input.limit = Number(values.limit);
        requireValue(/^[0-9]+$/.test(values.limit) && Number.isSafeInteger(input.limit) && input.limit > 0 && input.limit <= max,
          'invalid_request', `--limit must be an integer from 1 to ${max}`);
      }
      result = await call(connection, 'POST', '/tasks/query', input);
    }
  }
  else if (group === 'task' && action === 'capture' && !id) {
    requireValue(values.company && values.key && values.file, 'invalid_request', '--company, --key and --file are required');
    const details = JSON.parse(readFileSync(values.file, 'utf8'));
    requireValue(details && typeof details === 'object' && !Array.isArray(details) &&
      Object.keys(details).every(key => ['payload', 'externalReference'].includes(key)) &&
      details.payload && typeof details.payload === 'object' && !Array.isArray(details.payload),
    'invalid_request', 'Capture file requires payload and optional externalReference only');
    if (details.externalReference !== undefined) requireValue(details.externalReference && typeof details.externalReference === 'object' &&
      !Array.isArray(details.externalReference) && Object.keys(details.externalReference).every(key => ['namespace', 'externalId', 'url'].includes(key)),
    'invalid_request', 'Unsupported externalReference fields');
    result = await call(connection, 'POST', '/tasks/manage', { ...details, action: 'create', companyId: values.company, key: values.key });
  }
  else if (group === 'task' && (action === 'inspect' || humanMutation) && !id) {
    requireValue(values.company && values.task && (action === 'inspect' || (values.file && values.key)),
      'invalid_request', '--company and --task required; mutations also need --key and --file');
    const details = action === 'inspect' ? {} : JSON.parse(readFileSync(values.file, 'utf8'));
    requireValue(details && typeof details === 'object' && !Array.isArray(details) &&
      Object.keys(details).every(key => ['expectedRevision', 'payload', 'reason'].includes(key)), 'invalid_request', 'Unsupported mutation file fields');
    if (action === 'reference-attach') requireValue(typeof details.expectedRevision === 'string' && details.expectedRevision.trim() &&
      details.payload && typeof details.payload === 'object' && !Array.isArray(details.payload) &&
      Object.keys(details.payload).every(key => ['namespace', 'externalId', 'url'].includes(key)) &&
      ['namespace', 'externalId'].every(key => typeof details.payload[key] === 'string' && details.payload[key].trim()),
    'invalid_request', 'Reference attachment requires expectedRevision and payload with namespace, externalId and optional url');
    result = await call(connection, 'POST', action === 'reference-attach' ? '/tasks/references' : '/tasks/manage',
      { ...details, action: action === 'reference-attach' ? 'attach' : action === 'reassign' ? 'assign' : action,
      companyId: values.company, taskId: values.task, ...(action === 'inspect' ? {} : { key: values.key }) });
  }
  else if (group === 'task' && action === 'reference-lookup' && id) {
    requireValue(values.namespace && values['external-id'], 'invalid_request', '--namespace and --external-id are required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/reference-lookup`, {
      namespace: values.namespace, externalId: values['external-id'],
    });
  }
  else if (group === 'task' && action === 'list' && id) result = await call(connection, 'GET', `/runs/${encodeURIComponent(id)}/tasks`);
  else if (group === 'work' && action === 'wait-children' && id) {
    requireValue(values.file, 'invalid_request', '--file is required');
    result = await call(connection, 'POST', `/runs/${encodeURIComponent(id)}/wait-children`, JSON.parse(readFileSync(values.file, 'utf8')));
  }
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
  else if (id && ((group === 'task' && ['create', 'assign', 'update', 'comment', 'reference-attach'].includes(action)) || (group === 'work' && action === 'answer'))) {
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
