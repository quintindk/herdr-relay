import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { workerConnection } from '../packages/opencode-relay/worker-context.mjs';
import { call } from './client.mjs';
import { nativeBackendClient } from './backend-client.mjs';
import { requireValue } from './protocol.mjs';
import { previewCron } from './cron-schedule.mjs';
import { enrolInteractive, attachInteractive, listEnrolments, launchInteractive, nativeConnection, configureInteractiveNode } from './native-enrol.mjs';
import { nativeAdmin, adminHelp } from './native-admin-cli.mjs';
import { boardContext } from './native-onboarding.mjs';
import { readPrivateJson } from './private-files.mjs';
import { maintenanceCli } from './upgrade-cli.mjs';

export const nativeHelp = `herdr-relay native (native Tasks and Collaboration, not Paperclip)
  agent enrol --here|--session ID --reserved [--config PRIVATE_NODE_JSON] [--directory DIR] [--name NAME] [--transport tools|cli]
    [--service-registration FILE] --context OWNER_JSON
  agent enrolments [--directory DIR] [--config PRIVATE_NODE_JSON] --context OWNER_JSON
  agent attach --here|--session ID --agent ID --generation N --key KEY [--config PRIVATE_NODE_JSON] [--directory DIR] --context OWNER_JSON
  agent launch [--agent ID] [--directory DIR] [--config PRIVATE_NODE_JSON] [--key KEY] [--json] --context OWNER_JSON
  interactive grant|request|dispatch --file PAYLOAD_JSON --key KEY --context OWNER_JSON
  interactive list|inspect [ID] --context OWNER_JSON
  interactive revoke|cancel ID --revision N --key KEY [--reason TEXT] --context OWNER_JSON
  node install|run --config PRIVATE_NODE_JSON
  node ensure --config PRIVATE_NODE_JSON --session ID  [reuse the running node, otherwise install/start it]
  node configure-interactive --config PRIVATE_NODE_JSON --file POLICY_JSON  [local operator only, restart node afterwards]
  inbox install --here|--session HUMAN_SESSION_ID --context OWNER_JSON [--config-dir DIR] [--evidence-file FILE]
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
  board [--context OWNER_JSON] [--json]  [Tasks, Agents, Inbox, Schedules]
  command --file COMMAND_JSON  [advanced native {key,action,payload}]
Backend commands require --context or RELAY_NATIVE_CONTEXT. Node operators cannot perform backend administration.
Board prefers the joined node's scoped operator.json, otherwise the local backend owner.json.
Worker commands use scoped worker credentials, never an owner context.
Payload files contain native backend fields, not legacy companyId/routine envelopes.
Task-independent messaging: work message-send|messages|message uses --context PRIVATE_WORKER_JSON,
with --key for sends and --file for message/query fields. No task/execution/run is required.
Enrolment never starts/restarts OpenCode or grants permissions. Start the node separately.
Run-now for an existing native cron is not implemented. Use an explicit execution request.
Pause must be acknowledged by the owner node. Already admitted work is not interrupted.`;

