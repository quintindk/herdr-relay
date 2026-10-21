import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeBackendClient } from './backend-client.mjs';
import { requireValue } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';
import { enrolInteractive } from './native-enrol.mjs';

export const nativeHelp = `herdr-relay native (native Tasks and Collaboration, not Paperclip)
  agent enrol --here|--session ID --config PRIVATE_NODE_JSON --reserved [--directory DIR] [--transport tools|cli]
    [--service-registration FILE] --context OWNER_JSON
  node install|run --config PRIVATE_NODE_JSON
  task|comment|agent|node|execution|schedule|occurrence list [--limit N] [--cursor TOKEN]
  task|comment|agent|node|execution|schedule|occurrence inspect ID
  task create|edit|comment --file PAYLOAD_JSON --key KEY
  task complete|cancel ID --revision N --key KEY  [human task status only, not native execution settlement]
  execution request --file PAYLOAD_JSON --key KEY
  execution cancel ID --revision N --reason TEXT --key KEY
  schedule preview --cron EXPR [--timezone Africa/Johannesburg]
  schedule create --file PAYLOAD_JSON --key KEY  [payload: {id,definition}, enabled must be explicit]
  schedule pause|resume ID --revision N --key KEY
  schedule cancel ID --revision N --reason TEXT --key KEY
  work read|submit|ask|... --context WORKER_JSON --execution ID --run ID [--key KEY] [--file PAYLOAD_JSON]
  board [--json]
  command --file COMMAND_JSON  [advanced native {key,action,payload}]
All backend commands require --context OWNER_JSON or RELAY_NATIVE_CONTEXT.
Worker commands use scoped worker credentials, never an owner context.
Payload files contain native backend fields, not legacy companyId/routine envelopes.
Enrolment never starts/restarts OpenCode or grants permissions. Start the node separately.
Run-now for an existing native cron is not implemented. Use an explicit execution request.
Pause must be acknowledged by the owner node. Already admitted work is not interrupted.`;

