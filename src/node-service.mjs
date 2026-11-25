import { createServer } from 'node:http';
import { Transform, finished } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chmodSync, existsSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { headlessArtifactOperation, recordHeadlessObservation, probeHeadlessArtifacts } from './headless-artifacts.mjs';
import { headlessProbeId } from './headless-setup-contract.mjs';
import { digest, requireValue, RelayError, canonical } from './protocol.mjs';
import { nativeTasksProvider } from './tasks-provider.mjs';
import { herdrInventory } from './node-discovery.mjs';
import { executionAttachmentReceiptKey, nativeReadApi } from './native-worker-api.mjs';
import { reconcileDispatchIdentity, refusedDispatchErrors, dispatchReceipt } from './interactive-dispatch-reconciliation.mjs';
import { reconcileInteractiveWork, previewInteractiveRecovery, applyInteractiveRecovery } from './native-interaction.mjs';
import { inspectContract, previewContractUpdate } from './node-headless-contract.mjs';
import { validateHeadlessTaskPayload } from './headless-task-schema.mjs';
import { abandonedWork } from './node-journal.mjs';
import { runResultNotifications } from './run-result-notifications.mjs';
import { validateOwnerMessage } from './owner-messages.mjs';
import { MAX_ATTACHMENT_BYTES, validateAttachmentSize, validateSha256 } from './task-attachments.mjs';
import { attachmentReceiptPath } from './attachment-transport.mjs';

const preparationRecovery = Object.freeze({
  native_project_identity_changed: 'OpenCode reports a different project ID for this same chat. Preparation stopped before a request was queued. Ask the human to run /relay-attach in this existing chat and confirm the same Relay enrolment. Wait for confirmed attachment, then retry relay_interactive_prepare with the original ID, key and payload, reusing the existing worktree. Do not recreate the agent/worktree, use the backend-admin CLI or borrow credentials.',
  native_identity_mismatch: 'The requester\'s saved OpenCode conversation identity no longer matches. Preparation stopped before a request was queued. Ask the human to inspect the exact chat, workspace and saved attachment first. Do not automatically reattach, retry provisioning, recreate the agent/worktree or use the backend-admin CLI. After explicit recovery, retain the original preparation ID, key and payload.',
  native_model_unavailable: 'The requester\'s native model cannot be resolved. Preparation stopped before a request was queued. Ask the human to select a valid model in this existing OpenCode chat and check its Relay attachment. After that is confirmed, retry the original preparation ID, key and payload. Do not create a replacement agent or copy provider credentials.',
});

async function preparationModel(worker, getNativeModel) {
  try { return await getNativeModel?.(worker); }
  catch (error) {
    // Only fixed, known guidance is public. Native errors can contain private
    // responses, credentials or paths and must never be echoed as instructions.
    if (Object.hasOwn(preparationRecovery, error.code)) throw new RelayError(error.code, `[${error.code}] ${preparationRecovery[error.code]}`, 409);
    throw error;
  }
}

