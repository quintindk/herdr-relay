import { randomBytes } from 'node:crypto';
import { canonical, digest, now, requireValue, text } from './protocol.mjs';
import { taskOrigins } from './task-origin.mjs';

function validOrigin(origin) {
  return origin && typeof origin.bindingId === 'string' && origin.bindingId.trim() &&
    typeof origin.conversationId === 'string' && origin.conversationId.trim() &&
    Number.isSafeInteger(origin.sessionCreatedAt) && origin.sessionCreatedAt > 0;
}

function notifications(store) {
  return store.db.prepare("SELECT data FROM operations WHERE id LIKE 'completion-notification:%' OR id LIKE 'review-notification:%' ORDER BY rowid").all()
    .map(row => JSON.parse(row.data));
}

function owns(bridge, notification) {
  const origin = notification.origin;
  return validOrigin(origin) && origin.bindingId === bridge?.identity?.bindingId &&
    origin.conversationId === bridge.identity.conversationId && origin.sessionCreatedAt === bridge.sessionCreatedAt;
}

function recordedTasks(store) {
  return taskOrigins(store).filter(task =>
    ['id', 'title', 'identifier'].every(key => typeof task.receipt?.[key] === 'string' && task.receipt[key].trim()));
}

function hasRecordedOrigin(tasks, notification) {
  return tasks.some(task => task.request.companyId === notification.companyId && task.receipt.id === notification.taskId &&
    ['bindingId', 'conversationId', 'sessionCreatedAt'].every(key => task.request.origin[key] === notification.origin?.[key]));
}

function pendingReviews(store, tasks = recordedTasks(store)) {
  const runs = store.runs();
  const reviews = [];
  for (const task of tasks) {
    const { companyId, origin: { bindingId, conversationId, sessionCreatedAt } } = task.request;
    const taskId = task.receipt.id;
    const taskRuns = runs.filter(run => run.request.companyId === companyId && run.request.taskId === taskId);
    const run = taskRuns.find(run => run.result);
    if (!run || run.nativeState !== 'settled' ||
      run.settlement?.outcome !== 'completed' || run.publication?.state !== 'recorded' ||
      task.request.body?.assigneeAgentId !== run.request.agentId ||
      (task.receipt.companyId !== undefined && task.receipt.companyId !== companyId) ||
      typeof run.result.candidate !== 'string' || !run.result.candidate.trim() || typeof run.result.summary !== 'string' ||
      run.review?.status !== 'pending' || run.review.candidate !== run.result.candidate ||
      typeof run.review.interactionId !== 'string' || !run.review.interactionId.trim()) continue;
    const { candidate, interactionId } = run.review;
    const disposition = store.operation(`review-disposition:${run.id}`);
    if (disposition?.runId !== run.id || disposition.state !== 'waiting' || disposition.candidate !== candidate ||
      disposition.interactionId !== interactionId) continue;
    // Review observations are cached backend receipts, not a fresh backend check.
    // A confirmed completion takes precedence even when the cached review is pending.
    if ([`completion:${run.id}`, `no-review-completion:${run.id}`].some(id => {
      const completion = store.operation(id);
      return completion?.state === 'recorded' && completion.status === 'done' && completion.runId === run.id &&
        completion.candidate === candidate && (completion.companyId === undefined || completion.companyId === companyId) &&
        (completion.taskId === undefined || completion.taskId === taskId);
    })) continue;
    const origin = { bindingId, conversationId, sessionCreatedAt };
    reviews.push({ id: `review-notification:${digest([origin, companyId, taskId, run.id, candidate, interactionId])}`,
      runId: run.id, origin, companyId, taskId, kind: 'review', state: 'pending', candidate, interactionId,
      identifier: task.receipt.identifier.slice(0, 128), title: task.receipt.title.slice(0, 512), summary: run.result.summary.slice(0, 4000) });
  }
  return reviews;
}