export async function main(args) {
  if (args[0] === 'work') {
    const { main: worker } = await import('./node-worker-cli.mjs');
    return worker(args.slice(1));
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...Object.fromEntries(['context', 'file', 'key', 'revision', 'reason', 'cron', 'timezone', 'limit', 'cursor', 'config', 'directory', 'session', 'transport', 'service-registration'].map(k => [k, { type: 'string' }])),
    help: { type: 'boolean' }, here: { type: 'boolean' }, reserved: { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const [group, action, id] = positionals;
  if (values.help || !group) { console.log(nativeHelp); return; }
  const output = value => console.log(JSON.stringify(value, null, 2));
  requireValue(positionals.length <= 3, 'invalid_request', 'Unexpected positional arguments');
  const allowed = group === 'node' && ['install', 'run'].includes(action) ? ['config']
    : group === 'agent' && action === 'enrol' ? ['context', 'here', 'session', 'config', 'reserved', 'directory', 'transport', 'service-registration']
    : group === 'schedule' && action === 'preview' ? ['cron', 'timezone']
    : group === 'board' ? ['context', 'json']
    : action === 'list' ? ['context', 'limit', 'cursor'] : action === 'inspect' ? ['context']
    : group === 'command' ? ['context', 'file']
    : ['create', 'edit', 'comment', 'request'].includes(action) ? ['context', 'file', 'key']
    : ['context', 'revision', 'key', ...(group !== 'task' && action === 'cancel' ? ['reason'] : [])];
  for (const option of Object.keys(values)) requireValue(allowed.includes(option), 'invalid_request', `--${option} is not supported for this native command`);
  if (group === 'board' || group === 'command') requireValue(positionals.length === 1, 'invalid_request', 'Unexpected positional arguments');
  if (group === 'node' && ['install', 'run'].includes(action)) {
    requireValue(values.config && !id, 'invalid_request', 'Node operation requires --config');
    const script = new URL(action === 'install' ? '../scripts/install-native-node.mjs' : './node-cli.mjs', import.meta.url);
    execFileSync(process.execPath, [fileURLToPath(script), '--config', resolve(values.config)], { stdio: 'inherit' }); return;
  }
  if (group === 'schedule' && action === 'preview') { requireValue(!id, 'invalid_request', 'Unexpected schedule ID'); output(previewCron(values.cron, values.timezone)); return; }
  const path = values.context ?? process.env.RELAY_NATIVE_CONTEXT;
  requireValue(path, 'invalid_request', 'Explicit --context or RELAY_NATIVE_CONTEXT is required');
  const context = JSON.parse(readFileSync(path, 'utf8'));
  const backend = { url: context.url ?? 'http://127.0.0.1:3210', ...(context.cloudflareAccess ? { cloudflareAccess: context.cloudflareAccess } : {}),
    ...(context.trustedHttpProxyOrigin ? { trustedHttpProxyOrigin: context.trustedHttpProxyOrigin } : {}) };
  const api = nativeBackendClient({ ...backend, token: context.token });
  const payload = () => {
    requireValue(values.file, 'invalid_request', '--file is required');
    const data = JSON.parse(readFileSync(values.file, 'utf8'));
    requireValue(data && typeof data === 'object' && !Array.isArray(data), 'invalid_request', 'JSON object required');
    return data;
  };
  if (group === 'agent' && action === 'enrol') {
    requireValue(!id && Boolean(values.here) !== Boolean(values.session), 'invalid_request', 'Choose --here or --session ID');
    output(await enrolInteractive({ configFile: values.config, sessionId: values.here ? process.env.OPENCODE_SESSION_ID : values.session,
      directory: values.directory ?? process.cwd(), reserved: values.reserved === true, transport: values.transport,
      serviceRegistration: values['service-registration'], backend, api })); return;
  }
  if (group === 'board') {
    const { nativeBoard } = await import('./native-board.mjs');
    const board = nativeBoard(api);
    if (values.json) output(await board.read());
    else {
      requireValue(process.stdin.isTTY && process.stdout.isTTY, 'terminal_required', 'Interactive board requires a TTY, or use --json');
      const { watchTaskBoardInk } = await import('./task-board-ink.mjs');
      await watchTaskBoardInk(board.read, { inspectTask: board.inspectTask, detailTask: board.detailTask, detailRoutine: board.detailRoutine,
        statusTask: board.statusTask, reviewTask: board.reviewTask });
    }
    return;
  }
  const collections = { task: 'tasks', comment: 'comments', agent: 'agents', node: 'nodes', execution: 'executions', schedule: 'schedules', occurrence: 'occurrences' };
  if (collections[group] && ['list', 'inspect'].includes(action)) {
    requireValue(action === 'list' ? !id : Boolean(id), 'invalid_request', 'Inspect requires an ID. List takes no ID');
    const query = new URLSearchParams();
    if (values.limit !== undefined) {
      requireValue(/^\d+$/.test(values.limit) && Number(values.limit) > 0 && Number(values.limit) <= 500, 'invalid_query', 'Limit must be 1..500');
      query.set('limit', values.limit);
    }
    if (values.cursor) query.set('cursor', values.cursor);
    requireValue(action === 'list' || !query.size, 'invalid_query', 'Pagination applies only to list');
    output(await api('GET', `/v1/${collections[group]}${id ? `/${encodeURIComponent(id)}` : query.size ? `?${query}` : ''}`)); return;
  }
  if (group === 'command') { output(await api('POST', '/v1/commands', payload())); return; }
  const fileActions = { 'task:create': 'task.create', 'task:edit': 'task.update', 'task:comment': 'comment.create',
    'execution:request': 'execution.request', 'schedule:create': 'schedule.install' };
  let nativeAction = fileActions[`${group}:${action}`], data;
  if (nativeAction) { requireValue(!id, 'invalid_request', 'The payload file supplies the entity ID'); data = payload(); }
  else if ((group === 'task' && ['complete', 'cancel'].includes(action)) || (group === 'schedule' && ['pause', 'resume', 'cancel'].includes(action)) ||
    (group === 'execution' && action === 'cancel')) {
    requireValue(id && values.revision && /^[1-9]\d*$/.test(values.revision) && Number.isSafeInteger(Number(values.revision)), 'invalid_request', 'Exact ID and --revision positive integer are required');
    data = { id, expectedRevision: Number(values.revision) };
    nativeAction = group === 'task' ? 'task.update' : `${group}.${action}`;
    if (group === 'task') data.changes = { status: action === 'complete' ? 'done' : 'cancelled' };
    else if (action === 'cancel') { requireValue(values.reason?.trim(), 'invalid_request', 'Cancellation requires --reason'); data.reason = values.reason; }
  }
  requireValue(nativeAction && values.key?.trim(), 'invalid_request', 'Known mutation and explicit --key required. Use native --help');
  output(await api('POST', '/v1/commands', { key: values.key, action: nativeAction, payload: data }));
}
