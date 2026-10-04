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

export async function startService({ directory, paperclipUrl, api = paperclipClient(paperclipUrl) }) {
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
      if (req.method === 'GET' && path === '/health') result = { status: 'ok', delivery: ['pull', 'opencode', 'hermes'], schema: 3 };
      else if (req.method === 'GET' && path === '/bindings') { adminOnly(); result = store.bindings(); }
      else if (req.method === 'GET' && path === '/peers') {
        const company = bindingId ? store.binding(bindingId).config.companyId : null;
        result = store.bindings().filter(binding => !company || binding.config.companyId === company)
          .map(binding => ({ id: binding.id, revision: binding.revision, agentId: binding.config.agentId,
            harness: binding.config.harness, delivery: binding.config.delivery }));
      }
      else if (req.method === 'POST' && path === '/bindings') {
        adminOnly();
        if (input.delivery === 'opencode') await new OpenCode({ ...input, opencode: nativeConfig(input.opencode) }).verify();
        if (input.delivery === 'hermes') await new Hermes({ ...input, hermes: hermesConfig(input.hermes) }).verify();
        result = store.register(input);
      }
      else if (req.method === 'GET' && path === '/runs') result = store.runs(bindingId);
      else if (req.method === 'POST' && path === '/runs') { adminOnly(); result = store.dispatch(input); }
      else {
        const match = path.match(/^\/runs\/([^/]+)(?:\/(acknowledge|submit|settle|cancel|publish|task|attach|recover|ask|interactions|publish-question))?$/);
        requireValue(match, 'not_found', 'Unknown endpoint', 404);
        const [, id, action] = match;
        const run = store.run(id);
        requireValue(admin || run.request.bindingId === bindingId, 'forbidden', 'Run belongs to another binding', 403);
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
  return {
    socketPath, token, store,
    close: async () => {
      await supervisor.close();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
