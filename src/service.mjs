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
import { supervise } from './supervisor.mjs';
import { publishQuestion } from './work.mjs';
import { mutate } from './operations.mjs';
import { review } from './review.mjs';
import { provisionWorktree, finaliseWorktree, retireWorktree } from './resources.mjs';
import { recordEvent, inbox, acknowledgeEvent } from './inbox.mjs';
import { overview } from './views.mjs';
import { launchRuntime, ownedRuntime, stopRuntime } from './runtimes.mjs';
import { retireAccepted } from './lifecycle.mjs';
import { backendOperator, createSchedule, scheduleRunner } from './schedules.mjs';
import { provisionAgent } from './provisioning.mjs';

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireValue(size <= 128 * 1024, 'request_too_large', 'Request exceeds 128 KiB', 413);
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

export async function startService({ directory, paperclipUrl, api = paperclipClient(paperclipUrl), backendContextFile }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'relay.sock');
  await socketAvailable(socketPath);
  const tokenPath = join(directory, 'admin-token');
  try { writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  chmodSync(tokenPath, 0o600);
  const token = readFileSync(tokenPath, 'utf8').trim();
  const store = new Store(join(directory, 'relay.sqlite'));
  try { store.pinBackend(new URL(paperclipUrl).origin); }
  catch (error) { store.close(); throw error; }
  const publications = new Map();
  const runTokens = new Map();
  const operatorApi = backendOperator(paperclipUrl, backendContextFile);

  const server = createServer(async (req, res) => {
    try {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const admin = digest(bearer) === digest(token);
      const bindingId = admin ? null : store.authenticate(bearer);
      requireValue(admin || bindingId, 'unauthorised', 'Valid Relay credentials required', 401);
      const path = new URL(req.url, 'http://relay').pathname;
      const input = req.method === 'POST' ? await body(req) : {};
      const adminOnly = () => requireValue(admin, 'forbidden', 'Operator credentials required', 403);
      let result;
      if (req.method === 'GET' && path === '/health') result = { status: 'ok', delivery: ['pull', 'opencode', 'hermes'], schema: 4 };
      else if (req.method === 'GET' && path === '/bindings') { adminOnly(); result = store.bindings(); }
      else if (req.method === 'GET' && path === '/overview') {
        adminOnly();
        result = overview(store.bindings(), store.runs());
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
            harness: binding.config.harness, delivery: binding.config.delivery }));
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
      else if (req.method === 'POST' && path === '/agents/provision') {
        adminOnly();
        const key = `provision:${text(input.key, 'key')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Agent provisioning in progress', 409);
        const pending = provisionAgent(store, directory, operatorApi, input);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'GET' && path === '/runs') result = store.runs(bindingId);
      else if (req.method === 'POST' && path === '/schedules') { adminOnly(); result = createSchedule(store, input); }
      else if (req.method === 'POST' && path === '/schedules/stop') {
        adminOnly();
        const schedule = store.operation(`schedule:${text(input.key, 'key')}`);
        requireValue(schedule, 'schedule_not_found', 'Unknown schedule', 404);
        result = store.saveOperation({ ...schedule, state: 'stopped' });
      }
      else if (req.method === 'POST' && ['/runtimes/launch', '/runtimes/stop'].includes(path)) {
        adminOnly();
        const key = `runtime:${text(input.key, 'key')}`;
        requireValue(!publications.has(key), 'operation_busy', 'Runtime operation in progress', 409);
        const pending = path === '/runtimes/launch' ? launchRuntime(store, directory, input) : stopRuntime(store, input.key);
        publications.set(key, pending);
        try { result = await pending; } finally { publications.delete(key); }
      }
      else if (req.method === 'POST' && ['/resources/worktree', '/resources/finalise', '/resources/retire'].includes(path)) {
        adminOnly();
        if (path === '/resources/worktree') result = provisionWorktree(store, input);
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
      else if (req.method === 'POST' && path === '/runs') { adminOnly(); result = store.dispatch(input); }
      else {
        const match = path.match(/^\/runs\/([^/]+)(?:\/(acknowledge|submit|settle|cancel|publish|task|attach|recover|ask|interactions|publish-question|mutate|tasks|review|retire))?$/);
        requireValue(match, 'not_found', 'Unknown endpoint', 404);
        const [, id, action] = match;
        const run = store.run(id);
        requireValue(admin || run.request.bindingId === bindingId, 'forbidden', 'Run belongs to another binding', 403);
        if (req.method === 'POST' && admin && input.runId !== undefined && action !== 'recover') {
          requireValue(input.runId === (run.backendRunId ?? run.request.runId), 'stale_backend_run', 'Adapter no longer owns this backend invocation', 409);
        }
        if (req.method === 'GET' && !action) result = run;
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
          const key = digest([run.request.bindingId, input.kind, input.key]);
          requireValue(!publications.has(key), 'operation_busy', 'Operation is already in flight', 409);
          const pending = mutate(store, run, runTokens.get(id), api, input);
          publications.set(key, pending);
          try { result = await pending; } finally { publications.delete(key); }
        }
        else if (req.method === 'GET' && action === 'tasks') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          result = await api(run, runTokens.get(id), 'GET', `/api/companies/${encodeURIComponent(run.request.companyId)}/issues`);
        }
        else if (req.method === 'GET' && action === 'interactions') {
          requireValue(runTokens.has(id), 'adapter_unavailable', 'Live adapter credentials are unavailable', 503);
          result = await api(run, runTokens.get(id), 'GET', `/api/issues/${encodeURIComponent(run.request.taskId)}/interactions`);
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
  return {
    socketPath, token, store,
    close: async () => {
      await scheduler.close();
      await supervisor.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
