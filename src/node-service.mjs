import { createServer } from 'node:http';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { digest, requireValue, RelayError, canonical } from './protocol.mjs';
import { nativeTasksProvider } from './tasks-provider.mjs';

// Worker credentials are exact agent scopes. They confer neither owner backend
// access nor authority over a different node's execution.
export async function startNodeService({ journal, socketPath, workers, api, tasks, getNativeModel, maintenance = () => false }) {
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
        '/agent/status', '/agent/schedules', '/agent/notifications', '/agent/tasks', '/agent/agents', '/agent/task', '/agent/comments', '/agent/relations',
        '/agent/questions', '/agent/messages', '/agent/message'];
      requireValue(!maintenance() || readOnly.includes(path), 'maintenance', 'Node upgrade maintenance is active. Retry the same immutable operation afterwards', 503);
      const currentReceiver = () => {
        requireValue(worker.bindingId && worker.bindingRevision, 'standing_enrolment_required', 'Stable agent enrolment required', 403);
        journal.assertReceiver({ id: worker.bindingId, agentId: worker.agentId, receiverGeneration: worker.bindingRevision });
      };
      const ownsWork = work => work?.execution.targetAgentId === worker.agentId &&
        (!worker.sessionId || !work.nativeConversationId || work.nativeConversationId === worker.sessionId) &&
        (!worker.bindingId || work.bindingId === worker.bindingId);
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
      if (path === '/agent/interactive-status') {
        requireValue(api && Object.keys(body).length === 1 && typeof body.id === 'string', 'invalid_request', 'Exact preparation ID required');
        const request = await api('GET', `/v1/provision_requests/${encodeURIComponent(body.id)}`);
        requireValue(request.requesterAgentId === worker.agentId, 'forbidden', 'Only the initiating agent may inspect this request', 403);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(request)); return;
      }
      if (['/agent/interactive-prepare', '/agent/interactive-dispatch', '/agent/interactive-cancel'].includes(path)) {
        currentReceiver();
        requireValue(api && Object.keys(body).every(k => ['key', 'payload'].includes(k)) && typeof body.key === 'string' &&
          body.key.trim() && body.key.length <= 100 && body.payload, 'invalid_request', 'Immutable key and bounded provisioning payload required');
        requireValue(!journal.works().some(w => ownsWork(w) && !['completed', 'cancelled', 'failed', 'rejected', 'in_review'].includes(w.execution.state)),
          'interactive_human_context_required', 'Scheduled and delegated executions cannot create agents through the human-chat route', 403);
        const operation = path.slice('/agent/interactive-'.length);
        const allowed = operation === 'prepare' ? ['id', 'grantId', 'nodeId', 'directory', 'agentId', 'name', 'createDirectory', 'instance', 'profile', 'topic'] :
          operation === 'dispatch' ? ['id', 'taskId', 'executionId', 'title', 'instructions'] : ['id', 'expectedRevision', 'reason'];
        requireValue(Object.keys(body.payload).every(k => allowed.includes(k)), 'invalid_request', 'Caller cannot override its provisioning identity');
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
        const works = journal.works().filter(w => w.execution.targetAgentId === worker.agentId &&
          !['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentId: worker.agentId, sessionId: worker.sessionId, receiver,
          receivingHere: receiver?.state === 'active' && receiver.bindingId === worker.bindingId,
          obligations: works.map(w => ({ id: w.id, state: w.execution.state, conversationId: w.nativeConversationId,
            recovery: w.recovery ?? null })) })); return;
      }
      if (path === '/agent/message-send') {
        currentReceiver();
        requireValue(api && Object.keys(body).every(k => ['key', 'recipientAgentId', 'kind', 'subject', 'body'].includes(k)) &&
          typeof body.key === 'string' && body.key.trim() && body.key.length <= 100 && typeof body.recipientAgentId === 'string' &&
          typeof body.body === 'string', 'invalid_request', 'Immutable key, exact recipient and message body required');
        requireValue(!journal.db.prepare("SELECT data FROM notices WHERE state IN ('observing','uncertain')").all()
          .some(row => { const n = JSON.parse(row.data); return n.kind === 'message' && n.bindingId === worker.bindingId; }),
          'message_reply_not_authorised', 'An incoming informational message does not authorise automatic replies or message chains', 403);
        const { key, ...payload } = body;
        const command = { key: `message-send:${worker.agentId}:${key}`, action: 'message.send', payload: {
          ...payload, id: `message_${digest([worker.agentId, key])}`, senderAgentId: worker.agentId,
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
