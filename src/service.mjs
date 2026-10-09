import { createServer } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { digest, RelayError, requireValue, text } from './protocol.mjs';
import { paperclipClient, publish, verifyRecovery } from './paperclip.mjs';
import { nativeConfig, OpenCode } from './opencode.mjs';
import { hermesConfig, Hermes } from './hermes.mjs';
import { supervise, workerContext } from './supervisor.mjs';
import { publishQuestion } from './work.mjs';
import { mutate, createOperatorTask } from './operations.mjs';
import { review } from './review.mjs';
import { provisionWorktree, finaliseWorktree, retireWorktree, reconcileWorktree } from './resources.mjs';
import { recordEvent, inbox, acknowledgeEvent } from './inbox.mjs';
import { overview } from './views.mjs';
import { launchRuntime, ownedRuntime, stopRuntime } from './runtimes.mjs';
import { retireAccepted, lifecycleRunner } from './lifecycle.mjs';
import { backendOperator, createSchedule, scheduleRunner } from './schedules.mjs';
import { provisionAgent } from './provisioning.mjs';
import { bindPlacement, reconcilePlacement } from './placement.mjs';
import { recoverBackend } from './backend-recovery.mjs';
import { serviceLock } from './service-lock.mjs';
import { resumeRuntime } from './resume.mjs';
import { provisionCompany } from './companies.mjs';
import { herdrConfig, observedAgents, watchHerdrAgents } from './herdr-agents.mjs';
import { prepareObservedPull, releaseObservedPull } from './observed-delivery.mjs';
import { requestReviewDisposition, checkReviewWake } from './disposition.mjs';
import { bridgeForToken, bridgeRequest, configureBridge, armBridge, disarmBridge } from './opencode-bridge.mjs';
import { harnessQuestion, harnessReview } from './harness-answers.mjs';
import { waitForChild } from './dependencies.mjs';
import { taskPolicy } from './task-policy.mjs';
import { reconcileBridgeEnrolment } from './bridge-enrolment.mjs';
import { notificationRequest, isNotificationSource } from './completion-notifications.mjs';
import { harnessDelegation } from './harness-delegation.mjs';
import { prepareHerdrWorker, inspectHerdrWorkers, reconcileHerdrWorkers } from './herdr-workers.mjs';
import { taskBoard } from './task-board.mjs';
import { manageRoutine } from './routines.mjs';
import { harnessRoutine } from './harness-routines.mjs';
import { previewCron } from './cron-schedule.mjs';
import { admitRoutineExecution } from './routine-execution.mjs';
import { humanTask } from './human-tasks.mjs';
import { queryTasks } from './task-query.mjs';
import { attachTaskReference, lookupTaskReference } from './task-references.mjs';
import { harnessTask } from './harness-tasks.mjs';
import { enrolAgent, enrolmentCandidates, enrolmentDirectories } from './enrolment.mjs';
import { coordinatorGrant, coordinatorReviewGrant, validateCoordinatorGrant } from './coordinator-review.mjs';

async function body(req, limit = 128 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= limit, 'request_too_large', 'Request exceeds allowed size', 413);
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw new RelayError('invalid_json', 'Invalid JSON request', 400); }
  requireValue(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'invalid_request', 'Request body must be an object');
  return parsed;
}

async function socketAvailable(path) {
  if (!existsSync(path)) return;
  requireValue(lstatSync(path).isSocket(), 'socket_path_occupied', 'Socket path is occupied by another file');
  await new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => { socket.destroy(); reject(new RelayError('already_running', 'Relay is already running')); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve();
      else reject(error);
    });
  });
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startService({ directory, paperclipUrl, api = paperclipClient(paperclipUrl), backendContextFile, herdrConfigFile }) {
  const observationConfig = herdrConfigFile ? herdrConfig(JSON.parse(readFileSync(herdrConfigFile, 'utf8'))) : null;
  requireValue(!observationConfig || backendContextFile, 'operator_backend_unavailable', 'Herdr registration requires a backend operator context');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const unlock = serviceLock(directory);
  try {
    const service = await startLockedService({ directory, paperclipUrl, api, backendContextFile, observationConfig });
    let closing;
    return { ...service, close: () => closing ??= service.close().finally(unlock) };
  } catch (error) { unlock(); throw error; }
}