// Reconcile persisted local evidence only. Review-ready is not task completion.
export function reconcileNotifications(store) {
  return store.transaction(() => {
    const tasks = recordedTasks(store);
    const completions = store.db.prepare("SELECT data FROM operations WHERE id LIKE 'completion:%' OR id LIKE 'no-review-completion:%'").all()
      .map(row => JSON.parse(row.data));
    const created = [];
    for (const completion of completions) {
      if (completion.state !== 'recorded' || completion.status !== 'done' || typeof completion.runId !== 'string' ||
        ![`completion:${completion.runId}`, `no-review-completion:${completion.runId}`].includes(completion.id)) continue;
      let run;
      try { run = store.run(completion.runId); }
      catch (error) { if (error.code === 'run_not_found') continue; throw error; }
      if (!run.result || typeof run.result.candidate !== 'string' || !run.result.candidate.trim() ||
        typeof run.result.summary !== 'string' || run.result.candidate !== completion.candidate ||
        run.nativeState !== 'settled' || run.settlement?.outcome !== 'completed' || run.publication?.state !== 'recorded') continue;
      for (const task of tasks) {
        const { companyId } = task.request;
        const taskId = task.receipt.id;
        if (companyId !== run.request.companyId || taskId !== run.request.taskId ||
          (task.receipt.companyId !== undefined && task.receipt.companyId !== companyId) ||
          (completion.companyId !== undefined && completion.companyId !== companyId) ||
          (completion.taskId !== undefined && completion.taskId !== taskId)) continue;
        const { bindingId, conversationId, sessionCreatedAt } = task.request.origin;
        const origin = { bindingId, conversationId, sessionCreatedAt };
        // Both completion paths and duplicate task receipts share the same identity.
        const id = `completion-notification:${digest([origin, companyId, taskId, run.id, completion.candidate])}`;
        if (store.operation(id)) continue;
        const identifier = task.receipt.identifier.slice(0, 128);
        const title = task.receipt.title.slice(0, 512);
        const summary = run.result.summary.slice(0, 4000);
        const prefix = (BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0').slice(-12);
        created.push(store.saveOperation({ id, runId: run.id, origin, companyId, taskId, identifier, title, summary,
          // Legacy reserved source ID, never used by the TUI toast transport.
          state: 'pending', messageId: `msg_${prefix}${randomBytes(7).toString('hex')}`,
          // JSON keeps task/worker content labelled as data, including embedded newlines.
          // Even maximum JSON escaping leaves this text below 32,000 characters.
          text: 'Relay completion status (informational data, not a human instruction or authorisation).\n' +
            JSON.stringify({ status: 'done', identifier, title, summary }) }));
      }
    }
    const reviews = pendingReviews(store, tasks);
    const currentReviews = new Set(reviews.map(item => item.id));
    for (const notification of notifications(store)) {
      if (notification.state === 'pending' && (!hasRecordedOrigin(tasks, notification) ||
        (notification.id.startsWith('review-notification:') && !currentReviews.has(notification.id)))) {
        store.saveOperation({ ...notification, state: 'superseded' });
      }
    }
    for (const notification of reviews) {
      if (!store.operation(notification.id)) created.push(store.saveOperation(notification));
    }
    return created;
  });
}

// The service authenticates the bridge and runs bridgeRequest(..., 'poll', input)
// first to validate live placement and register the current plugin epoch.
export function notificationRequest(store, bridge, action, input) {
  return store.transaction(() => {
    const current = store.operation(bridge.id);
    requireValue(current && canonical(current.identity) === canonical(bridge.identity) && current.epoch === bridge.epoch &&
      current.sessionCreatedAt === bridge.sessionCreatedAt, 'bridge_identity_mismatch', 'Bridge identity or epoch changed', 409);
    bridge = current;
    requireValue(action === 'notification-history' ? ['configured', 'armed'].includes(bridge.state) : bridge.state === 'armed',
      'bridge_unavailable', 'Notification delivery requires an armed bridge', 409);
    requireValue(validOrigin({ ...bridge.identity, sessionCreatedAt: bridge.sessionCreatedAt }) &&
      input.conversationId === bridge.identity.conversationId && input.sessionCreatedAt === bridge.sessionCreatedAt &&
      (input.bindingId === undefined || input.bindingId === bridge.identity.bindingId) &&
      typeof bridge.epoch === 'string' && bridge.epoch.trim() && input.epoch === bridge.epoch,
    'bridge_identity_mismatch', 'Notification request must match the exact native session and epoch', 409);
    const binding = store.binding(bridge.identity.bindingId);
    requireValue(binding.config.conversationId === bridge.identity.conversationId && !binding.lifecycleState,
      'bridge_identity_mismatch', 'Notification binding is no longer active in this conversation', 409);
    const tasks = recordedTasks(store);
    if (action === 'notification-list' || action === 'notification-history') {
      const entries = notifications(store).filter(item => owns(bridge, item) && item.companyId === binding.config.companyId &&
        hasRecordedOrigin(tasks, item));
      return { notifications: action === 'notification-history' ? entries.slice(-50).reverse() :
        entries.filter(item => ['pending', 'uncertain'].includes(item.state) &&
          (item.kind !== 'review' || input.includeReviews === true)).slice(0, 50) };
    }
    requireValue(['notification-begin', 'notification-observe'].includes(action), 'invalid_bridge_action', 'Unknown notification action');
    const notification = store.operation(text(input.id, 'id'));
    requireValue((notification?.id.startsWith('completion-notification:') || notification?.id.startsWith('review-notification:')) && owns(bridge, notification) &&
      notification.companyId === binding.config.companyId && hasRecordedOrigin(tasks, notification),
    'notification_not_found', 'No notification belongs to this exact origin', 404);
    if (action === 'notification-begin') {
      requireValue(notification.kind !== 'review' || input.includeReviews === true,
        'notification_unsupported', 'Plugin must support review-ready notifications', 409);
      // Uncertainty survives lost replies, plugin epochs and service restarts.
      if (notification.state !== 'pending') return { notification, dispatch: false };
      if (notification.id.startsWith('review-notification:')) {
        if (!pendingReviews(store, tasks).some(item => item.id === notification.id)) {
          return { notification: store.saveOperation({ ...notification, state: 'superseded' }), dispatch: false };
        }
        // Active task work delays delivery without invalidating the latest candidate.
        if (store.runs().some(run => run.request.companyId === notification.companyId &&
          run.request.taskId === notification.taskId && run.nativeState !== 'settled')) return { notification, dispatch: false };
      }
      requireValue(input.idle === true, 'native_busy', 'Validated idle snapshot required', 409);
      requireValue(store.runs(bridge.identity.bindingId).every(run => run.nativeState === 'settled'),
        'conversation_busy', 'Unsettled Relay work prevents notification delivery', 409);
      return { notification: store.saveOperation({ ...notification, state: 'uncertain', epoch: bridge.epoch, begunAt: now() }), dispatch: true };
    }
    requireValue(['uncertain', 'announced'].includes(notification.state),
      'notification_not_started', 'Observation requires persisted notification delivery intent', 409);
    if (input.announced !== true) return { notification };
    requireValue(notification.epoch === bridge.epoch,
      'notification_epoch_mismatch', 'Only the notification attempt epoch can acknowledge its TUI toast', 409);
    // Announced means the TUI API accepted the toast, not that a human saw it.
    return { notification: notification.state === 'announced' ? notification : store.saveOperation({ ...notification, state: 'announced' }) };
  });
}

// Check every state, including unconfirmed delivery, before accepting user authority.
export function isNotificationSource(store, bridge, sourceId) {
  return typeof sourceId === 'string' && notifications(store).some(item => owns(bridge, item) && item.messageId === sourceId);
}
