import { createServer } from 'node:http';
import { chmodSync, existsSync, unlinkSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { headlessArtifactOperation, recordHeadlessObservation, probeHeadlessArtifacts } from './headless-artifacts.mjs';
import { headlessProbeId } from './headless-setup-contract.mjs';
import { digest, requireValue, RelayError, canonical } from './protocol.mjs';
import { nativeTasksProvider } from './tasks-provider.mjs';
import { herdrInventory } from './node-discovery.mjs';

// Worker credentials are exact agent scopes. They confer neither owner backend
// access nor authority over a different node's execution.
export async function startNodeService({ journal, socketPath, workers, api, tasks, getNativeModel, getHeadlessConnections, getHeadlessAccess, getBackendFeatures, maintenance = () => false }) {
  tasks ??= api ? { ...nativeTasksProvider(api), type: 'native' } : null;
  requireValue(!existsSync(socketPath), 'socket_exists', 'Node socket already exists. Verify the old service before removing it');
  const server = createServer(async (req, res) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const worker = workers.find(item => digest(item.token) === digest(token));
      requireValue(worker && token, 'unauthorised', 'Worker credential required', 401);
      requireValue(req.method === 'POST', 'invalid_request', 'POST required');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length; requireValue(size <= 128 * 1024, 'request_too_large', 'Request too large', 413); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { throw new RelayError('invalid_json', 'JSON request required'); }
      requireValue(body && typeof body === 'object' && !Array.isArray(body), 'invalid_request', 'Object required');
      const path = new URL(req.url, 'http://node').pathname;
      const readOnly = ['/work/current', '/work/read', '/work/children', '/agent/interactive-context', '/agent/interactive-grants', '/agent/interactive-status',
        '/agent/status', '/agent/schedules', '/agent/notifications', '/agent/tasks', '/agent/agents', '/agent/task', '/agent/task-identity', '/agent/comments', '/agent/relations',
        '/agent/questions', '/agent/messages', '/agent/message', '/agent/headless-status', '/agent/headless-grants', '/agent/headless-access', '/agent/headless-connections'];
      requireValue(!maintenance() || readOnly.includes(path), 'maintenance', 'Node upgrade maintenance is active. Retry the same immutable operation afterwards', 503);
      const currentReceiver = () => {
        requireValue(worker.bindingId && worker.bindingRevision, 'standing_enrolment_required', 'Stable agent enrolment required', 403);
        journal.assertReceiver({ id: worker.bindingId, agentId: worker.agentId, receiverGeneration: worker.bindingRevision });
      };
      const ownsWork = work => work?.execution.targetAgentId === worker.agentId &&
        (!worker.sessionId || !work.nativeConversationId || work.nativeConversationId === worker.sessionId) &&
        (!worker.bindingId || work.bindingId === worker.bindingId);
      const checkContract = (setup, grant) => {
        const op = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`headless-op:${setup.id}`);
        if (!op) return;
        const path = join(setup.directory, grant.contract);
        requireValue(existsSync(path) && JSON.parse(op.value).contractDigest === digest(readFileSync(path, 'utf8')),
          'job_contract_changed', 'The authorised job contract changed; reauthorisation required');
      };
      if (path === '/agent/headless-access') {
        requireValue(api && worker.headlessSetupId && Object.keys(body).length === 0, 'headless_grant_required', 'Exact headless worker scope required', 403);
        const result = await api('GET', `/v1/headless_setups/${worker.headlessSetupId}/authority`);
        requireValue(result.setup.agentId === worker.agentId && result.setup.sessionId === worker.sessionId, 'headless_scope_mismatch', 'Headless session scope changed', 403);
        checkContract(result.setup, result.grant);
        const { accessReferences } = await import('../packages/opencode-relay/headless-access.mjs');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(accessReferences(result.grant))); return;
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
          requireValue(Object.keys(body).every(k => ['key', 'grantId', 'retry'].includes(k)) && typeof body.key === 'string' && body.key.trim() && body.key.length <= 100 && typeof body.grantId === 'string' && (body.retry === undefined || typeof body.retry === 'boolean'),
            'invalid_request', 'Stable key and authorised grant ID required');
          requireValue(!journal.works().some(w => ownsWork(w) && !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(w.execution.state)),
            'headless_human_context_required', 'Scheduled/delegated work cannot reuse human-chat setup authority', 403);
          requireValue(!journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain')").all()
            .some(row => { const notice = JSON.parse(row.data); return notice.kind === 'message' && notice.bindingId === worker.bindingId; }),
            'headless_human_context_required', 'Peer messages cannot authorise headless setup', 403);
          const command = { key: `headless-source:${worker.agentId}:${body.key}`, action: 'headless.request', payload: { grantId: body.grantId, ...(body.retry ? { retry: true } : {}),
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
          result = { id: setup.id, agentId: setup.agentId, scheduleId: setup.scheduleId, state: blocker ? setup.state === 'ready' || setup.state === 'blocked' ? 'blocked' : 'waiting_for_access' : setup.state === 'ready' && schedule?.appliedRevision !== schedule?.revision ? 'awaiting_schedule_ack' : setup.state,
            blocker, revision: schedule?.revision ?? null, appliedRevision: schedule?.appliedRevision ?? null,
            nextFiring: !blocker && installed?.state === 'active' ? installed.nextAt : null, runtime: 'shared-auth-headless', restartRequired: false };
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
          }
        }
        const request = await api('GET', `/v1/provision_requests/${encodeURIComponent(body.id)}`);
        requireValue(request.requesterAgentId === worker.agentId, 'forbidden', 'Only the initiating agent may inspect this request', 403);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(request)); return;
      }
      if (['/agent/interactive-prepare', '/agent/interactive-dispatch', '/agent/interactive-cancel'].includes(path)) {
        currentReceiver();
        requireValue(!worker.headlessSetupId, 'interactive_human_context_required', 'Headless jobs cannot use interactive provisioning', 403);
        requireValue(api && Object.keys(body).every(k => ['key', 'payload'].includes(k)) && typeof body.key === 'string' &&
          body.key.trim() && body.key.length <= 100 && body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload), 'invalid_request', 'Immutable key and bounded provisioning payload required');
        requireValue(path === '/agent/interactive-prepare' || !journal.works().some(w => ownsWork(w) && !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(w.execution.state)),
          'interactive_human_context_required', 'Scheduled and delegated executions cannot create agents through the human-chat route', 403);
        const operation = path.slice('/agent/interactive-'.length);
        const allowed = operation === 'prepare' ? ['id', 'grantId', 'nodeId', 'directory', 'agentId', 'name', 'createDirectory', 'instance', 'profile', 'topic', 'permissionScope'] :
          operation === 'dispatch' ? ['id', 'taskId', 'executionId', 'title', 'instructions'] : ['id', 'expectedRevision', 'reason'];
        requireValue(Object.keys(body.payload).every(k => allowed.includes(k)), 'invalid_request', 'Caller cannot override its provisioning identity');
        if (operation === 'prepare' && !body.payload.grantId) requireValue((await getBackendFeatures?.())?.grantsManagement,
          'backend_upgrade_required', 'Backend must support Grants approval requests');
        const key = `interactive-source:${worker.agentId}:${body.key}`;
        const previous = journal.receipt(key);
        const inheritedModel = operation === 'prepare' ? previous ? previous.command.payload.model : await getNativeModel?.(worker) : undefined;
        const command = { key, action: `interactive.${operation === 'prepare' ? 'request' : operation}`,
          payload: { ...body.payload, ...(inheritedModel ? { model: inheritedModel } : {}), requesterAgentId: worker.agentId, sourceConversationId: worker.sessionId, sourceBindingRevision: worker.bindingRevision } };
        journal.queue(command); await journal.flush(api);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(journal.receipt(command.key))); return;
      }
      if (path === '/agent/status') {
        requireValue(Object.keys(body).length === 0, 'invalid_request', 'Status takes no overrides');
        const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`receiver:${worker.agentId}`);
        const receiver = row ? JSON.parse(row.value) : null;
        const enrolment = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`enrolment:${worker.agentId}`);
        const works = journal.works().filter(w => w.execution.targetAgentId === worker.agentId &&
          !['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentId: worker.agentId, agentName: enrolment ? JSON.parse(enrolment.value).name : null, sessionId: worker.sessionId, receiver,
          receivingHere: receiver?.state === 'active' && receiver.bindingId === worker.bindingId,
          obligations: works.map(w => ({ id: w.id, state: w.execution.state, conversationId: w.nativeConversationId,
            recovery: w.recovery ?? null })) })); return;
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
      if (['/agent/schedule-install', '/agent/schedule-pause', '/agent/schedule-resume', '/agent/schedule-cancel'].includes(path)) {
        currentReceiver();
        requireValue(api && Object.keys(body).every(k => ['key', 'payload'].includes(k)) && typeof body.key === 'string' && body.key.trim() && body.payload,
          'invalid_request', 'Stable operation key and exact schedule payload required');
        const operation = path.slice('/agent/schedule-'.length);
        const payload = structuredClone(body.payload);
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
          if (path.endsWith('tasks') && tasks.type !== 'native') throw error;
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
        const candidates = journal.works().filter(work => ownsWork(work) &&
          ['intent', 'observing', 'uncertain', 'native_finished'].includes(work.state) && work.execution.state === 'accepted');
        requireValue(candidates.length === 1, 'work_ambiguous', 'One active worker execution required', 409);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ execution: candidates[0].execution, answer: candidates[0].answer ?? null })); return;
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
      const work = journal.work(body.executionId);
      requireValue(ownsWork(work) && work.execution.runId === body.runId,
        'forbidden', 'Exact current worker execution required', 403);
      let result;
      if (path === '/work/read') result = { execution: work.execution, localState: work.state,
        answer: work.answer ?? null, cancellationRequested: work.execution.cancellationRequested };
      else if (path === '/work/headless-access') {
        requireValue(api && worker.headlessSetupId && work.execution.state === 'accepted' && !work.execution.cancellationRequested &&
          Object.keys(body).every(key => ['executionId', 'runId'].includes(key)), 'headless_execution_inactive', 'Exact active headless tool scope required', 403);
        const result = await api('POST', '/v1/headless/read', { operation: 'permissions', executionId: work.id, runId: body.runId });
        requireValue(result.id === worker.headlessSetupId && result.sessionId === worker.sessionId, 'headless_scope_mismatch', 'Connector grant belongs to another worker', 403);
        const authority = await api('GET', `/v1/headless_setups/${worker.headlessSetupId}/authority`);
        checkContract(authority.setup, authority.grant);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...result, outcomeStaged: Boolean(work.staged) })); return;
      }
      else if (['/work/headless-task', '/work/headless-reference', '/work/headless-artifacts', '/work/headless-observation', '/work/headless-capabilities', '/work/headless-scope'].includes(path)) {
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
        if (path === '/work/headless-scope') {
          requireValue(Object.keys(body.payload).length === 0, 'invalid_headless_request', 'Capability inspection takes no overrides');
          result = { sourceNamespaces: scope.profile.sourceNamespaces, taskActions: scope.profile.taskActions, artifacts: scope.profile.artifacts ?? null };
        } else if (path === '/work/headless-task') {
          requireValue(typeof body.key === 'string' && body.key === body.payload.key, 'invalid_headless_request', 'Exact stable mutation key required');
          const command = { key: `headless-transport:${digest([work.id, body.runId, body.payload.source, body.payload.operation, body.key])}`, action: 'headless.task',
            payload: { executionId: work.id, runId: body.runId, ...body.payload } };
          requireValue(!Object.hasOwn(body.payload, 'executionId') && !Object.hasOwn(body.payload, 'runId'), 'invalid_headless_request', 'Worker cannot override execution scope');
          journal.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`headless-task-intent:${command.key}`, JSON.stringify({ setupId: scope.id, commandKey: command.key }));
          journal.queue(command);
          try { await journal.flush(api); }
          catch (error) {
            const refused = journal.receipt(command.key);
            const definitive = ['stale_revision', 'headless_task_busy', 'headless_task_forbidden', 'headless_operation_forbidden', 'reference_conflict', 'task_blocked', 'execution_unsettled', 'acceptance_required'];
            if (refused?.state !== 'conflict' || !definitive.includes(refused.error)) throw error;
            // These transaction refusals prove no mutation committed. Retain the
            // command/error as a refusal, not an unresolved or applied operation.
            const retained = { ...refused, state: 'superseded', outcome: 'refused', applied: false };
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
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'key', 'payload'].includes(key)) && body.payload &&
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
        requireValue(Object.keys(body).every(key => ['executionId', 'runId', 'key', 'payload'].includes(key)) &&
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
        const staged = { kind, key: body.key, payload: body.payload, runId: body.runId };
        journal.transaction(() => {
          const current = journal.work(work.id);
          requireValue(!current.staged || canonical(current.staged) === canonical(staged), 'operation_conflict', 'Worker outcome already recorded');
          journal.save({ ...current, staged });
        });
        result = { state: 'staged', nativeSettlementRequired: true, instruction: 'Finish this native turn without further work.' };
      } else throw new RelayError('not_found', 'Unknown worker route', 404);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error instanceof RelayError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: error.code ?? 'node_error', message: error instanceof RelayError ? error.message : 'Node request failed' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  let closing;
  return { close: () => closing ??= new Promise(resolve => {
    server.close(() => { if (existsSync(socketPath)) unlinkSync(socketPath); resolve(); }); server.closeIdleConnections();
  }) };
}