async function startLockedService({ directory, paperclipUrl, api, backendContextFile, observationConfig }) {
  const socketPath = join(directory, 'relay.sock');
  await socketAvailable(socketPath);
  const tokenPath = join(directory, 'admin-token');
  try { writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  chmodSync(tokenPath, 0o600);
  const token = readFileSync(tokenPath, 'utf8').trim();
  const store = new Store(join(directory, 'relay.sqlite'));
  // Fence persisted grants before accepting requests, even when all provisioning
  // permissions or the Herdr source were removed while the service was stopped.
  for (const row of store.db.prepare("SELECT data FROM operations WHERE id LIKE 'herdr-worker:%'").all()) {
    const grant = JSON.parse(row.data);
    if (!observationConfig || ['companyId', 'machineId', 'session', 'socketPath'].some(key => grant.scope?.[key] !== observationConfig[key]) ||
      !observationConfig.workerRepositories?.some(item => item.repository === grant.allowed?.allowed?.repository &&
        item.worktreeRoot === grant.allowed?.allowed?.worktreeRoot)) {
      store.saveOperation({ ...grant, state: 'blocked', blocker: 'grant_revoked', disarmed: false });
    }
  }
  try { store.pinBackend(new URL(paperclipUrl).origin); }
  catch (error) { store.close(); throw error; }
  const publications = new Map();
  const runTokens = new Map();
  const operatorApi = backendOperator(paperclipUrl, backendContextFile);
  const routineOptions = { observationConfig, routingContextFile: join(directory, 'adapter-context.json') };
  if (observationConfig) {
    const context = JSON.stringify({ socketPath, token });
    if (!existsSync(routineOptions.routingContextFile)) writeFileSync(routineOptions.routingContextFile, context, { flag: 'wx', mode: 0o600 });
    else requireValue(readFileSync(routineOptions.routingContextFile, 'utf8') === context, 'context_conflict', 'Adapter context changed');
  }
  let boardPending, boardCache;

  const server = createServer(async (req, res) => {
    try {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const admin = digest(bearer) === digest(token);
      const bindingId = admin ? null : store.authenticate(bearer);
      const bridge = !admin && !bindingId ? bridgeForToken(store, bearer) : null;
      requireValue(admin || bindingId || bridge, 'unauthorised', 'Valid Relay credentials required', 401);
      const path = new URL(req.url, 'http://relay').pathname;
      const input = req.method === 'POST' ? await body(req, bridge && path === '/bridge/observe' ? 4 * 1024 * 1024 : undefined) : {};
      if (bridge) {
        requireValue(req.method === 'POST' && ['/bridge/poll', '/bridge/begin', '/bridge/observe', '/bridge/questions', '/bridge/answer', '/bridge/reviews', '/bridge/review',
          '/bridge/routine-preview', '/bridge/routine-create', '/bridge/routine-list', '/bridge/routine-inspect', '/bridge/routine-pause', '/bridge/routine-resume', '/bridge/routine-cancel', '/bridge/routine-run', '/bridge/routine-edit',
          '/bridge/agents', '/bridge/delegate', '/bridge/delegation-status', '/bridge/tasks', '/bridge/task-inspect', '/bridge/task-create', '/bridge/task-edit', '/bridge/task-assign', '/bridge/task-complete',
          '/bridge/task-list', '/bridge/task-children', '/bridge/task-comments', '/bridge/task-activity', '/bridge/task-reference-lookup', '/bridge/task-reference-attach', '/bridge/task-comment', '/bridge/task-reopen', '/bridge/task-cancel',
          '/bridge/enrolment-candidates', '/bridge/enrol-agent', '/bridge/workers', '/bridge/prepare-worker', '/bridge/grant-review', '/bridge/revoke-review',
          '/bridge/notification-list', '/bridge/notification-history', '/bridge/notification-begin', '/bridge/notification-observe'].includes(path),
          'forbidden', 'Bridge credential cannot access worker or operator routes', 403);
        const action = path.split('/').at(-1);
        let result;
        if (action.startsWith('routine-')) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          const { epoch, conversationId, terminalId, sessionCreatedAt, idle, ...fields } = input;
          result = await harnessRoutine(store, store.operation(bridge.id), action, fields, operatorApi, routineOptions);
        } else if (action.startsWith('task-')) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          const live = store.operation(bridge.id);
          const { epoch, conversationId, terminalId, sessionCreatedAt, idle, ...fields } = input;
          const companyId = store.binding(live.identity.bindingId).config.companyId;
          if (['task-list', 'task-children', 'task-comments', 'task-activity', 'task-reference-lookup'].includes(action)) {
            result = await harnessTask(store, live, action, fields, operatorApi);
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
          }
          const key = action === 'task-create' ? `human-task-create:${companyId}:${live.identity.bindingId}:${text(fields.key, 'key')}`
            : `human-task-write:${companyId}:${text(fields.taskId, 'taskId')}`;
          requireValue(!publications.has(key), 'operation_busy', 'Task operation in progress', 409);
          const pending = harnessTask(store, live, action, fields, operatorApi);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); boardCache = null; }
        } else if (['tasks', 'enrolment-candidates', 'enrol-agent'].includes(action)) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          const live = store.operation(bridge.id);
          const binding = store.binding(live.identity.bindingId);
          requireValue(!binding.lifecycleState && ['configured', 'armed'].includes(live.state), 'bridge_unavailable', 'An active configured bridge is required', 409);
          if (action === 'tasks') {
            const board = await taskBoard(store, operatorApi, { companyId: binding.config.companyId });
            result = { tasks: board.tasks, projects: board.projects, agents: board.agents, fetchedAt: board.fetchedAt, warnings: board.warnings };
          } else {
            requireValue(observationConfig && observationConfig.companyId === binding.config.companyId,
              'enrolment_unavailable', 'A matching configured Herdr source is required', 409);
            if (action === 'enrolment-candidates') result = { candidates: enrolmentCandidates(store, observationConfig) };
            else {
              const { epoch, conversationId, terminalId, sessionCreatedAt, idle, ...fields } = input;
              result = await enrolAgent(store, observationConfig, fields, { bridge: live });
            }
          }
        } else if (['grant-review', 'revoke-review'].includes(action)) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          result = await coordinatorGrant(store, store.operation(bridge.id), action, input, operatorApi);
        } else if (['workers', 'prepare-worker'].includes(action)) {
          requireValue(observationConfig, 'worker_repository_forbidden', 'A configured Herdr source is required', 409);
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          const live = store.operation(bridge.id);
          if (action === 'workers') result = await inspectHerdrWorkers(store, live, observationConfig);
          else {
            const { epoch, conversationId, terminalId, sessionCreatedAt, idle, ...fields } = input;
            result = await prepareHerdrWorker(store, live, fields, observationConfig);
          }
        } else if (['agents', 'delegate', 'delegation-status'].includes(action)) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          const key = `harness-delegation:${bridge.identity.bindingId}`;
          requireValue(!publications.has(key), 'operation_busy', 'Delegation operation in progress', 409);
          const pending = harnessDelegation(store, store.operation(bridge.id), action, input, operatorApi);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); }
        } else if (action.startsWith('notification-')) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          result = notificationRequest(store, store.operation(bridge.id), action, input);
        } else if (['questions', 'answer', 'reviews', 'review'].includes(action)) {
          bridgeRequest(store, bridge.id, 'poll', input, id => runTokens.has(id));
          requireValue(!input.source || !isNotificationSource(store, bridge, input.source.id),
            'invalid_answer_source', 'A Relay notification is not human authorisation', 409);
          const key = `harness-answer:${bridge.identity.bindingId}`;
          requireValue(!publications.has(key), 'operation_busy', 'Harness question operation in progress', 409);
          const pending = (['reviews', 'review'].includes(action) ? harnessReview : harnessQuestion)(store, store.operation(bridge.id), action, input, operatorApi);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); }
        } else result = bridgeRequest(store, bridge.id, action, input, id => runTokens.has(id));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (bindingId && req.method === 'POST') {
        requireValue(!path.startsWith('/bridge/'), 'forbidden', 'Bridge credentials required', 403);
        requireValue(!store.binding(bindingId).lifecycleState, 'binding_inactive', 'Retiring or retired bindings cannot initiate writes', 403);
      }
      const adminOnly = () => requireValue(admin, 'forbidden', 'Operator credentials required', 403);
      let result;
      if (req.method === 'GET' && path === '/health') result = { status: 'ok', delivery: ['pull', 'opencode', 'hermes'], schema: 4 };
      else if (req.method === 'POST' && path === '/routines/preview') {
        adminOnly(); requireValue(Object.keys(input).every(key => ['cron', 'timezone'].includes(key)), 'invalid_request', 'Unsupported preview fields');
        result = previewCron(input.cron, input.timezone);
      }
      else if (req.method === 'POST' && path === '/routines/manage') {
        adminOnly(); result = await manageRoutine(store, operatorApi, input, routineOptions);
      }
      else if (req.method === 'GET' && path === '/bindings') { adminOnly(); result = store.bindings(); }
      else if (req.method === 'GET' && path === '/task-board') {
        adminOnly();
        if (boardCache && Date.now() - Date.parse(boardCache.fetchedAt) < 4000) result = boardCache;
        else {
          boardPending ??= taskBoard(store, operatorApi, { companyId: observationConfig?.companyId })
            .then(value => { boardCache = value; return value; }).finally(() => { boardPending = null; });
          result = await boardPending;
        }
      }
      else if (req.method === 'POST' && path === '/tasks') {
        adminOnly();
        const key = `operator-task:${digest([text(input.companyId, 'companyId'), text(input.key, 'key')])}`;
        requireValue(!publications.has(key), 'operation_busy', 'Operator task creation is in progress', 409);
        const pending = createOperatorTask(store, operatorApi, input);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'POST' && path === '/tasks/manage') {
        adminOnly();
        const companyId = text(input.companyId, 'companyId');
        const key = input.action === 'create' ? `human-task-create:${companyId}:operator:${text(input.key, 'key')}`
          : `human-task-write:${companyId}:${text(input.taskId, 'taskId')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Task operation in progress', 409);
        const pending = humanTask(store, operatorApi, input);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); boardCache = null; }
      }
      else if (req.method === 'POST' && path === '/tasks/query') {
        adminOnly(); result = await queryTasks(operatorApi, input);
      }
      else if (req.method === 'POST' && path === '/tasks/references') {
        adminOnly();
        const { action, ...fields } = input;
        requireValue(['lookup', 'attach'].includes(action), 'invalid_request', 'Unknown reference action');
        if (action === 'lookup') result = await lookupTaskReference(store, operatorApi, fields);
        else {
          requireValue(Object.keys(fields).every(key => ['companyId', 'taskId', 'key', 'expectedRevision', 'reason', 'payload'].includes(key)), 'invalid_request', 'Unsupported reference fields');
          requireValue(fields.payload && typeof fields.payload === 'object' && !Array.isArray(fields.payload) &&
            Object.keys(fields.payload).every(key => ['namespace', 'externalId', 'url'].includes(key)), 'invalid_request', 'Unsupported reference payload');
          text(fields.expectedRevision, 'expectedRevision');
          const key = `human-task-write:${text(fields.companyId, 'companyId')}:${text(fields.taskId, 'taskId')}`;
          requireValue(!publications.has(key), 'operation_busy', 'Task operation in progress', 409);
          const pending = attachTaskReference(store, operatorApi, { ...fields.payload, companyId: fields.companyId, taskId: fields.taskId,
            key: fields.key, expectedRevision: fields.expectedRevision });
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); boardCache = null; }
        }
      }
      else if (req.method === 'GET' && path === '/herdr/agents') { adminOnly(); result = { source: observer?.status() ?? null, agents: observedAgents(store) }; }
      else if (req.method === 'GET' && path === '/herdr/enrolment-candidates') {
        adminOnly(); requireValue(observationConfig, 'enrolment_unavailable', 'Configured Herdr source required', 409);
        result = { candidates: enrolmentCandidates(store, observationConfig) };
      }
      else if (req.method === 'POST' && path === '/herdr/enrol') {
        adminOnly(); requireValue(observationConfig, 'enrolment_unavailable', 'Configured Herdr source required', 409);
        result = await enrolAgent(store, observationConfig, input);
      }
      else if (req.method === 'POST' && ['/herdr/configure-bridge', '/herdr/arm-bridge', '/herdr/disarm-bridge'].includes(path)) {
        adminOnly();
        requireValue(!publications.has('observed-delivery'), 'operation_busy', 'Observed agent configuration in progress', 409);
        const pending = path.endsWith('/configure-bridge') ? configureBridge(store, directory, operatorApi, input)
          : path.endsWith('/disarm-bridge') ? disarmBridge(store, operatorApi, input) : armBridge(store, directory, operatorApi, input);
        publications.set('observed-delivery', pending);
        try { result = await pending; } finally { publications.delete('observed-delivery'); }
      }
      else if (req.method === 'POST' && ['/herdr/prepare-pull', '/herdr/release-pull'].includes(path)) {
        adminOnly();
        requireValue(!publications.has('observed-delivery'), 'operation_busy', 'Observed delivery configuration in progress', 409);
        const pending = path === '/herdr/prepare-pull' ? prepareObservedPull(store, directory, operatorApi, input) : releaseObservedPull(store, operatorApi, input);
        publications.set('observed-delivery', pending);
        try { result = await pending; } finally { publications.delete('observed-delivery'); }
      }
      else if (req.method === 'GET' && path === '/overview') {
        adminOnly();
        result = overview(store.bindings(), store.runs(), inbox(store));
      }
      else if (req.method === 'GET' && path === '/inbox') {
        requireValue(bindingId, 'binding_required', 'Use a worker context for inbox reads');
        result = inbox(store, bindingId);
      }
      else if (req.method === 'POST' && path === '/events') {
        requireValue(bindingId, 'binding_required', 'Use a worker context for source events');
        result = recordEvent(store, bindingId, input);
      }
      else if (req.method === 'POST' && path === '/inbox/acknowledge') {
        requireValue(bindingId, 'binding_required', 'Use a worker context for inbox acknowledgement');
        result = acknowledgeEvent(store, bindingId, input.eventId);
      }
      else if (req.method === 'POST' && path === '/checkpoint') {
        requireValue(bindingId, 'binding_required', 'Use a worker context for source checkpoints');
        result = store.operation(`checkpoint:${digest([bindingId, text(input.source, 'source')])}`) ?? { cursor: null };
      }
      else if (req.method === 'GET' && path === '/peers') {
        const company = bindingId ? store.binding(bindingId).config.companyId : null;
        result = store.bindings().filter(binding => !company || binding.config.companyId === company)
           .map(binding => ({ id: binding.id, revision: binding.revision, agentId: binding.config.agentId,
            harness: binding.config.harness, delivery: binding.config.delivery, label: binding.config.label ?? binding.id,
            capabilities: binding.config.capabilities ?? [], lifetime: binding.config.lifetime ?? 'persistent',
            lifecycleState: binding.lifecycleState ?? 'active' }));
      }
      else if (req.method === 'POST' && path === '/bindings') {
        adminOnly();
        const nativeSettings = input.opencode ?? input.hermes;
        if (nativeSettings?.runtimeKey) {
          const runtime = ownedRuntime(store, nativeSettings.runtimeKey);
          const hermes = input.harness === 'hermes';
          requireValue((runtime.request.harness ?? 'opencode') === input.harness &&
            nativeSettings.url === (hermes ? `ws://127.0.0.1:${runtime.port}/api/ws` : `http://127.0.0.1:${runtime.port}`) &&
            nativeSettings.authFile === join(runtime.directory, hermes ? 'gateway-token' : 'auth.json') && nativeSettings.directory === runtime.request.directory,
          'runtime_identity_mismatch', 'Binding does not target the owned native runtime', 409);
          requireValue(!store.bindings().some(binding => binding.id !== input.id && (binding.config.opencode ?? binding.config.hermes)?.runtimeKey === nativeSettings.runtimeKey),
            'runtime_already_bound', 'Managed native runtime is dedicated to one binding', 409);
        }
        if (input.delivery === 'opencode') await new OpenCode({ ...input, opencode: nativeConfig(input.opencode) }).verify();
        if (input.delivery === 'hermes') await new Hermes({ ...input, hermes: hermesConfig(input.hermes) }).verify();
        result = store.register(input);
      }
      else if (req.method === 'POST' && path === '/bindings/rebind') {
        adminOnly();
        const previous = store.binding(text(input.id, 'id'));
        requireValue(previous.revision === input.revision, 'stale_binding', 'Binding revision changed', 409);
        const native = input.harness === 'opencode'
          ? new OpenCode({ ...input, opencode: nativeConfig(input.opencode) })
          : new Hermes({ ...input, hermes: hermesConfig(input.hermes) });
        const snapshot = await native.snapshot();
        requireValue(snapshot.idle, 'native_busy', 'Continuation target must be idle', 409);
        result = store.rebind(input.id, input);
      }
      else if (req.method === 'POST' && path === '/bindings/controller') {
        adminOnly();
        result = store.transferController(text(input.id, 'id'), input);
      }
      else if (req.method === 'POST' && path === '/bindings/credential') {
        adminOnly();
        result = store.rotateCredential(text(input.id, 'id'), input.key);
        if (['opencode', 'hermes'].includes(result.binding.config.delivery)) workerContext(directory, socketPath, store, result.binding);
      }
      else if (req.method === 'POST' && path === '/agents/provision') {
        adminOnly();
        const key = `provision:${text(input.key, 'key')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Agent provisioning in progress', 409);
        const pending = provisionAgent(store, directory, operatorApi, input);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'POST' && path === '/companies/provision') {
        adminOnly();
        const key = 'company-provision';
        requireValue(!publications.has(key), 'operation_busy', 'Company provisioning in progress', 409);
        const pending = provisionCompany(store, operatorApi, input);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'GET' && path === '/runs') result = store.runs(bindingId);
      else if (req.method === 'POST' && path === '/backend/recover') {
        adminOnly();
        const key = `backend-recovery:${text(input.runId, 'runId')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Backend recovery is already in progress', 409);
        const pending = recoverBackend(store, operatorApi, input);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'POST' && path === '/operations/inspect') {
        const operation = store.operation(text(input.id, 'id'));
        requireValue(operation, 'operation_not_found', 'Unknown operation', 404);
        if (!admin) {
          requireValue(operation.runId && store.run(operation.runId).request.bindingId === bindingId,
            'forbidden', 'Operation belongs to another principal', 403);
        }
        result = operation;
      }
      else if (req.method === 'GET' && path === '/operations') {
        adminOnly();
        result = store.db.prepare('SELECT data FROM operations ORDER BY rowid DESC').all().map(row => JSON.parse(row.data));
      }
      else if (req.method === 'POST' && ['/placement/bind', '/placement/reconcile'].includes(path)) {
        adminOnly();
        result = path === '/placement/bind' ? await bindPlacement(store, input) : await reconcilePlacement(store, text(input.bindingId, 'bindingId'));
      }
      else if (req.method === 'POST' && path === '/schedules') { adminOnly(); result = createSchedule(store, input); }
      else if (req.method === 'POST' && path === '/schedules/stop') {
        adminOnly();
        const schedule = store.operation(`schedule:${text(input.key, 'key')}`);
        requireValue(schedule, 'schedule_not_found', 'Unknown schedule', 404);
        result = store.saveOperation({ ...schedule, state: 'stopped' });
        if (input.cancelActive === true) {
          for (const run of store.runs(schedule.request.bindingId)) {
            if (run.nativeState !== 'settled' && run.request.taskId === schedule.request.taskId) store.cancel(run.id);
          }
        }
      }
      else if (req.method === 'POST' && ['/runtimes/launch', '/runtimes/stop', '/runtimes/resume'].includes(path)) {
        adminOnly();
        const key = `runtime:${text(input.key, 'key')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Runtime operation in progress', 409);
        const pending = path === '/runtimes/launch' ? launchRuntime(store, directory, input)
          : path === '/runtimes/resume' ? resumeRuntime(store, directory, operatorApi, input) : stopRuntime(store, input.key);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'POST' && ['/resources/worktree', '/resources/finalise', '/resources/retire', '/resources/reconcile'].includes(path)) {
        adminOnly();
        if (path === '/resources/worktree') result = provisionWorktree(store, input);
        else if (path === '/resources/reconcile') result = reconcileWorktree(store, input);
        else if (path === '/resources/finalise') result = finaliseWorktree(store, input);
        else {
          result = await retireWorktree(store, input, async run => {
            const caller = store.run(text(input.callerRunId, 'callerRunId'));
            requireValue(runTokens.has(caller.id), 'adapter_unavailable', 'Live reviewer backend credentials required', 503);
            const observed = await review(store, caller, runTokens.get(caller.id), api, {
              runId: run.id, candidate: input.candidate, action: 'inspect',
            });
            requireValue(observed.review.status === 'accepted', 'acceptance_required', 'Paperclip has not accepted this candidate', 409);
          });
        }
      }
      else if (req.method === 'POST' && path === '/review-wake') {
        adminOnly();
        const key = `review-wake:${text(input.runId, 'runId')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Wake check in progress', 409);
        const pending = checkReviewWake(store, input, api);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'POST' && path === '/runs') {
        adminOnly();
        result = await admitRoutineExecution(store, operatorApi, input, routineOptions) ?? store.dispatch(input);
      }
      else {
        const match = path.match(/^\/runs\/([^/]+)(?:\/(acknowledge|submit|settle|cancel|publish|task|attach|recover|ask|interactions|publish-question|mutate|tasks|reference-lookup|diagnostics|review|retire|progress|reviewer-check|disposition|wait-child|wait-children|child))?$/);
        requireValue(match, 'not_found', 'Unknown endpoint', 404);
        const [, id, action] = match;
        const run = store.run(id);
        requireValue(admin || run.request.bindingId === bindingId, 'forbidden', 'Run belongs to another binding', 403);
        if (req.method === 'POST' && admin && input.runId !== undefined && ['attach', 'cancel', 'publish', 'publish-question'].includes(action)) {
          requireValue(input.runId === (run.backendRunId ?? run.request.runId), 'stale_backend_run', 'Adapter no longer owns this backend invocation', 409);
        }
        if (req.method === 'GET' && !action) result = run;
        else if (req.method === 'GET' && action === 'diagnostics') {
          adminOnly();
          const task = await operatorApi('GET', `/api/issues/${encodeURIComponent(run.request.taskId)}`);
          requireValue(task.id === run.request.taskId && task.companyId === run.request.companyId,
            'identity_mismatch', 'Diagnostic task identity changed', 409);
          result = Object.fromEntries(['id', 'status', 'executionRunId', 'checkoutRunId', 'activeRecoveryAction',
            'executionBlocker', 'reviewPolicy', 'reviewAttention', 'blockedByIssueIds', 'blockedBy'].map(key => [key, task[key] ?? null]));
          result.recovery = await operatorApi('GET', `/api/issues/${encodeURIComponent(run.request.taskId)}/recovery-actions`);
        }
        else if (req.method === 'POST' && action === 'recover') {
          adminOnly();
          text(input.token, 'token');
          const previousId = run.backendRunId ?? run.request.runId;
          if (previousId !== input.runId) await verifyRecovery(run, input, input.token, api);
          requireValue((store.run(id).backendRunId ?? run.request.runId) === previousId,
            'recovery_conflict', 'Backend identity changed during verification', 409);
          result = store.recover(id, input);
          runTokens.delete(id);
        }
        else if (req.method === 'POST' && action === 'acknowledge') result = store.acknowledge(id);
        else if (req.method === 'POST' && action === 'submit') result = store.submit(id, input);
        else if (req.method === 'POST' && action === 'progress') result = store.progress(id, input);
        else if (req.method === 'POST' && action === 'reviewer-check') {
          requireValue(run.nativeState === 'claimed' && !run.cancellationRequested, 'work_inactive', 'Reviewer work must be active', 409);
          result = store.reviewerEvidence(text(input.runId, 'runId'), input, run);
        }
        else if (req.method === 'POST' && action === 'ask') result = store.ask(id, input);
        else if (req.method === 'POST' && action === 'review') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          requireValue(run.nativeState === 'claimed' && !run.cancellationRequested, 'work_inactive', 'Review requires active acknowledged work', 409);
          const key = `review:${text(input.runId, 'runId')}`;
          requireValue(!publications.has(key), 'operation_busy', 'Review is already in flight', 409);
          const pending = review(store, run, runTokens.get(id), api, input);
          publications.set(key, pending);
          try {
            result = await pending;
            const targetBinding = store.binding(result.request.bindingId);
            if (result.review.status === 'accepted' && targetBinding.config.lifetime === 'task' && targetBinding.config.controllerBindingId === run.request.bindingId) {
              try { await retireAccepted(store, run, result, runTokens.get(id), api); }
              catch { /* Acceptance stands. Durable retirement state exposes the blocker. */ }
            }
          } finally { publications.delete(key); }
        }
        else if (req.method === 'POST' && action === 'retire') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live controller backend credentials required', 503);
          const target = store.run(text(input.runId, 'runId'));
          const key = `review:${target.id}`;
          requireValue(!publications.has(key), 'operation_busy', 'Candidate lifecycle operation is in progress', 409);
          const pending = retireAccepted(store, run, target, runTokens.get(id), api);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); }
        }
        else if (req.method === 'POST' && action === 'mutate') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          requireValue(run.nativeState === 'claimed' && !run.cancellationRequested, 'work_inactive', 'Acknowledge active work before backend changes', 409);
          requireValue(!run.result && !run.waiting && !run.dependency, 'work_disposition_recorded', 'This turn has already submitted or is waiting', 409);
          const key = digest([run.request.bindingId, input.kind, input.key]);
          requireValue(!publications.has(key), 'operation_busy', 'Operation is already in flight', 409);
          const checkJob = () => {
            const live = store.run(id);
            requireValue(live.nativeState === 'claimed' && !live.cancellationRequested && !live.result && !live.waiting && !live.dependency,
              'work_inactive', 'Job execution has stopped or already reported', 409);
          };
          const pending = mutate(store, run, runTokens.get(id), async (...args) => {
            checkJob(); const response = await api(...args); checkJob(); return response;
          }, input);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); }
        }
        else if (req.method === 'POST' && ['wait-child', 'wait-children', 'child'].includes(action)) {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials required', 503);
          if (action !== 'child') {
            const key = `dependency:${id}`;
            requireValue(!publications.has(key), 'operation_busy', 'Dependency update in progress', 409);
            const pending = waitForChild(store, run, runTokens.get(id), api, input);
            publications.set(key, pending);
            try { result = await pending; } finally { publications.delete(key); }
          } else {
            const taskId = text(input.taskId, 'taskId');
            const target = `/api/issues/${encodeURIComponent(taskId)}`;
            const task = await api(run, runTokens.get(id), 'GET', target);
            requireValue(task.companyId === run.request.companyId,
              'forbidden', 'Task belongs to another company', 403);
            requireValue(task.id === taskId, 'identity_mismatch', 'Backend returned another task', 409);
            const childRuns = store.runs().filter(item => item.request.companyId === run.request.companyId && item.request.taskId === task.id);
            const candidate = childRuns.find(item => item.result);
            const grant = coordinatorReviewGrant(store, run.request.companyId, task.id);
            result = { task, comments: await api(run, runTokens.get(id), 'GET', `${target}/comments`),
              relayReview: candidate ? { runId: candidate.id, candidate: candidate.result.candidate, summary: candidate.result.summary,
                state: candidate.review?.status ?? null, interactionId: candidate.review?.interactionId ?? null,
                grantId: task.parentId === run.request.taskId && grant?.request.parentTaskId === run.request.taskId &&
                  grant.request.reviewerBindingId === run.request.bindingId ? grant.id : null } : null };
          }
        }
        else if (req.method === 'POST' && action === 'reference-lookup') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          requireValue(input.companyId === undefined, 'invalid_request', 'Company is derived from the job');
          result = await lookupTaskReference(store, (method, path) => api(run, runTokens.get(id), method, path),
            { ...input, companyId: run.request.companyId });
        }
        else if (req.method === 'GET' && action === 'tasks') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          result = await api(run, runTokens.get(id), 'GET', `/api/companies/${encodeURIComponent(run.request.companyId)}/issues`);
        }
        else if (req.method === 'GET' && action === 'interactions') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          result = await api(run, runTokens.get(id), 'GET', `/api/issues/${encodeURIComponent(run.request.taskId)}/interactions`);
        }
        else if (req.method === 'POST' && action === 'disposition') {
          adminOnly();
          requireValue((run.backendRunId ?? run.request.runId) === input.runId, 'stale_backend_run', 'Current backend run required', 409);
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials required', 503);
          const key = `review:${id}`;
          requireValue(!publications.has(key), 'operation_busy', 'Review disposition is in progress', 409);
          const pending = requestReviewDisposition(store, id, runTokens.get(id), api);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); }
        }
        else if (req.method === 'POST' && action === 'settle') { adminOnly(); result = store.settle(id, input); }
        else if (req.method === 'POST' && action === 'cancel') { adminOnly(); result = store.cancel(id); }
        else if (req.method === 'POST' && action === 'attach') {
          adminOnly();
          requireValue(!run.backendRunId || input.runId === run.backendRunId, 'stale_backend_run', 'Replacement backend run identity required', 409);
          runTokens.set(id, text(input.token, 'token'));
          result = { attached: true };
        } else if (req.method === 'GET' && action === 'task') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          result = await api(run, runTokens.get(id), 'GET', `/api/issues/${encodeURIComponent(run.request.taskId)}`);
          requireValue(result.companyId === run.request.companyId, 'identity_mismatch', 'Task company does not match binding', 409);
          result = { ...result, relayReviewPolicy: taskPolicy(store, run.request.companyId, run.request.taskId) };
          const grants = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'coordinator-review-grant:%'").all()
            .map(row => JSON.parse(row.data)).filter(grant => grant.state === 'active' &&
              grant.request.companyId === run.request.companyId && grant.request.parentTaskId === run.request.taskId &&
              grant.request.reviewerBindingId === run.request.bindingId).flatMap(grant => {
              try {
                validateCoordinatorGrant(store, grant.id, { companyId: run.request.companyId,
                  parentTaskId: run.request.taskId, reviewerBindingId: run.request.bindingId });
                return [{ grantId: grant.id, scope: 'direct_children', parentTaskId: run.request.taskId }];
              } catch { return []; }
            });
          if (grants.length) result.coordinatorReviewGrants = grants;
        } else if (req.method === 'POST' && ['publish', 'publish-question'].includes(action)) {
          adminOnly();
          requireValue(!run.backendRunId || input.runId === run.backendRunId, 'stale_backend_run', 'Replacement backend run identity required', 409);
          const key = `${id}:${action}`;
          if (!publications.has(key)) {
            publications.set(key, (action === 'publish' ? publish : publishQuestion)(store, id, text(input.token, 'token'), api).finally(() => publications.delete(key)));
          }
          result = await publications.get(key);
        } else throw new RelayError('not_found', 'Unknown endpoint', 404);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error instanceof RelayError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: error.code ?? 'internal_error', message: error instanceof RelayError ? error.message : 'Relay operation failed' }));
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
  } catch (error) { store.close(); throw error; }
  const supervisor = supervise({ store, directory, socketPath, ready: id => runTokens.has(id) });
  const scheduler = scheduleRunner(store, operatorApi);
  const lifecycle = backendContextFile ? lifecycleRunner(store, operatorApi, publications) : null;
  const observer = observationConfig ? watchHerdrAgents(store, operatorApi, observationConfig, {
    afterReconcile: async current => {
      const directories = enrolmentDirectories(store, observationConfig);
      if (!directories.length || publications.has('observed-delivery')) return;
      const pending = reconcileBridgeEnrolment(store, directory, operatorApi, {
        ...observationConfig, directories, current,
      });
      publications.set('observed-delivery', pending);
      try {
        store.saveOperation({ id: 'bridge-enrolment', runId: '', results: await pending });
      } finally { publications.delete('observed-delivery'); }
    },
  }) : null;
  let workersStopped = false, workerTimer, workerPending = Promise.resolve();
  const scheduleWorkers = () => {
    if (workersStopped || !observationConfig) return;
    workerTimer = setTimeout(() => {
      workerPending = reconcileHerdrWorkers(store, directory, operatorApi, observationConfig, publications)
        .catch(error => console.error(JSON.stringify({ code: error.code ?? 'worker_reconciliation_failed' })))
        .finally(scheduleWorkers);
    }, 3000);
  };
  scheduleWorkers();
  return {
    socketPath, token, store,
    close: async () => {
      workersStopped = true; clearTimeout(workerTimer); await workerPending;
      await observer?.close();
      await scheduler.close();
      await lifecycle?.close();
      await supervisor.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