export async function main(args) {
  if (args[1] === 'upgrade' || args[0] === 'upgrade') { if (await maintenanceCli(args)) return; }
  if (args[0] === 'work') {
    const { main: worker } = await import('./node-worker-cli.mjs');
    return worker(args.slice(1));
  }
  if (await nativeAdmin(args)) return;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...Object.fromEntries(['context', 'file', 'key', 'revision', 'reason', 'cron', 'timezone', 'limit', 'cursor', 'config', 'directory', 'session', 'transport', 'service-registration', 'config-dir', 'evidence-file', 'name', 'agent', 'generation'].map(k => [k, { type: 'string' }])),
    help: { type: 'boolean' }, here: { type: 'boolean' }, reserved: { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const [group, action, id] = positionals;
  if (values.help || !group) { console.log(`${nativeHelp}\n\n${adminHelp}`); return; }
  const output = value => console.log(JSON.stringify(value, null, 2));
  requireValue(positionals.length <= 3, 'invalid_request', 'Unexpected positional arguments');
  const allowed = group === 'node' && ['install', 'run'].includes(action) ? ['config']
    : group === 'node' && action === 'configure-interactive' ? ['config', 'file']
    : group === 'node' && action === 'ensure' ? ['config', 'session']
    : group === 'inbox' && action === 'install' ? ['context', 'here', 'session', 'config-dir', 'evidence-file']
    : group === 'agent' && action === 'enrol' ? ['context', 'here', 'session', 'config', 'reserved', 'directory', 'transport', 'service-registration', 'name', 'key']
    : group === 'agent' && action === 'attach' ? ['context', 'here', 'session', 'config', 'directory', 'service-registration', 'agent', 'generation', 'key']
    : group === 'agent' && action === 'enrolments' ? ['context', 'config', 'directory']
    : group === 'agent' && action === 'launch' ? ['context', 'config', 'directory', 'agent', 'key', 'json', 'service-registration']
    : group === 'schedule' && action === 'preview' ? ['cron', 'timezone']
    : group === 'board' ? ['context', 'json']
    : group === 'interactive' && ['grant', 'request', 'dispatch'].includes(action) ? ['context', 'file', 'key']
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
  if (group === 'node' && action === 'configure-interactive') {
    requireValue(!id && values.file, 'invalid_request', 'Explicit policy file required');
    output(configureInteractiveNode({ configFile: values.config, policy: JSON.parse(readFileSync(values.file, 'utf8')) })); return;
  }
  if (group === 'node' && action === 'ensure') {
    requireValue(values.config && values.session && !id, 'invalid_request', 'Node readiness requires --config and --session');
    const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
    requireValue(config.identityVersion === 2, 'configuration_conflict', 'Stable-node config required');
    const ready = async milliseconds => {
      const deadline = Date.now() + milliseconds;
      do {
        try {
          const connection = workerConnection({ workerDirectory: config.stateDirectory }, values.session);
          const status = await call(connection, 'POST', '/agent/status', {}, { signal: AbortSignal.timeout(1000) });
          if (status.receivingHere) return status;
        } catch {}
        await delay(200);
      } while (Date.now() < deadline);
    };
    let status = await ready(3000);
    if (!status) {
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/install-native-node.mjs', import.meta.url)), '--config', resolve(values.config)],
        { stdio: ['ignore', 'pipe', 'inherit'] });
      status = await ready(10000);
    }
    requireValue(status, 'node_not_ready', 'Attachment is saved, but the Relay node has not applied it. Reconcile before dispatching');
    output({ state: 'running', nodeId: config.nodeId, agentId: status.agentId, sessionId: values.session }); return;
  }
  if (group === 'schedule' && action === 'preview') { requireValue(!id, 'invalid_request', 'Unexpected schedule ID'); output(previewCron(values.cron, values.timezone)); return; }
  if (group === 'inbox' && action === 'install') {
    requireValue(!id && Boolean(values.here) !== Boolean(values.session), 'invalid_request', 'Choose --here or --session ID');
    const { installNativeInbox } = await import('./native-inbox-install.mjs');
    output(installNativeInbox({ contextFile: values.context ?? process.env.RELAY_NATIVE_CONTEXT,
      sessionId: values.here ? process.env.OPENCODE_SESSION_ID : values.session,
      configDirectory: values['config-dir'], evidenceFile: values['evidence-file'] })); return;
  }
  const path = values.context ?? process.env.RELAY_NATIVE_CONTEXT ?? (group === 'board'
    ? boardContext() : undefined);
  requireValue(path, 'invalid_request', 'Explicit --context or RELAY_NATIVE_CONTEXT is required');
  const context = readPrivateJson(path);
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
      serviceRegistration: values['service-registration'], name: values.name, key: values.key, backend, api })); return;
  }
  if (group === 'agent' && action === 'enrolments') {
    requireValue(!id, 'invalid_request', 'Enrolments takes no ID');
    output(await listEnrolments({ configFile: values.config, directory: values.directory, api })); return;
  }
  if (group === 'agent' && action === 'attach') {
    requireValue(!id && Boolean(values.here) !== Boolean(values.session) && /^\d+$/.test(values.generation ?? ''),
      'invalid_request', 'Choose --here or --session and supply the inspected --generation');
    output(await attachInteractive({ configFile: values.config, sessionId: values.here ? process.env.OPENCODE_SESSION_ID : values.session,
      directory: values.directory ?? process.cwd(), agentId: values.agent, expectedGeneration: Number(values.generation),
      key: values.key, serviceRegistration: values['service-registration'], backend, api })); return;
  }
  if (group === 'agent' && action === 'launch') {
    requireValue(!id, 'invalid_request', 'Launch takes no positional ID');
    const result = await launchInteractive({ configFile: values.config, directory: values.directory ?? process.cwd(),
      agentId: values.agent, key: values.key ?? randomUUID(), serviceRegistration: values['service-registration'], backend, api });
    if (values.json) output(result);
    else {
      execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/install-native-node.mjs', import.meta.url)), '--config', result.configFile], { stdio: 'inherit' });
      const endpoint = await nativeConnection({ serviceRegistration: values['service-registration'] });
      requireValue(endpoint.url === result.nativeUrl, 'native_identity_mismatch', 'Native endpoint changed before opening the receiving chat');
      execFileSync('opencode', [values.directory ?? process.cwd(), '--server', endpoint.url, '--session', result.sessionId],
        { stdio: 'inherit', env: { ...process.env, OPENCODE_PASSWORD: endpoint.password } });
    }
    return;
  }
  if (group === 'board') {
    const { nativeBoard } = await import('./native-board.mjs');
    const { NativeDecisionJournal } = await import('./native-decision-journal.mjs');
    const journal = new NativeDecisionJournal(join(dirname(resolve(path)), 'native-board-decisions.sqlite'));
    const board = nativeBoard(api, { decisionJournal: journal });
    try {
      if (values.json) output(await board.read());
      else {
        requireValue(process.stdin.isTTY && process.stdout.isTTY, 'terminal_required', 'Interactive board requires a TTY, or use --json');
        const { watchTaskBoardInk } = await import('./task-board-ink.mjs');
        await watchTaskBoardInk(board.read, { inspectTask: board.inspectTask, detailTask: board.detailTask, detailRoutine: board.detailRoutine,
          detailAgent: board.detailAgent, statusTask: board.statusTask, reviewTask: board.reviewTask, detailInbox: board.detailInbox,
          decideInbox: board.decideInbox, pendingDecisions: board.pendingDecisions });
      }
    } finally { journal.close(); }
    return;
  }
  const collections = { task: 'tasks', comment: 'comments', agent: 'agents', node: 'nodes', execution: 'executions', schedule: 'schedules', occurrence: 'occurrences', interactive: 'provision_requests' };
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
    'execution:request': 'execution.request', 'schedule:create': 'schedule.install', 'interactive:grant': 'interactive.grant',
    'interactive:request': 'interactive.request', 'interactive:dispatch': 'interactive.dispatch' };
  let nativeAction = fileActions[`${group}:${action}`], data;
  if (nativeAction) { requireValue(!id, 'invalid_request', 'The payload file supplies the entity ID'); data = payload(); }
  else if ((group === 'task' && ['complete', 'cancel'].includes(action)) || (group === 'schedule' && ['pause', 'resume', 'cancel'].includes(action)) ||
    (group === 'execution' && action === 'cancel') || (group === 'interactive' && ['revoke', 'cancel'].includes(action))) {
    requireValue(id && values.revision && /^[1-9]\d*$/.test(values.revision) && Number.isSafeInteger(Number(values.revision)), 'invalid_request', 'Exact ID and --revision positive integer are required');
    data = { id, expectedRevision: Number(values.revision) };
    nativeAction = group === 'task' ? 'task.update' : `${group}.${action}`;
    if (group === 'task') data.changes = { status: action === 'complete' ? 'done' : 'cancelled' };
    else if (action === 'cancel') { requireValue(values.reason?.trim(), 'invalid_request', 'Cancellation requires --reason'); data.reason = values.reason; }
  }
  requireValue(nativeAction && values.key?.trim(), 'invalid_request', 'Known mutation and explicit --key required. Use native --help');
  output(await api('POST', '/v1/commands', { key: values.key, action: nativeAction, payload: data }));
}
