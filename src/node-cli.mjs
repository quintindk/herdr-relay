#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, lstatSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { nativeBackendClient } from './backend-client.mjs';
import { NodeJournal } from './node-journal.mjs';
import { tickNode } from './node-execution.mjs';
import { startNodeService } from './node-service.mjs';
import { serviceLock } from './service-lock.mjs';
import { requireValue, digest } from './protocol.mjs';
import { tickAutomation } from './node-automation.mjs';
import { hermesNodeBinding } from './node-hermes.mjs';
import { tickAgentNotices } from './node-notices.mjs';
import { herdrInventory, nodeHeartbeatPayload, publishHerdrInventory } from './node-discovery.mjs';
import { provisionNodeWorktree, finaliseNodeWorktree, retireNodeWorktree } from './node-resources.mjs';
import { nodeTasks } from './node-tasks.mjs';
import { enrolledDirectory, resolveFolderBinding } from './node-folder.mjs';
import { configureV2WorkerSession, v2WorkerInstructions, usesV2WorkerTools } from './node-worker-instructions.mjs';
import { NativeReceivers } from './native-receivers.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const { values } = parseArgs({ options: { config: { type: 'string' } } });
  requireValue(values.config, 'invalid_request', 'Usage: node src/node-cli.mjs --config PRIVATE_JSON');
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  requireValue(config.nodeId && config.stateDirectory && config.backend && Array.isArray(config.bindings), 'invalid_config', 'Node, state, backend and bindings required');
  requireValue(config.bindings.length <= 100, 'invalid_config', 'At most 100 explicit bindings supported');
  requireValue(!config.tasks || config.tasks.type === 'native', 'unsupported_provider_lifecycle',
    'Daemon execution currently requires native Tasks. External task lifecycle integration is incomplete');
  const directory = resolve(config.stateDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unlock = serviceLock(directory);
  let journal, service, timer;
  let pending = Promise.resolve(), closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; clearTimeout(timer); await pending;
    await service?.close(); journal?.close(); unlock();
  };
  try {
    const api = nativeBackendClient(config.backend);
    const infoPath = join(directory, 'backend-instance.json');
    let info;
    let connectedAtStartup = true;
    try {
      info = await api('GET', '/v1/info');
      if (!existsSync(infoPath)) writeFileSync(infoPath, JSON.stringify({ ...info, url: config.backend.url }), { flag: 'wx', mode: 0o600 });
      else {
        const pinned = JSON.parse(readFileSync(infoPath, 'utf8'));
        requireValue(pinned.instanceId === info.instanceId && pinned.url === config.backend.url, 'backend_identity_mismatch', 'Node backend scope changed');
      }
    } catch (error) {
      if ((error.status && error.status < 500) || !existsSync(infoPath)) throw error;
      info = JSON.parse(readFileSync(infoPath, 'utf8'));
      connectedAtStartup = false;
      requireValue(info.url === config.backend.url, 'backend_identity_mismatch', 'Offline backend URL changed');
    }
    requireValue(info.protocol === 'relay/0.2', 'protocol_mismatch', 'Native backend protocol mismatch');
    journal = new NodeJournal(join(directory, 'node.sqlite'), { nodeId: config.nodeId, instanceId: info.instanceId });
    const tasks = nodeTasks(journal, config.tasks, { nativeApi: api });
    const bindings = new Map();
    const ownedDefinitions = new Map();
    const workers = [];
    const nativeEndpoints = new Map();
    const socketPath = join(directory, 'node.sock');
    const receivers = new NativeReceivers(journal);
    const historicalBindings = new Map();
    const contextFiles = new Map();
    let workerIndexDigest;
    const loadBinding = async entry => {
      requireValue(['opencode-v2', 'opencode-v2-owned', 'hermes'].includes(entry.harness) && entry.agentId && entry.id,
        'invalid_binding', 'Explicit supported native binding required');
      const directWorkerTools = usesV2WorkerTools(entry);
      const retirement = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`retired-binding:${entry.id}`);
      if (retirement) {
        requireValue(JSON.parse(retirement.value).state === 'retired', 'retirement_pending', 'Inspect incomplete owned retirement before restarting this binding');
        return;
      }
      requireValue(entry.receiverGeneration || !bindings.has(entry.agentId), 'duplicate_binding', 'Agent has multiple local bindings');
      const contextFile = join(directory, `worker-${digest(entry.receiverGeneration ? [entry.agentId, entry.id] : entry.agentId)}.json`);
      if (entry.worktree) {
        requireValue(entry.harness === 'opencode-v2-owned' && entry.directory === entry.worktree.path,
          'invalid_worktree', 'Owned worktree path must equal the explicit owned runtime directory');
        provisionNodeWorktree(journal, { key: entry.worktree.key, repository: entry.worktree.repository, path: entry.worktree.path,
          branch: entry.worktree.branch, ...(entry.worktree.base ? { base: entry.worktree.base } : {}), bindingId: entry.id });
      }
      let binding;
      if (entry.harness === 'hermes') {
        binding = hermesNodeBinding(entry);
        await binding.native.snapshot();
      } else if (entry.harness === 'opencode-v2-owned') {
        const { provisionOwnedV2 } = await import('../packages/opencode-relay/provision.mjs');
        requireValue(entry.directory && entry.executable && entry.config && entry.reserved === true,
          'invalid_binding', 'Owned v2 executable, directory, private policy and reservation required');
        if (entry.resume === true) requireValue(!journal.works().some(work => work.bindingId === entry.id &&
          !['native_finished', 'settled', 'settled_waiting'].includes(work.state)) &&
          !journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all()
            .some(row => JSON.parse(row.data).bindingId === entry.id), 'native_unsettled', 'Resolve historical native work before owned runtime resume');
        binding = await provisionOwnedV2({ stateDirectory: directory, bindingId: entry.id, agentId: entry.agentId,
          executable: entry.executable, workspace: entry.directory, config: entry.config, workerContextFile: contextFile,
          resume: entry.resume === true });
        ownedDefinitions.set(entry.agentId, { entry, contextFile, failures: 0 });
      } else {
        const { OpenCode } = await import('../packages/opencode-relay/node_modules/@opencode/client/dist/promise/index.js');
        const { NativeOpenCodeV2, observeV2, checkV2Version } = await import('../packages/opencode-relay/native.mjs');
        requireValue(entry.identity && entry.url && entry.authFile && entry.reserved === true,
          'invalid_binding', 'Exact OpenCode identity, private auth and explicit conversation reservation required');
        const origin = new URL(entry.url);
        requireValue(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname) && !origin.username && !origin.password,
          'invalid_binding', 'Native service must be local');
        const auth = JSON.parse(readFileSync(entry.authFile, 'utf8'));
        requireValue(typeof auth.password === 'string' && auth.password, 'invalid_native_auth', 'Native password required');
        const client = OpenCode.make({ baseUrl: origin.origin, headers: {
          authorization: `Basic ${Buffer.from(`opencode:${auth.password}`).toString('base64')}` },
        fetch: (url, options) => fetch(url, { ...options, signal: options?.signal ?? AbortSignal.timeout(15000) }) });
        checkV2Version((await client.server.info()).version);
        const native = new NativeOpenCodeV2(client, entry.identity);
        // Historical conversations can be archived. They must not prevent the
        // new receiver starting or erase their pinned recovery obligations.
        if (!entry.receiverGeneration) await native.verify();
        binding = { id: entry.id, identity: entry.identity, native, observe: observeV2 };
      }
      if (entry.harness.startsWith('opencode-v2')) await configureV2WorkerSession(binding, entry.sessionPermissions);
      else requireValue(entry.sessionPermissions === undefined, 'invalid_permissions', 'Session permissions require a V2 binding');
      const nativeIdentity = digest(entry.harness === 'hermes' ? ['hermes', entry.hermes.url, entry.hermes.profile ?? '', entry.conversationId] :
        ['opencode-v2', binding.runtime?.descriptor.origin ?? entry.url, binding.identity?.sessionId ?? entry.identity.sessionId]);
      requireValue(!nativeEndpoints.has(nativeIdentity) || entry.receiverGeneration && nativeEndpoints.get(nativeIdentity) === entry.agentId,
        'conversation_alias', 'One exact conversation may receive work for only one agent');
      nativeEndpoints.set(nativeIdentity, entry.agentId);
      const worker = existsSync(contextFile) ? JSON.parse(readFileSync(contextFile, 'utf8')) :
        { socketPath, agentId: entry.agentId, sessionId: binding.identity?.sessionId ?? entry.identity?.sessionId ?? entry.conversationId,
          ...(entry.receiverGeneration ? { bindingId: entry.id, bindingRevision: entry.receiverGeneration } : {}), token: randomBytes(32).toString('hex') };
      requireValue(worker.socketPath === socketPath && worker.agentId === entry.agentId, 'context_conflict', 'Worker context changed');
      requireValue(worker.sessionId === (binding.identity?.sessionId ?? entry.identity?.sessionId ?? entry.conversationId),
        'context_conflict', 'Worker context belongs to a different conversation');
      if (!existsSync(contextFile)) writeFileSync(contextFile, JSON.stringify(worker), { flag: 'wx', mode: 0o600 });
      workers.push(worker);
      contextFiles.set(entry.id, contextFile);
      const cli = `${quote(process.execPath)} ${quote(join(dirname(fileURLToPath(import.meta.url)), 'node-worker-cli.mjs'))} --context ${quote(contextFile)}`;
      const configured = { ...binding, agentId: entry.agentId, ...(entry.receiverGeneration ? { receiverGeneration: entry.receiverGeneration } : {}),
        ...(entry.directory ? { directory: resolve(entry.directory) } : {}), agentInstructions: () =>
        `Use ${cli} questions to inspect addressed questions. Answer with ${cli} answer --key KEY --file JSON containing {id,expectedRevision,body}, or forward --key KEY --file JSON containing {id,expectedRevision,reason}.\n`,
      workerInstructions: execution => directWorkerTools ? v2WorkerInstructions(execution) :
        `Read and check cancellation: ${cli} read --execution ${quote(execution.id)} --run ${quote(execution.runId)}\n` +
        (execution.allowDelegation ? `Explicit bounded delegation is granted. Use ${cli} delegate --execution ${quote(execution.id)} --run ${quote(execution.runId)} --key KEY --file CHILD_JSON with {id,taskId,title,instructions,targetAgentId,reviewPolicy}. Then stage ${cli} wait-children --execution ${quote(execution.id)} --run ${quote(execution.runId)} --key WAIT_KEY --file WAIT_JSON with {childExecutionIds:[...]}, and finish the turn.\n` : '') +
        (execution.childExecutionIds?.length ? `Inspect supplied child receipts and refresh with ${cli} children --execution ${quote(execution.id)} --run ${quote(execution.runId)}. Only children with explicit agent review grants may be decided using ${cli} review-child --execution ${quote(execution.id)} --run ${quote(execution.runId)} --key KEY --file JSON with {id,expectedRevision,candidate,decision,reason}. Others require the human. Final root review remains human.\n` : '') +
        `Use the assigned scope. Do not read credentials. To ask asynchronously, create JSON {"prompt":"...","humanRequired":false} and call ${cli} ask --execution ${quote(execution.id)} --run ${quote(execution.runId)} --key QUESTION_KEY --file /absolute/question.json.\n` +
        `Otherwise write JSON {"candidate":"EXACT_CANDIDATE","summary":"RESULT"} and call ${cli} submit --execution ${quote(execution.id)} --run ${quote(execution.runId)} --key RESULT_KEY --file /absolute/result.json. After ask or submit finish this turn immediately.\n` };
      historicalBindings.set(entry.id, configured);
      if (!entry.receiverGeneration) bindings.set(entry.agentId, configured);
    };
    const refreshReceivers = async () => {
      for (const entry of receivers.list('native-binding')) if (!historicalBindings.has(entry.id)) await loadBinding(entry);
      for (const enrolment of receivers.list('enrolment')) {
        const entry = receivers.resolve(enrolment.id);
        const binding = entry && historicalBindings.get(entry.id);
        if (binding) bindings.set(enrolment.id, binding);
        else bindings.delete(enrolment.id);
      }
      if (config.identityVersion === 2) {
        const sessions = {};
        for (const binding of historicalBindings.values()) sessions[binding.identity.sessionId] = contextFiles.get(binding.id);
        for (const binding of bindings.values()) if (binding.receiverGeneration) sessions[binding.identity.sessionId] = contextFiles.get(binding.id);
        const value = { nodeId: config.nodeId, sessions };
        const hash = digest(value);
        if (hash !== workerIndexDigest) {
          const path = join(directory, 'worker-index.json');
          writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
          renameSync(`${path}.new`, path); workerIndexDigest = hash;
        }
      }
    };
    for (const entry of config.bindings) await loadBinding(entry);
    await refreshReceivers();
    if (connectedAtStartup) {
      for (const entry of config.bindings) {
        if (!bindings.has(entry.agentId)) continue;
        let agent;
        try { agent = await api('GET', `/v1/agents/${encodeURIComponent(entry.agentId)}`); }
        catch (error) {
          if (error.status !== 404) throw error;
          agent = await api('POST', '/v1/commands', { key: `agent-register:${digest([config.nodeId, entry.agentId])}`,
            action: 'agent.register', payload: { id: entry.agentId, nodeId: config.nodeId, name: entry.name ?? entry.agentId,
              capabilities: entry.capabilities ?? [], mode: entry.mode ?? 'headless',
              ...(bindings.get(entry.agentId)?.identity?.directory || entry.directory ? { directory: enrolledDirectory(bindings.get(entry.agentId)) } : {}) } });
        }
        requireValue(agent.nodeId === config.nodeId, 'agent_owner_changed', 'Agent belongs to another node');
        if (agent.directory) requireValue(agent.directory === enrolledDirectory(bindings.get(entry.agentId)),
          'agent_directory_changed', 'Configured native directory differs from enrolled folder');
      }
    }
    if (existsSync(socketPath)) {
      requireValue(lstatSync(socketPath).isSocket(), 'socket_conflict', 'Node socket path is not a socket');
      unlinkSync(socketPath);
    }
    service = await startNodeService({ journal, socketPath, workers, api, tasks });
    let lastHeartbeat = 0;
    const tick = () => {
      if (closed) return;
      const resolveBinding = async (agentId, pinned) => {
        const binding = pinned?.bindingId ? historicalBindings.get(pinned.bindingId) : bindings.get(agentId);
        if (binding && binding.agentId !== agentId) return null;
        const owned = ownedDefinitions.get(agentId);
        if (!owned || !binding) return binding;
        if (journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`retired-binding:${binding.id}`)) return null;
        try { binding.runtime.verify(); return binding; }
        catch {
          // A dead process is not proof that an unsettled native turn completed.
          // Recovery only resumes an idle owned binding with all old evidence kept.
          const unsettled = journal.works().some(work => work.bindingId === binding.id &&
            !['settled', 'settled_waiting', 'native_finished'].includes(work.state));
          const notices = journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all()
            .some(row => JSON.parse(row.data).bindingId === binding.id);
          if (unsettled || notices || owned.failures >= 3) return null;
          try {
            const { provisionOwnedV2 } = await import('../packages/opencode-relay/provision.mjs');
            const recovered = await provisionOwnedV2({ stateDirectory: directory, bindingId: owned.entry.id, agentId,
              executable: owned.entry.executable, workspace: owned.entry.directory, config: owned.entry.config,
              workerContextFile: owned.contextFile, resume: true });
            const next = { ...binding, ...recovered };
            bindings.set(agentId, next); owned.failures = 0;
            journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
              .run(`runtime-health:${agentId}`, JSON.stringify({ state: 'ready', generation: recovered.runtime.descriptor.generation, at: new Date().toISOString() }));
            return next;
          } catch (error) {
            owned.failures++;
            journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
              .run(`runtime-health:${agentId}`, JSON.stringify({ state: 'blocked', attempts: owned.failures, reason: error.code ?? 'recovery_failed' }));
            return null;
          }
        }
      };
      resolveBinding.folder = directory => resolveFolderBinding(bindings, directory, resolveBinding);
      pending = refreshReceivers().then(() => tickNode(journal, api, resolveBinding)).finally(async () => {
        await tickAutomation(journal, resolveBinding, Date.now(), api);
        await tickAgentNotices(journal, api, resolveBinding);
        for (const [agentId, owned] of ownedDefinitions) {
          const binding = bindings.get(agentId);
          const priorRetirement = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`retired-binding:${binding.id}`);
          if (priorRetirement && JSON.parse(priorRetirement.value).state === 'retired') continue;
          const works = journal.works().filter(work => work.bindingId === binding.id);
          const settled = works.filter(work => work.execution.state === 'completed' && work.execution.result &&
            ['native_finished', 'settled'].includes(work.state));
          for (const work of settled) {
            if (!owned.entry.retireOnCompletion && !owned.entry.worktree?.finalise) continue;
            const execution = await api('GET', `/v1/executions/${encodeURIComponent(work.id)}`);
            requireValue(execution.state === 'completed' && execution.result.candidate === work.execution.result.candidate &&
              execution.runId === work.execution.runId &&
              (execution.reviewPolicy === 'none' || execution.review?.decision === 'accept' && execution.review.resultDigest === execution.result.digest),
              'acceptance_required', 'Completion changed before lifecycle action');
            if (owned.entry.worktree?.finalise) {
              finaliseNodeWorktree(journal, { key: owned.entry.worktree.key, runId: execution.runId,
                candidate: execution.result.candidate, message: owned.entry.worktree.commitMessage ?? 'Relay task result' });
            }
            if (owned.entry.retireOnCompletion) {
              const prior = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`retired-binding:${binding.id}`);
              if (prior && JSON.parse(prior.value).state === 'retired') continue;
              requireValue(works.every(item => ['completed', 'cancelled', 'failed', 'rejected'].includes(item.execution.state) &&
                ['native_finished', 'settled'].includes(item.state)),
                'runtime_busy', 'Owned binding still has unsettled work');
              requireValue(!journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain','conflict')").all()
                .some(row => JSON.parse(row.data).bindingId === binding.id), 'runtime_busy', 'Owned binding has unsettled notice work');
              // Fence local admission before process shutdown. Retrying keeps this
              // explicit retirement rather than automatically resuming the runtime.
              journal.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(`retired-binding:${binding.id}`, JSON.stringify({ executionId: work.id, state: 'retiring' }));
              await binding.runtime.stop();
              if (owned.entry.worktree?.cleanup) await retireNodeWorktree(journal, api, { key: owned.entry.worktree.key,
                runId: execution.runId, candidate: execution.result.candidate });
              journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ executionId: work.id, state: 'retired' }), `retired-binding:${binding.id}`);
            }
          }
        }
        if (Date.now() - lastHeartbeat >= 5000) {
          lastHeartbeat = Date.now();
          await api('POST', '/v1/commands', { key: `heartbeat:${lastHeartbeat}`, action: 'node.heartbeat', payload: nodeHeartbeatPayload(config.nodeId, info) });
          for (const [agentId, binding] of bindings) {
            const agent = await api('GET', `/v1/agents/${encodeURIComponent(agentId)}`);
            let availability = 'unknown';
            try { availability = (await binding.native.snapshot()).idle ? 'available' : 'busy'; } catch {}
            await api('POST', '/v1/commands', { key: `advertise:${agentId}:${lastHeartbeat}`, action: 'agent.advertise',
              payload: { id: agentId, expectedRevision: agent.revision, availability,
                conversationId: binding.identity?.sessionId ?? config.bindings.find(entry => entry.agentId === agentId).conversationId,
                bindingRevision: binding.receiverGeneration ?? binding.runtime?.descriptor.generation ?? 1 } });
          }
          if (config.herdr?.socketPath) await publishHerdrInventory(api, { ...config.herdr, nodeId: config.nodeId },
            await herdrInventory(config.herdr.socketPath));
        }
      }).catch(error => {
        console.error(JSON.stringify({ code: error.code ?? 'node_tick_failed' }));
      }).finally(() => { if (!closed) timer = setTimeout(tick, 1000); });
    };
    process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
    tick();
    console.log(JSON.stringify({ state: 'running', nodeId: config.nodeId, socketPath, bindings: bindings.size }));
  } catch (error) { await close(); throw error; }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'node_failed', message: error.message })); process.exitCode = 1;
}