// Worker credentials are exact agent scopes. They confer neither owner backend
// access nor authority over a different node's execution.
export async function startNodeService({ journal, socketPath, workers, api, tasks, resolveBinding, getNativeModel, getHeadlessConnections, getHeadlessAccess, getBackendFeatures, maintenance = () => false }) {
  tasks ??= api ? { ...nativeTasksProvider(api), type: 'native' } : null;
  requireValue(!existsSync(socketPath), 'socket_exists', 'Node socket already exists. Verify the old service before removing it');
  const handle = async (req, res) => {
    try {
      const auth = req.headersDistinct.authorization;
      requireValue(auth?.length === 1, 'unauthorised', 'Single worker credential required', 401);
      const token = auth[0].match(/^Bearer (.+)$/)?.[1] ?? '';
      const worker = workers.find(item => digest(item.token) === digest(token));
      requireValue(worker && token, 'unauthorised', 'Worker credential required', 401);
      const url = new URL(req.url, 'http://node'), path = url.pathname;
      const continueRequest = () => { if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue(); };
      const ownsWork = work => work?.execution.targetAgentId === worker.agentId &&
        (!worker.sessionId || !work.nativeConversationId || work.nativeConversationId === worker.sessionId) &&
        (!worker.bindingId || work.bindingId === worker.bindingId);
      const lookupWork = async ({ executionId, runId, inputRevision }, { read = false, scoped = false, checkBinding } = {}) => {
        let work = journal.work(executionId);
        requireValue(ownsWork(work) && work.execution.runId === runId, 'forbidden', 'Exact current worker execution required', 403);
        requireValue(!abandonedWork(work) || read, 'work_abandoned', 'This invocation was administratively abandoned; it cannot dispatch effects or submit a result', scoped ? 403 : undefined);
        if (resolveBinding) {
          const binding = await resolveBinding(worker.agentId, work);
          if (binding) {
            checkBinding?.(binding);
            work = await reconcileInteractiveWork(journal, binding, work);
          }
        }
        if (work.interaction && !read) requireValue(inputRevision === work.interaction.revision ||
          inputRevision === undefined && work.interaction.inputIds.length === 0,
        'stale_input_revision', 'Human input changed. Read the current execution before acting', scoped ? 403 : 409);
        return work;
      };
      const verifyExecutionScope = async ({ executionId, runId, sourceMessageId, inputRevision }) => {
        const active = allowed => requireValue(allowed, 'execution_source_required',
          'Native CLI requires this exact active interactive execution, not a human operator context', 403);
        active(api && !worker.headlessSetupId && worker.mode !== 'headless');
        const work = await lookupWork({ executionId, runId, inputRevision }, { scoped: true,
          checkBinding: binding => active(binding.interactive !== false) });
        active(work.execution.state === 'accepted' && !work.execution.cancellationRequested && !work.staged &&
          !work.execution.monitor && !work.execution.localOccurrence &&
          ['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) && sourceMessageId && sourceMessageId === work.invocation?.messageId);
        return work;
      };
      const checkMaintenance = () => requireValue(!maintenance(), 'maintenance', 'Node upgrade maintenance is active. Retry the same immutable operation afterwards', 503);
      const clientLifetime = () => {
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableFinished) controller.abort(); });
        return controller;
      };
      if (req.method === 'GET' && path === '/work/task-attachment-content') {
        const keys = [...url.searchParams.keys()];
        const p = Object.fromEntries(url.searchParams);
        requireValue(new Set(keys).size === keys.length && keys.every(key => ['executionId', 'runId', 'sourceMessageId', 'taskId', 'id', 'inputRevision'].includes(key)) &&
          p.executionId && p.runId && p.sourceMessageId && p.taskId && p.id && p.inputRevision !== '', 'invalid_query', 'Exact attachment and execution scope required');
        const controller = clientLifetime();
        const work = await verifyExecutionScope(p);
        requireValue(p.taskId === work.execution.taskId, 'execution_cli_scope', 'Execution CLI can only download attachments from its assigned task', 403);
        const { stream, sha256, size } = await api.downloadAttachment(p.taskId, p.id, { signal: controller.signal });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'X-Content-SHA256': sha256, 'Cache-Control': 'no-store' });
        await pipeline(stream, res);
        return;
      }
      if (req.method === 'PUT' && path === '/work/blob') {
        // Scope checks and upstream cleanup can finish before a late reset.
        req.on('error', () => {});
        checkMaintenance();
        requireValue(url.searchParams.size === 0, 'invalid_query', 'Blob upload takes no query parameters');
        req.setTimeout(30000, () => req.destroy());
        const header = name => {
          const values = req.headersDistinct[name];
          requireValue(!values || values.length === 1 && values[0], 'invalid_request', `Invalid ${name} header`);
          return values?.[0];
        };
        const sha256 = validateSha256(header('x-relay-sha256')), length = header('content-length');
        requireValue(/^\d+$/.test(length ?? ''), 'invalid_attachment', 'Content-Length must be a non-negative integer');
        const size = validateAttachmentSize(Number(length));
        const executionId = header('x-relay-execution-id'), runId = header('x-relay-run-id'), sourceMessageId = header('x-relay-source-message-id');
        const taskId = header('x-relay-task-id'), inputRevision = header('x-relay-input-revision');
        requireValue(executionId && runId && sourceMessageId && taskId, 'invalid_request', 'Exact execution and task headers required');
        const controller = clientLifetime();
        const work = await verifyExecutionScope({ executionId, runId, sourceMessageId, inputRevision });
        requireValue(taskId === work.execution.taskId, 'execution_cli_scope', 'Execution CLI can only upload attachments to its assigned task', 403);
        let bytes = 0;
        const capped = new Transform({ transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_ATTACHMENT_BYTES) return callback(new RelayError('blob_too_large', 'Attachment exceeds the size limit', 413));
          if (bytes > size) return callback(new RelayError('blob_size_mismatch', 'Upload exceeds Content-Length'));
          callback(null, chunk);
        } });
        const stopWatching = finished(req, { readable: true, writable: false }, error => {
          if (error) capped.destroy(error);
        });
        try {
          // Keep req alive on validation/upstream errors so the caller gets the refusal.
          const upload = api.uploadBlob(sha256, capped, { size, signal: controller.signal });
          // Refuse maintenance and bad worker scope before the client's first
          // body write can race the final response on the UNIX socket.
          continueRequest();
          req.pipe(capped);
          const result = await upload;
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } finally { stopWatching(); req.unpipe(capped); capped.destroy(); }
        return;
      }
      requireValue(req.method === 'POST', 'invalid_request', 'POST required');
      continueRequest();
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length; requireValue(size <= 128 * 1024, 'request_too_large', 'Request too large', 413); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { throw new RelayError('invalid_json', 'JSON request required'); }
      requireValue(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request', 'Object required');
      const readOnly = ['/agent/interactive-repair-preview', '/agent/interactive-reconcile-preview', '/agent/headless-contract-preview', '/agent/native-api', '/work/native-api', '/work/current', '/work/read', '/work/children', '/agent/interactive-context', '/agent/interactive-grants', '/agent/interactive-status',
        '/agent/status', '/agent/schedules', '/agent/notifications', '/agent/tasks', '/agent/agents', '/agent/task', '/agent/task-identity', '/agent/comments', '/agent/relations',
        '/agent/questions', '/agent/messages', '/agent/message', '/agent/headless-status', '/agent/headless-grants', '/agent/headless-access', '/agent/headless-connections'];
      if (!readOnly.includes(path)) checkMaintenance();
      const currentReceiver = () => {
        requireValue(worker.bindingId && worker.bindingRevision, 'standing_enrolment_required', 'Stable agent enrolment required', 403);
        journal.assertReceiver({ id: worker.bindingId, agentId: worker.agentId, receiverGeneration: worker.bindingRevision });
      };
      const ownerMessage = async (input, work) => {
        validateOwnerMessage(input);
        requireValue(api && (await getBackendFeatures?.())?.ownerInboxMessages, 'backend_upgrade_required', 'Backend must support plain owner Inbox messages');
        const incoming = journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain')").all()
          .some(row => { const notice = JSON.parse(row.data); return notice.kind === 'message' && notice.bindingId === worker.bindingId; });
        requireValue(!incoming, 'message_reply_not_authorised', 'A peer message does not authorise forwarding messages to the owner', 403);
        const scope = [worker.agentId, ...(work ? [work.id, work.execution.runId] : []), input.key];
        const command = { key: `owner-message:${digest(scope)}`, action: 'owner_message.send', payload: {
          id: `owner_message_${digest(scope)}`, senderAgentId: worker.agentId, sourceConversationId: worker.sessionId,
          ...(work ? { executionId: work.id, runId: work.execution.runId } : { sourceBindingRevision: worker.bindingRevision }),
          ...(input.subject !== undefined ? { subject: input.subject } : {}), body: input.body } };
        journal.queue(command);
        await journal.flush(async (method, path, body) => {
          const result = await api(method, path, body);
          if (method === 'POST' && path === '/v1/commands' && body.action === 'owner_message.send') {
            const p = body.payload;
            requireValue(result?.id === p.id && result.state === 'unread' && result.revision === 1 && result.authority === 'information_only' &&
              result.sender?.agentId === p.senderAgentId && result.sender.conversationId === p.sourceConversationId &&
              result.subject === (p.subject ?? 'Agent update') && result.body === p.body && typeof result.userId === 'string' && result.userId,
            'invalid_owner_message_receipt', 'Owner message acknowledgement is unconfirmed. Reconcile the original key', 502);
          }
          return result;
        });
        return journal.receipt(command.key);
      };
      const checkContract = (setup, grant) => {
        const op = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`headless-op:${setup.id}`);
        if (!op) { requireValue(!setup.contract, 'job_contract_missing', 'Pinned instruction state is missing'); return; }
        return inspectContract(journal, setup, grant);
      };
      if (['/agent/headless-contract-preview', '/agent/headless-contract-request'].includes(path)) {
        currentReceiver();
        requireValue(api && !worker.headlessSetupId && (await getBackendFeatures?.())?.headlessContractRevisions,
          'headless_requester_scope', 'Interactive coordinator and contract-revision capable backend required', 403);
        requireValue(Object.keys(body).every(k => ['setupId', 'files', 'key', 'previewHash'].includes(k)) && typeof body.setupId === 'string', 'invalid_contract_update', 'Exact setup and candidate files required');
        const { setup, grant } = await api('GET', `/v1/headless_setups/${encodeURIComponent(body.setupId)}/authority`);
        requireValue(setup.requesterAgentId === worker.agentId && setup.nodeId === journal.nodeId && setup.directory === grant.directory,
          'headless_requester_scope', 'Only the original local coordinator may update instructions', 403);
        const request = path.endsWith('request');
        const key = `contract-request:${worker.agentId}:${body.key}`;
        const previous = request && journal.receipt(key);
        if (previous) {
          requireValue(previous.command.payload.previewHash === body.previewHash &&
            digest(previous.command.payload.files.map(f => ({ path: f.path, content: f.after }))) === digest(body.files), 'operation_conflict', 'Original instruction request changed');
          await journal.flush(api);
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(journal.receipt(key))); return;
        }
        const preview = previewContractUpdate(journal, setup, grant, body.files);
        let result = preview;
        if (request) {
          requireValue(typeof body.key === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(body.key) && body.previewHash === preview.previewHash,
            'stale_contract_preview', 'Stable key and exact preview hash required');
          requireValue(!journal.works().some(w => !abandonedWork(w) && ownsWork(w) && !['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state)),
            'headless_human_context_required', 'Assigned executions cannot authorise instruction updates', 403);
          journal.queue({ key, action: 'headless.contract_request', payload: { id: `contract_${digest([worker.agentId, body.key])}`,
            setupId: setup.id, expectedRevision: setup.revision, grantRevision: grant.revision, fromDigest: preview.fromDigest,
            files: preview.files, previewHash: preview.previewHash, requesterAgentId: worker.agentId,
            sourceConversationId: worker.sessionId, sourceBindingRevision: worker.bindingRevision } });
          await journal.flush(api); result = journal.receipt(key);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/native-api') {
        currentReceiver();
        requireValue(api && !worker.headlessSetupId && Object.keys(body).length === 1 && body.request,
          'interactive_cli_required', 'Enrolled interactive read-only CLI scope required', 403);
        const result = await nativeReadApi(api, body.request, worker);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (['/agent/interactive-reconcile-preview', '/agent/interactive-reconcile-apply'].includes(path)) {
        currentReceiver();
        requireValue(api && resolveBinding && !worker.headlessSetupId && Object.keys(body).every(k => ['executionId', 'key', 'previewHash', 'sourceMessageId'].includes(k)),
          'recovery_ineligible', 'Exact local interactive recovery required');
        const work = journal.work(body.executionId);
        requireValue(ownsWork(work), 'forbidden', 'Recovery belongs to another assignment', 403);
        const key = `interactive-recovery:${worker.agentId}:${body.key}`;
        const applied = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
        if (path.endsWith('apply') && applied) {
          const previous = JSON.parse(applied.value);
          requireValue(previous.previewHash === body.previewHash && previous.sourceMessageId === body.sourceMessageId && previous.executionId === body.executionId,
            'operation_conflict', 'Recovery key changed');
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(previous)); return;
        }
        const fresh = await api('GET', `/v1/executions/${encodeURIComponent(work.id)}`);
        requireValue(fresh.state === 'accepted' && !fresh.cancellationRequested && fresh.revision === work.execution.revision && fresh.runId === work.execution.runId,
          'recovery_ineligible', 'Backend execution changed; inspect it again');
        const binding = await resolveBinding(worker.agentId, work), preview = await previewInteractiveRecovery(journal, binding, work);
        let result = preview;
        if (path.endsWith('apply')) {
          const current = await api('GET', `/v1/executions/${encodeURIComponent(work.id)}`);
          requireValue(current.revision === fresh.revision && !current.cancellationRequested && current.state === 'accepted', 'recovery_ineligible', 'Execution changed during recovery inspection');
          requireValue(typeof body.key === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(body.key) && preview.previewHash === body.previewHash,
            'stale_recovery_preview', 'Exact preview and immutable key required');
          result = journal.transaction(() => {
            currentReceiver();
            const recovered = applyInteractiveRecovery(journal, work, preview, body.sourceMessageId);
            const receipt = { state: 'applied', executionId: work.id, previewHash: body.previewHash, sourceMessageId: body.sourceMessageId, localState: recovered.state, promptReplayed: false };
            journal.db.prepare('INSERT INTO settings VALUES (?,?)').run(key, JSON.stringify(receipt)); return receipt;
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/headless-access') {
        requireValue(api && worker.headlessSetupId && Object.keys(body).length === 0, 'headless_grant_required', 'Exact headless worker scope required', 403);
        const result = await api('GET', `/v1/headless_setups/${worker.headlessSetupId}/authority`);
        requireValue(result.setup.agentId === worker.agentId && result.setup.sessionId === worker.sessionId, 'headless_scope_mismatch', 'Headless session scope changed', 403);
        const contract = checkContract(result.setup, result.grant);
        const { accessReferences } = await import('../packages/opencode-relay/headless-access.mjs');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...accessReferences(result.grant), ...contract })); return;
      }
      if (path === '/agent/headless-connections') {
        currentReceiver(); requireValue(Object.keys(body).length === 0 && getHeadlessConnections, 'native_integration_unavailable', 'Existing authenticated OpenCode connection discovery unavailable');
        const result = await getHeadlessConnections(worker);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/headless-grant' || path === '/agent/headless-revoke') {
        currentReceiver();
        requireValue(!worker.headlessSetupId, 'headless_requester_scope', 'A headless worker cannot issue or revoke grants', 403);
        requireValue(api && (await getBackendFeatures?.())?.nodeHeadlessGrants, 'backend_upgrade_required', 'Backend must support node-local headless grants');
        requireValue(Object.keys(body).every(k => ['key', 'payload'].includes(k)) && typeof body.key === 'string' &&
          body.key.trim() && body.key.length <= 100 && body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload),
        'invalid_request', 'Stable key and exact grant payload required');
        const operation = path.endsWith('grant') ? 'grant' : 'revoke';
        if (body.payload.schedule?.runResultNotifications !== undefined) {
          runResultNotifications(body.payload.schedule.runResultNotifications);
          requireValue((await getBackendFeatures?.())?.runResultNotifications, 'backend_upgrade_required', 'Backend must support run result notifications');
        }
        const command = { key: `agent-headless:${worker.agentId}:${operation}:${body.key}`, action: `agent.headless_${operation}`,
          payload: { agentId: worker.agentId, conversationId: worker.sessionId, bindingRevision: worker.bindingRevision, payload: body.payload } };
        journal.queue(command); await journal.flush(api);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(journal.receipt(command.key))); return;
      }
      if (['/agent/headless-setup', '/agent/headless-status', '/agent/headless-grants'].includes(path)) {
        currentReceiver(); requireValue(api, 'backend_unavailable', 'Native backend required');
        requireValue((await getBackendFeatures?.())?.headlessSetup, 'backend_upgrade_required', 'Backend must support authenticated headless setup');
        let result;
        if (path.endsWith('grants')) {
          requireValue(Object.keys(body).length === 0, 'invalid_request', 'Grant discovery takes no overrides');
          const items = []; let cursor;
          do { const page = await api('GET', `/v1/headless_grants?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
            items.push(...page.items.filter(g => g.requesterAgentId === worker.agentId)); cursor = page.nextCursor;
          } while (cursor);
          result = { items, complete: true };
        } else if (path.endsWith('setup')) {
          requireValue(Object.keys(body).every(k => ['key', 'grantId', 'retry', 'runResultNotifications'].includes(k)) && typeof body.key === 'string' && body.key.trim() && body.key.length <= 100 && typeof body.grantId === 'string' && (body.retry === undefined || typeof body.retry === 'boolean'),
            'invalid_request', 'Stable key and authorised grant ID required');
          if (body.runResultNotifications !== undefined) {
            runResultNotifications(body.runResultNotifications);
            requireValue((await getBackendFeatures?.())?.runResultNotifications, 'backend_upgrade_required', 'Backend must support run result notifications');
          }
          requireValue(!journal.works().some(w => !abandonedWork(w) && ownsWork(w) && !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(w.execution.state)),
            'headless_human_context_required', 'Scheduled/delegated work cannot reuse human-chat setup authority', 403);
          requireValue(!journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain')").all()
            .some(row => { const notice = JSON.parse(row.data); return notice.kind === 'message' && notice.bindingId === worker.bindingId; }),
            'headless_human_context_required', 'Peer messages cannot authorise headless setup', 403);
          const command = { key: `headless-source:${worker.agentId}:${body.key}`, action: 'headless.request', payload: { grantId: body.grantId, ...(body.retry ? { retry: true } : {}),
            ...(body.runResultNotifications !== undefined ? { runResultNotifications: body.runResultNotifications } : {}),
            requesterAgentId: worker.agentId, sourceConversationId: worker.sessionId, sourceBindingRevision: worker.bindingRevision } };
          journal.queue(command); await journal.flush(api); result = journal.receipt(command.key);
        } else {
          requireValue(Object.keys(body).length === 1 && typeof body.id === 'string', 'invalid_request', 'Exact setup ID required');
          const setup = await api('GET', `/v1/headless_setups/${encodeURIComponent(body.id)}`);
          requireValue(setup.requesterAgentId === worker.agentId, 'forbidden', 'Only the original coordinator may inspect this setup', 403);
          let schedule = null; try { schedule = await api('GET', `/v1/schedules/${setup.scheduleId}`); } catch (e) { if (e.status !== 404) throw e; }
          const local = journal.db.prepare('SELECT data FROM schedules WHERE id=?').get(setup.scheduleId);
          const installed = local && JSON.parse(local.data);
          let blocker = setup.blocker ?? null;
          try { const authority = await api('GET', `/v1/headless_setups/${setup.id}/authority`); checkContract(setup, authority.grant); await getHeadlessAccess?.(worker, setup); } catch (error) { blocker = error.code ?? 'headless_grant_unavailable'; }
          const activationPending = setup.contract && setup.appliedContractRevision !== setup.contract.revision;
          const opRow = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`headless-op:${setup.id}`);
          const op = opRow ? JSON.parse(opRow.value) : null;
          result = { id: setup.id, agentId: setup.agentId, scheduleId: setup.scheduleId, state: blocker ? setup.state === 'ready' || setup.state === 'blocked' ? 'blocked' : 'waiting_for_access' : setup.contract && setup.appliedContractRevision !== setup.contract.revision ? 'awaiting_contract_activation' : setup.state === 'ready' && schedule?.appliedRevision !== schedule?.revision ? 'awaiting_schedule_ack' : setup.state,
            blocker, revision: schedule?.revision ?? null, appliedRevision: schedule?.appliedRevision ?? null,
            runResultNotifications: runResultNotifications(schedule?.definition.runResultNotifications ?? setup.runResultNotifications),
            contract: setup.contract ?? null, appliedContractRevision: setup.appliedContractRevision ?? 0,
            contractActivation: setup.contractActivation ? { ...setup.contractActivation, localState: op?.contractActivation?.state ?? null,
              blocker: activationPending ? op?.contractBlocker ?? null : null,
              wait: activationPending ? op?.contractWait?.requestId === setup.contract.requestId ? op.contractWait : {
                reason: 'awaiting_node_activation_check', requestId: setup.contract.requestId,
              } : null } : null,
            connectionRebind: setup.connectionRebind ?? null,
            nextFiring: setup.state === 'ready' && !blocker && !activationPending && schedule?.definition.enabled && !schedule.cancelled &&
              schedule.revision === schedule.appliedRevision && installed?.definition.revision === schedule.revision && installed.state === 'active'
              ? installed.nextAt : null, runtime: 'shared-auth-headless', restartRequired: false };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/interactive-context') {
        requireValue(Object.keys(body).length === 0, 'invalid_request', 'Discussion context takes no overrides');
        const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`interactive-context:${worker.bindingId}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(row ? JSON.parse(row.value) : { topic: null })); return;
      }
      if (path === '/agent/interactive-grants') {
        requireValue(api && Object.keys(body).length === 0, 'invalid_request', 'Grant discovery takes no overrides');
        const items = [];
        let cursor;
        do {
          const page = await api('GET', `/v1/provision_grants?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
          items.push(...page.items.filter(g => g.requesterAgentId === worker.agentId)); cursor = page.nextCursor;
        } while (cursor);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items, complete: true })); return;
      }
      if (path === '/agent/interactive-driver') {
        currentReceiver();
        requireValue(Object.keys(body).every(k => k === 'herdrSocketPath') && isAbsolute(body.herdrSocketPath ?? ''), 'invalid_request', 'Local Herdr socket required');
        requireValue(!worker.headlessSetupId, 'interactive_human_context_required', 'Interactive caller required', 403);
        const socket = realpathSync(body.herdrSocketPath), stat = statSync(socket);
        requireValue(stat.isSocket() && (!process.getuid || stat.uid === process.getuid()), 'invalid_herdr_config', 'Herdr socket must belong to this OS user');
        const snapshot = await herdrInventory(socket);
        requireValue(snapshot.protocol === 22 && snapshot.agents.some(agent => agent.agent === 'opencode' && agent.agent_session?.kind === 'id' && agent.agent_session.value === worker.sessionId),
          'native_placement_mismatch', 'Herdr must report the exact calling OpenCode session');
        journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(`interactive-driver:${worker.agentId}`, JSON.stringify({ agentId: worker.agentId, herdrSocketPath: socket, verifiedAt: new Date().toISOString() }));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ state: 'registered' })); return;
      }
      if (path === '/agent/interactive-status') {
        requireValue(api && Object.keys(body).length === 1 && typeof body.id === 'string', 'invalid_request', 'Exact preparation ID required');
        if ((await getBackendFeatures?.())?.grantsManagement) {
          let permission;
          try { permission = await api('GET', `/v1/grant_requests/${encodeURIComponent(body.id)}`); }
          catch (error) { if (error.status !== 404) throw error; }
          if (permission) {
            requireValue(permission.requesterAgentId === worker.agentId, 'forbidden', 'Permission request belongs to another agent', 403);
            if (permission.state !== 'approved') {
              res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(permission)); return;
            }
            if (permission.kind === 'interactive_repair') body.id = permission.provisionRequestId;
          }
        }
        const request = await api('GET', `/v1/provision_requests/${encodeURIComponent(body.id)}`);
        requireValue(request.requesterAgentId === worker.agentId, 'forbidden', 'Only the initiating agent may inspect this request', 403);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(request)); return;
      }
      if (['/agent/interactive-repair-preview', '/agent/interactive-repair-request'].includes(path)) {
        currentReceiver();
        requireValue(!worker.headlessSetupId, 'interactive_human_context_required', 'Headless jobs cannot request interactive preparation repair', 403);
        requireValue(api && (await getBackendFeatures?.())?.interactiveRecovery,
          'backend_upgrade_required', 'Interactive recovery requires the original interactive requester and a recovery-capable backend', 409);
        const previewing = path.endsWith('preview');
        requireValue(Object.keys(body).every(key => (previewing ? ['id', 'scope'] : ['key', 'payload']).includes(key)), 'invalid_request', 'Exact repair preview or immutable request payload required');
        if (previewing) requireValue(typeof body.id === 'string' && body.id.trim() && body.id.length <= 96,
          'invalid_request', 'Exact original preparation ID required');
        const source = { requesterAgentId: worker.agentId, sourceConversationId: worker.sessionId, sourceBindingRevision: worker.bindingRevision };
        let result;
        if (previewing) result = await api('POST', '/v1/interactive-repair-preview', { ...body, ...source });
        else {
          requireValue(typeof body.key === 'string' && body.key.trim() && body.key.length <= 100 && body.payload &&
            Object.keys(body.payload).every(key => ['id', 'preparationId', 'expectedRevision', 'scope', 'previewHash', 'reason'].includes(key)),
            'invalid_request', 'A repair request needs its inspected revision, exact preview hash and unchanged scope');
          const key = `interactive-source:${worker.agentId}:${body.key}`;
          journal.queue({ key, action: 'interactive.repair_request', payload: { ...body.payload, ...source } });
          await journal.flush(api); result = journal.receipt(key);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (['/agent/interactive-prepare', '/agent/interactive-dispatch', '/agent/interactive-cancel'].includes(path)) {
        currentReceiver();
        requireValue(!worker.headlessSetupId, 'interactive_human_context_required', 'Headless jobs cannot use interactive provisioning', 403);
        requireValue(api && Object.keys(body).every(k => ['key', 'payload'].includes(k)) && typeof body.key === 'string' &&
          body.key.trim() && body.key.length <= 100 && body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload), 'invalid_request', 'Immutable key and bounded provisioning payload required');
        requireValue(path === '/agent/interactive-prepare' || !journal.works().some(w => !abandonedWork(w) && ownsWork(w) && !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(w.execution.state)),
          'interactive_human_context_required', 'Scheduled and delegated executions cannot create agents through the human-chat route', 403);
        const operation = path.slice('/agent/interactive-'.length);
        const allowed = operation === 'prepare' ? ['id', 'grantId', 'nodeId', 'directory', 'agentId', 'name', 'createDirectory', 'instance', 'profile', 'topic', 'permissionScope'] :
          operation === 'dispatch' ? ['id', 'taskId', 'taskRevision', 'executionId', 'title', 'instructions'] : ['id', 'expectedRevision', 'reason'];
        requireValue(Object.keys(body.payload).every(k => allowed.includes(k)), 'invalid_request', 'Caller cannot override its provisioning identity');
        if (operation === 'prepare' && !body.payload.grantId) requireValue((await getBackendFeatures?.())?.grantsManagement,
          'backend_upgrade_required', 'Backend must support Grants approval requests');
        const key = `interactive-source:${worker.agentId}:${body.key}`;
        const previous = journal.receipt(key);
        const inheritedModel = operation === 'prepare' ? previous ? previous.command.payload.model : await preparationModel(worker, getNativeModel) : undefined;
        if (operation === 'prepare' && body.payload.permissionScope !== undefined) requireValue((await getBackendFeatures?.())?.interactiveGrantMatching,
          'backend_upgrade_required', 'Upgrade the backend before requesting scope-aware interactive permission. An older matcher may reuse an insufficient grant.', 409);
        const command = { key, action: `interactive.${operation === 'prepare' ? 'request' : operation}`,
          payload: { ...body.payload, ...(inheritedModel ? { model: inheritedModel } : {}), requesterAgentId: worker.agentId, sourceConversationId: worker.sessionId, sourceBindingRevision: worker.bindingRevision } };
        journal.queue(command);
        if (operation === 'dispatch' && previous?.error === 'identity_conflict' && ['conflict', 'superseded'].includes(previous.state))
          await reconcileDispatchIdentity(journal, api, worker, command, await getBackendFeatures?.());
        try { await journal.flush(api); }
        catch (error) {
          const item = journal.receipt(key);
          if (operation !== 'dispatch' || item?.state !== 'conflict' || !refusedDispatchErrors.has(item.error)) throw error;
          journal.reconcileRefusedDispatch(command, { reason: 'Backend refused this exact dispatch without applying changes. Inspect the saved task, preparation and execution; do not create duplicates.' });
        }
        const item = journal.receipt(key);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(operation === 'dispatch' ? dispatchReceipt(item) : item)); return;
      }
      if (path === '/agent/status') {
        requireValue(Object.keys(body).length === 0, 'invalid_request', 'Status takes no overrides');
        const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`receiver:${worker.agentId}`);
        const receiver = row ? { ...JSON.parse(row.value), ...(journal.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`agent-deleted:${worker.agentId}`) ? { state: 'deleted' } : {}) } : null;
        const enrolment = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`enrolment:${worker.agentId}`);
        const node = journal.cached('node').find(entry => entry.entity.id === journal.nodeId)?.entity;
        const works = journal.openWorkForAgent(worker.agentId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentId: worker.agentId, agentName: enrolment ? JSON.parse(enrolment.value).name : null,
          nodeId: journal.nodeId, nodeName: node?.name ?? null, sessionId: worker.sessionId, receiver,
          receivingHere: receiver?.state === 'active' && receiver.bindingId === worker.bindingId,
          obligations: works.map(w => ({ id: w.id, state: w.execution.state, localState: w.state, conversationId: w.nativeConversationId,
            observation: w.observation ?? null, recovery: w.recovery ?? null })) })); return;
      }
      if (path === '/agent/owner-message') {
        requireValue(!worker.headlessSetupId, 'headless_execution_inactive', 'Headless messages require their exact accepted run', 403);
        currentReceiver();
        const result = await ownerMessage(body);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/message-send') {
        currentReceiver();
        requireValue(api && Object.keys(body).every(k => ['key', 'recipientAgentId', 'kind', 'subject', 'body', 'replyPolicy', 'replyToMessageId'].includes(k)) &&
          typeof body.key === 'string' && body.key.trim() && body.key.length <= 100 && typeof body.recipientAgentId === 'string' &&
          typeof body.body === 'string', 'invalid_request', 'Immutable key, exact recipient and message body required');
        const incoming = journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain')").all()
          .map(row => JSON.parse(row.data)).find(n => n.kind === 'message' && n.bindingId === worker.bindingId);
        requireValue(!incoming || typeof body.replyToMessageId === 'string' && body.replyToMessageId === incoming.messageId,
          'message_reply_not_authorised', 'An incoming informational message does not authorise automatic replies or message chains', 403);
        const supportsReplies = (await getBackendFeatures?.())?.agentMessageReplies === true;
        requireValue(supportsReplies || !body.replyToMessageId && body.replyPolicy !== 'once', 'backend_upgrade_required', 'Backend must be upgraded before reply envelopes can be used');
        const { key, replyPolicy, replyToMessageId, ...payload } = body;
        const command = { key: `message-send:${worker.agentId}:${key}`, action: 'message.send', payload: {
          ...payload, ...(supportsReplies ? { replyPolicy: replyToMessageId ? 'none' : replyPolicy ?? 'once', ...(replyToMessageId ? { replyToMessageId } : {}) } : {}),
          id: `message_${digest([worker.agentId, key])}`, senderAgentId: worker.agentId,
          sourceConversationId: worker.sessionId, sourceBindingRevision: worker.bindingRevision,
        } };
        journal.queue(command); await journal.flush(api);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(journal.receipt(command.key))); return;
      }
      if (path === '/agent/messages' || path === '/agent/message') {
        currentReceiver();
        requireValue(api, 'backend_unavailable', 'Message backend unavailable', 503);
        const inspect = path === '/agent/message';
        requireValue(Object.keys(body).every(k => (inspect ? ['id'] : ['direction', 'cursor', 'limit']).includes(k)) &&
          (!inspect || typeof body.id === 'string' && body.id), 'invalid_request', 'Only exact message ID or bounded inbox/sent pagination is supported');
        const result = inspect ? await api('GET', `/v1/messages/${encodeURIComponent(body.id)}`) :
          await api('GET', `/v1/messages?${new URLSearchParams({ agentId: worker.agentId, ...body })}`);
        if (inspect) requireValue([result.sender.agentId, result.recipient.agentId].includes(worker.agentId), 'forbidden', 'Message belongs to different agents', 403);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/schedules') {
        requireValue(Object.keys(body).length === 0, 'invalid_request', 'Schedule lookup takes no overrides');
        const items = journal.db.prepare('SELECT data FROM schedules ORDER BY id').all().map(row => JSON.parse(row.data))
          .filter(s => s.definition.targetAgentId === worker.agentId && !s.definition.targetConversationId);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items, complete: true, scope: 'locally_installed_agent_schedules' })); return;
      }
      if (['/agent/schedule-install', '/agent/schedule-pause', '/agent/schedule-resume', '/agent/schedule-cancel', '/agent/schedule-result-notifications'].includes(path)) {
        currentReceiver();
        requireValue(api && Object.keys(body).every(k => ['key', 'payload'].includes(k)) && typeof body.key === 'string' && body.key.trim() && body.payload,
          'invalid_request', 'Stable operation key and exact schedule payload required');
        const operation = path.slice('/agent/schedule-'.length).replaceAll('-', '_');
        const payload = structuredClone(body.payload);
        if (operation === 'result_notifications') requireValue(payload && typeof payload === 'object' && !Array.isArray(payload) &&
          Object.keys(payload).every(key => ['id', 'expectedRevision', 'runResultNotifications'].includes(key)) && Object.hasOwn(payload, 'runResultNotifications') &&
          typeof payload.id === 'string' && payload.id.trim() && payload.id.length <= 256 && Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision > 0,
        'invalid_request', 'Run result settings require only payload.id, positive payload.expectedRevision and payload.runResultNotifications');
        if (operation === 'result_notifications' || payload.definition?.runResultNotifications !== undefined) {
          runResultNotifications(operation === 'result_notifications' ? payload.runResultNotifications : payload.definition.runResultNotifications);
          requireValue((await getBackendFeatures?.())?.runResultNotifications, 'backend_upgrade_required', 'Backend must support run result notifications');
        }
        if (operation === 'install') {
          requireValue(payload.definition && !payload.definition.nodeId && !payload.definition.targetAgentId &&
            !payload.definition.targetFolder && !payload.definition.targetConversationId, 'forbidden', 'Persistent schedules target only this agent', 403);
          payload.definition = { ...payload.definition, nodeId: journal.nodeId, targetAgentId: worker.agentId };
        }
        const command = { key: `agent-schedule:${worker.agentId}:${body.key}`, action: `agent.schedule_${operation}`,
          payload: { agentId: worker.agentId, conversationId: worker.sessionId, bindingRevision: worker.bindingRevision, payload } };
        journal.queue(command); await journal.flush(api);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(journal.receipt(command.key))); return;
      }
      if (path === '/agent/notifications') {
        requireValue(Object.keys(body).length === 0, 'invalid_request', 'No notification scope override supported');
        const items = journal.db.prepare('SELECT data FROM local_notifications ORDER BY id').all().map(row => JSON.parse(row.data));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items, complete: true })); return;
      }
      if (['/agent/tasks', '/agent/agents'].includes(path)) {
        requireValue((path.endsWith('tasks') ? tasks : api) && Object.keys(body).every(key => ['cursor', 'limit'].includes(key)), 'invalid_request', 'Only pagination fields are supported');
        const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
        let result;
        try { result = path.endsWith('tasks') ? await tasks.listTasks(body) : await api('GET', `/v1/agents?${query}`); }
        catch (error) {
          if (error.status && error.status < 500) throw error;
          const limit = body.limit ?? 100;
          requireValue(Number.isInteger(limit) && limit > 0 && limit <= 500, 'invalid_query', 'Bounded cache limit required');
          result = { items: journal.cached(path.endsWith('tasks') ? 'task' : 'agent').slice(0, limit).map(item => ({ ...item.entity, fetchedAt: item.fetchedAt })),
            complete: false, nextCursor: null, stale: true, warnings: ['Backend unavailable. Local event cache is incomplete, bounded and not current.'] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/agent/task-identity') {
        requireValue(tasks?.resolveTaskIdentity && body && Object.keys(body).every(key => ['value', 'reference', 'scope'].includes(key)),
          'unsupported_operation', 'Selected Tasks provider must support exact native task identity lookup');
        const result = await tasks.resolveTaskIdentity(body);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (['/agent/task', '/agent/comments', '/agent/relations'].includes(path)) {
        requireValue(tasks && typeof body.taskId === 'string' && body.taskId && Object.keys(body).every(key =>
          (path === '/agent/comments' ? ['taskId', 'cursor', 'limit'] : ['taskId']).includes(key)),
        'invalid_request', 'Exact task ID and supported pagination required');
        const operation = path === '/agent/task' ? 'getTask' : path === '/agent/comments' ? 'listComments' : 'listRelations';
        requireValue(typeof tasks[operation] === 'function', 'unsupported_operation', 'Selected Tasks provider does not support this read');
        const { taskId, ...query } = body;
        const result = await tasks[operation](taskId, query);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      if (path === '/work/current') {
        requireValue(typeof worker.sessionId === 'string' && body.sessionId === worker.sessionId && Object.keys(body).length === 1,
          'forbidden', 'Exact enrolled native session required', 403);
        const accepted = () => journal.openWorkForAgent(worker.agentId).filter(work => ownsWork(work) && work.execution.state === 'accepted');
        if (resolveBinding) for (const work of accepted()) {
          const binding = await resolveBinding(worker.agentId, work);
          if (binding) await reconcileInteractiveWork(journal, binding, work);
        }
        const matching = accepted();
        const candidates = matching.filter(work =>
          ['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) && work.execution.state === 'accepted');
        const conflicts = matching.filter(work => work.state === 'conflict');
        const current = matching.length !== 1 ? null : candidates.length === 1 ? candidates[0] : candidates.length === 0 && conflicts.length === 1 ? conflicts[0] : null;
        requireValue(current, 'work_ambiguous', matching.length ? 'Multiple or non-running execution records require inspection' :
          'No active execution in this chat. Enrolment and schedule ownership do not themselves start a worker run', 409);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ execution: current.execution, answer: current.answer ?? null, localState: current.state, sourceMessageId: current.invocation?.messageId ?? null,
          blocked: current.state === 'conflict', observation: current.observation ?? null, recovery: current.recovery ?? null,
          inputRevision: current.interaction?.revision ?? null, interaction: current.interaction ?? null })); return;
      }
      if (path === '/work/children') {
        const parent = journal.work(body.executionId);
        requireValue(api && ownsWork(parent) && parent.execution.runId === body.runId,
          'forbidden', 'Exact parent execution required', 403);
        const items = [];
        let cursor;
        do {
          const page = await api('GET', `/v1/executions?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`);
          items.push(...page.items.filter(item => item.parentExecutionId === parent.id)); cursor = page.nextCursor;
        } while (cursor);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items, complete: true })); return;
      }
      if (['/agent/questions', '/agent/answer', '/agent/forward'].includes(path)) {
        requireValue(api, 'backend_unavailable', 'Agent interaction connector unavailable', 503);
        let result;
        if (path === '/agent/questions') {
          requireValue(Object.keys(body).length === 0, 'invalid_request', 'Question inbox takes no overrides');
          const items = [];
          let cursor;
          do {
            const query = new URLSearchParams({ status: 'open', limit: '100', ...(cursor ? { cursor } : {}) });
            const page = await api('GET', `/v1/questions?${query}`);
            items.push(...page.items.filter(q => q.addressedTo.type === 'agent' && q.addressedTo.id === worker.agentId));
            cursor = page.nextCursor;
          } while (cursor);
          result = { items, complete: true };
        } else {
          if (worker.bindingId) {
            const addressedNotice = journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain')").all()
              .map(row => JSON.parse(row.data)).some(n => n.bindingId === worker.bindingId && n.questionId === body.id);
            if (!addressedNotice) currentReceiver();
          }
          requireValue(Object.keys(body).every(key => ['id', 'expectedRevision', 'key', 'body', 'reason'].includes(key)) &&
            typeof body.id === 'string' && body.id && typeof body.key === 'string', 'invalid_request', 'Exact question, revision and key required');
          const action = path === '/agent/answer' ? 'question.answer' : 'question.forward';
          const payload = { id: body.id, expectedRevision: body.expectedRevision, agentId: worker.agentId,
            ...(action === 'question.answer' ? { body: body.body } : { reason: body.reason }) };
          const command = { key: `agent:${worker.agentId}:${body.key}`, action, payload };
          journal.queue(command); await journal.flush(api);
          result = journal.receipt(command.key);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      requireValue(path.startsWith('/work/'), 'not_found', 'Unknown node route', 404);
      const work = path === '/work/native-api' ? await verifyExecutionScope(body) : await lookupWork(body, { read: path === '/work/read' });
      let result;
      if (path === '/work/native-api') {
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'sourceMessageId', 'inputRevision', 'request'].includes(key)),
        'execution_source_required', 'Native CLI requires this exact active interactive execution, not a human operator context', 403);
        const request = body.request;
        requireValue(request && Object.keys(request).every(key => ['method', 'path', 'body'].includes(key)) &&
          typeof request.path === 'string' && request.path.startsWith('/v1/'), 'invalid_request', 'Bounded native API request required');
        const target = new URL(request.path, 'http://relay');
        requireValue(target.origin === 'http://relay' && !target.hash && !request.path.includes('\\'), 'invalid_request', 'Native API path required');
        const scopedKey = key => `execution-cli:${digest([work.id, body.runId, key])}`;
        if (request.method === 'GET') {
          const key = executionAttachmentReceiptKey(target, request);
          if (key === undefined) result = await nativeReadApi(api, request, worker, { taskId: work.execution.taskId ?? null });
          else {
            const scoped = scopedKey(key);
            result = journal.receipt(scoped)?.state === 'recorded' ? { state: 'recorded' }
              : await api('GET', attachmentReceiptPath(scoped));
          }
        } else {
          requireValue(request.method === 'POST' && request.path === '/v1/commands' && request.body &&
            Object.keys(request.body).every(key => ['key', 'action', 'payload'].includes(key)), 'forbidden', 'Native execution mutation required', 403);
          const command = request.body, p = command.payload;
          requireValue(typeof command.key === 'string' && command.key.trim() && command.key.length <= 128 && p &&
            (command.action === 'comment.create' && p.taskId === work.execution.taskId ||
              command.action === 'task.attach' && p.taskId === work.execution.taskId && !work.execution.monitor && !work.execution.localOccurrence ||
              command.action === 'task.update' && p.id === work.execution.taskId || command.action === 'execution.progress' && p.id === work.id),
          'execution_cli_scope', 'Execution CLI may comment on, update or attach to its assigned task, or report its own progress. Task creation, dispatch and administration require separate authority', 403);
          checkMaintenance();
          const key = scopedKey(command.key);
          try { journal.queue({ ...command, key }); }
          catch (error) {
            if (command.action === 'task.attach' && error.code === 'operation_conflict') throw new RelayError(error.code, error.message, 409);
            throw error;
          }
          try { await journal.flush(api); } catch (error) {
            const receipt = journal.receipt(key);
            if (receipt?.state === 'conflict') {
              journal.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run('superseded', JSON.stringify({ ...receipt,
                state: 'superseded', outcome: 'refused', applied: false }), key);
            }
            throw error;
          }
          const receipt = journal.receipt(key);
          requireValue(receipt?.state === 'recorded', 'publication_pending', 'Reconcile the original execution CLI key', 503);
          result = receipt.receipt;
        }
      }
      else if (path === '/work/owner-message') {
        requireValue(api && worker.headlessSetupId && work.execution.state === 'accepted' && !work.execution.cancellationRequested && !work.staged &&
          ['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) &&
          Object.keys(body).every(key => ['executionId', 'runId', 'inputRevision', 'key', 'payload'].includes(key)) && body.payload &&
          Object.keys(body.payload).every(key => ['subject', 'body'].includes(key)),
        'headless_execution_inactive', 'Exact active, unstaged headless execution required', 403);
        const authority = await api('POST', '/v1/headless/read', { operation: 'permissions', executionId: work.id, runId: body.runId });
        requireValue(authority.id === worker.headlessSetupId && authority.sessionId === worker.sessionId && !authority.readiness,
          'headless_probe_forbidden', 'Readiness cannot send real owner messages', 403);
        const current = await api('GET', `/v1/headless_setups/${worker.headlessSetupId}/authority`);
        checkContract(current.setup, current.grant);
        result = await ownerMessage({ ...body.payload, key: body.key }, work);
      }
      else if (path === '/work/read') result = { execution: work.execution, localState: work.state, inputRevision: work.interaction?.revision ?? null,
        answer: work.answer ?? null, cancellationRequested: work.execution.cancellationRequested };
      else if (['/work/headless-access', '/work/headless-scope'].includes(path)) {
        const inspection = path === '/work/headless-scope';
        requireValue(api && worker.headlessSetupId && work.execution.state === 'accepted' && !work.execution.cancellationRequested &&
          Object.keys(body).every(key => ['executionId', 'runId', ...(inspection ? ['payload'] : [])].includes(key)),
          'headless_execution_inactive', 'Exact active headless tool scope required', 403);
        if (inspection) requireValue(body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) && Object.keys(body.payload).length === 0,
          'invalid_headless_request', 'Scope inspection takes no overrides');
        const result = await api('POST', '/v1/headless/read', { operation: 'permissions', executionId: work.id, runId: body.runId });
        requireValue(result.id === worker.headlessSetupId && result.sessionId === worker.sessionId, 'headless_scope_mismatch', 'Connector grant belongs to another worker', 403);
        const authority = await api('GET', `/v1/headless_setups/${worker.headlessSetupId}/authority`);
        const contract = checkContract(authority.setup, authority.grant);
        // Inspection is available to every headless grant. Empty native task/file
        // capabilities do not negate its separately approved shell/MCP permission.
        if (inspection && result.capabilities) journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(`headless-authority:${work.id}:${body.runId}`, JSON.stringify({ id: result.id, directory: result.directory,
            profile: result.capabilities, readiness: result.readiness }));
        const response = inspection ? { permissions: result.permissions, sourceNamespaces: result.capabilities?.sourceNamespaces ?? [],
          taskActions: result.capabilities?.taskActions ?? [], artifacts: result.capabilities?.artifacts ?? null } :
          { ...result, ...contract, outcomeStaged: Boolean(work.staged) };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response)); return;
      }
      else if (['/work/headless-task', '/work/headless-reference', '/work/headless-artifacts', '/work/headless-observation', '/work/headless-capabilities'].includes(path)) {
        requireValue(api && worker.headlessSetupId && work.execution.state === 'accepted' && !work.execution.cancellationRequested && !work.staged &&
          Object.keys(body).every(k => ['executionId', 'runId', 'key', 'payload'].includes(k)) && body.payload && typeof body.payload === 'object',
        'headless_execution_inactive', 'Exact active headless execution and capability payload required', 403);
        const scopeKey = `headless-authority:${work.id}:${body.runId}`;
        let scope, offline = false;
        try {
          scope = await api('POST', '/v1/headless/read', { operation: 'access', executionId: work.id, runId: body.runId });
          journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(scopeKey, JSON.stringify(scope));
        } catch (error) {
          const cached = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(scopeKey);
          const auditOnly = path === '/work/headless-observation' || path === '/work/headless-artifacts' && body.payload.operation === 'receipt' && ['pending', 'uncertain'].includes(body.payload.status);
          requireValue(auditOnly && cached && (!error.status || error.status >= 500), error.code ?? 'headless_authority_unavailable', 'Fresh authorisation required; only uncertain audit records can use cached scope offline');
          scope = JSON.parse(cached.value); offline = true;
        }
        if (path === '/work/headless-task') {
          requireValue(typeof body.key === 'string' && body.key === body.payload.key, 'invalid_headless_request', 'Exact stable mutation key required');
          validateHeadlessTaskPayload(body.payload.operation, body.payload.payload);
          const command = { key: `headless-transport:${digest([work.id, body.runId, body.payload.source, body.payload.operation, body.key])}`, action: 'headless.task',
            payload: { executionId: work.id, runId: body.runId, ...body.payload } };
          requireValue(!Object.hasOwn(body.payload, 'executionId') && !Object.hasOwn(body.payload, 'runId'), 'invalid_headless_request', 'Worker cannot override execution scope');
          journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`headless-task-intent:${command.key}`, JSON.stringify({ setupId: scope.id, commandKey: command.key }));
          journal.queue(command);
          try { await journal.flush(api); }
          catch (error) {
            const refused = journal.receipt(command.key);
            if (refused?.state === 'refused' && refused.applied === false) {
              res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(refused)); return;
            }
            if (refused?.state === 'conflict' && refused.inspectionRequired === true) {
              res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...refused,
                message: 'Revision conflict requires inspection. This command did not apply; its original key and payload are retained.' })); return;
            }
            const definitive = ['stale_revision', 'headless_task_busy', 'headless_task_forbidden', 'headless_operation_forbidden', 'reference_conflict', 'task_blocked', 'execution_unsettled', 'acceptance_required'];
            if (refused?.state !== 'conflict' || !definitive.includes(refused.error)) throw error;
            // These transaction refusals prove no mutation committed. Retain the
            // command/error as a refusal, not an unresolved or applied operation.
            const retained = { ...refused, state: 'superseded', outcome: 'refused', applied: false, effectsUncertain: false, refusalKind: 'transactional_policy' };
            journal.db.prepare('UPDATE outbox SET state=?,data=? WHERE key=?').run('superseded', JSON.stringify(retained), command.key);
          }
          result = journal.receipt(command.key);
          if (result?.outcome === 'refused') result = { ...result, state: 'refused' };
          if (result?.state === 'recorded') journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`headless-task-proof:${scope.id}:${result.receipt.id}`, JSON.stringify(result.receipt));
        } else if (path === '/work/headless-reference') {
          requireValue(!Object.hasOwn(body.payload, 'executionId') && !Object.hasOwn(body.payload, 'runId'), 'invalid_headless_request', 'No scope overrides permitted');
          result = await api('POST', '/v1/headless/read', { ...body.payload, operation: 'references', executionId: work.id, runId: body.runId });
        } else if (path === '/work/headless-artifacts') {
          requireValue(!scope.readiness || ['inventory', 'read', 'state'].includes(body.payload.operation), 'headless_probe_forbidden', 'Readiness cannot mutate real job artifacts or checkpoints');
          result = { ...headlessArtifactOperation(journal, scope, work, body.payload), ...(offline ? { authorisation: 'cached_uncertain_audit_only' } : {}) };
        } else if (path === '/work/headless-observation') result = recordHeadlessObservation(journal, scope, work, body.payload);
        else {
          requireValue(Object.keys(body.payload).length === 0, 'invalid_headless_request', 'Capability canary takes no overrides');
          const authority = await api('GET', `/v1/headless_setups/${worker.headlessSetupId}/authority`);
          requireValue(work.id === headlessProbeId(authority.setup), 'headless_probe_forbidden', 'Only readiness execution can run capability canaries');
          const key = `headless-capability:${digest([work.id, body.runId])}`;
          journal.queue({ key, action: 'headless.capability_probe', payload: { executionId: work.id, runId: body.runId } }); await journal.flush(api);
          const taskProof = journal.receipt(key);
          requireValue(taskProof?.state === 'recorded' && taskProof.receipt.capabilityProbe, 'headless_probe_failed', 'Backend task canary is not confirmed');
          const files = probeHeadlessArtifacts(journal, scope, work), task = taskProof.receipt.capabilityProbe;
          result = { task, files, digest: digest({ task: task.digest, files: files.digest }), businessCoverageVerified: false };
          journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`headless-capability-proof:${work.id}:${body.runId}`, JSON.stringify(result));
        }
      }
      else if (path === '/work/delegate') {
        requireValue(api && work.execution.allowDelegation && work.execution.state === 'accepted' && !work.execution.cancellationRequested &&
          !work.staged, 'delegation_not_authorised', 'Current execution needs an explicit delegation grant', 403);
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'inputRevision', 'key', 'payload'].includes(key)) && body.payload &&
          typeof body.key === 'string' && body.key.trim() &&
          Object.keys(body.payload).every(key => ['taskId', 'id', 'title', 'instructions', 'targetAgentId', 'reviewPolicy', 'reviewGrantId'].includes(key)),
        'invalid_request', 'Unsupported delegation fields');
        const command = { key: `delegate:${worker.agentId}:${body.key}`, action: 'execution.delegate', payload: {
          ...body.payload, parentExecutionId: work.id, expectedRevision: work.execution.revision,
        } };
        journal.queue(command); await journal.flush(api); result = journal.receipt(command.key);
      }
      else if (path === '/work/review-child') {
        requireValue(api && work.execution.state === 'accepted' && !work.execution.cancellationRequested && body.payload,
          'review_not_authorised', 'Current parent execution required', 403);
        requireValue(Object.keys(body.payload).every(key => ['id', 'expectedRevision', 'candidate', 'decision', 'reason'].includes(key)) &&
          typeof body.key === 'string' && body.key, 'invalid_request', 'Exact candidate decision required');
        const command = { key: `agent-review:${worker.agentId}:${body.key}`, action: 'execution.agent_review',
          payload: { ...body.payload, reviewerExecutionId: work.id, reviewerRunId: work.execution.runId } };
        journal.queue(command); await journal.flush(api); result = journal.receipt(command.key);
      }
      else if (['/work/ask', '/work/submit', '/work/wait-children', '/work/delay'].includes(path)) {
        requireValue(['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) &&
          !work.execution.cancellationRequested && work.execution.state === 'accepted', 'execution_inactive', 'Current worker turn required');
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'inputRevision', 'key', 'payload'].includes(key)) &&
          typeof body.key === 'string' && body.key.length > 0 && body.payload && typeof body.payload === 'object', 'invalid_request', 'Key and payload required');
        let kind = path === '/work/ask' ? 'question' : path === '/work/wait-children' ? 'children' : path === '/work/delay' ? 'delay' : 'result';
        requireValue(!work.execution.localOccurrence || ['result', 'question'].includes(kind), 'unsupported_operation', 'Scheduled work supports questions/results only');
        const allowed = kind === 'question' ? ['prompt', 'humanRequired'] : kind === 'children' ? ['childExecutionIds'] : kind === 'delay' ? ['until', 'reason'] : ['candidate', 'summary'];
        requireValue(Object.keys(body.payload).every(key => allowed.includes(key)) && (kind === 'delay' ?
          Number.isFinite(Date.parse(body.payload.until)) && typeof body.payload.reason === 'string' && body.payload.reason.trim() : kind === 'children' ?
          Array.isArray(body.payload.childExecutionIds) && body.payload.childExecutionIds.length > 0 && body.payload.childExecutionIds.length <= 64 &&
          body.payload.childExecutionIds.every(id => typeof id === 'string' && id.length > 0) : kind === 'question' ?
          typeof body.payload.prompt === 'string' && body.payload.prompt.trim() && body.payload.prompt.length <= 4000 &&
          (body.payload.humanRequired === undefined || typeof body.payload.humanRequired === 'boolean') :
          typeof body.payload.candidate === 'string' && body.payload.candidate.trim() && body.payload.candidate.length <= 512 &&
          typeof body.payload.summary === 'string' && body.payload.summary.trim() && body.payload.summary.length <= 16000),
        'invalid_request', 'Invalid worker outcome');
        if (kind === 'result' && work.execution.monitor) kind = 'monitor_result';
        const staged = { kind, key: body.key, payload: body.payload, runId: body.runId,
          ...(work.interaction ? { inputRevision: work.interaction.revision, anchorId: work.interaction.anchorId } : {}) };
        journal.transaction(() => {
          const current = journal.work(work.id);
          requireValue(!current.staged || canonical(current.staged) === canonical(staged), 'operation_conflict', 'Worker outcome already recorded');
          journal.save({ ...current, staged });
        });
        result = { state: 'staged', nativeSettlementRequired: true, instruction: 'Finish this native turn without further work.' };
      } else throw new RelayError('not_found', 'Unknown worker route', 404);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) {
      if (res.destroyed || res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      if (req.method === 'PUT' && !req.complete) res.setHeader('Connection', 'close');
      res.writeHead(error instanceof RelayError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: error.code ?? 'node_error', message: error instanceof RelayError ? error.message : 'Node request failed' }));
    }
  };
  const server = createServer(handle);
  server.on('checkContinue', handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  let closing;
  return { close: () => closing ??= new Promise(resolve => {
    server.close(() => { if (existsSync(socketPath)) unlinkSync(socketPath); resolve(); }); server.closeIdleConnections();
  }) };
}
