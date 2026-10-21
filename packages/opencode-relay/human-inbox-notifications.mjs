// Read-only, pane-local notification polling. Never opens a modal, invokes a
// model, answers a question or acknowledges delivery on the human's behalf.
export function humanInboxNotifications({ selectedSession, notificationSessionId, load, notify, record = () => {},
  interval = 5000, schedule = setInterval, unschedule = clearInterval }) {
  let disposed = false, pending = false, previous = '', offline = false, generation = 0, ready = false;
  async function refresh() {
    if (disposed || pending || !notificationSessionId || selectedSession() !== notificationSessionId) return;
    pending = true;
    const origin = generation;
    try {
      const items = await load();
      if (disposed || origin !== generation || selectedSession() !== notificationSessionId) return;
      const fingerprint = JSON.stringify(items.map(item => [item.kind, item.id, item.revision]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
      const recovered = offline;
      offline = false;
      if (!ready || recovered) {
        ready = true;
        record({ type: 'human_inbox_ready', sessionId: notificationSessionId });
      }
      if (fingerprint === previous && !recovered) return;
      previous = fingerprint;
      const questions = items.filter(item => item.kind === 'question').length;
      const reviews = items.filter(item => item.kind === 'review').length;
      if (!items.length) return;
      notify({ sessionID: notificationSessionId, variant: 'info', duration: 15000,
        message: `Relay inbox: ${questions} question(s), ${reviews} review(s). Open /relay-questions or /relay-reviews.` });
      record({ type: 'human_inbox_notification', sessionId: notificationSessionId, questions, reviews });
    } catch {
      if (disposed || origin !== generation || selectedSession() !== notificationSessionId || offline) return;
      offline = true;
      notify({ sessionID: notificationSessionId, variant: 'warning',
        message: 'Relay inbox unavailable. Pending decisions remain in Relay. No answer or review was sent.' });
      record({ type: 'human_inbox_unavailable', sessionId: notificationSessionId });
    } finally { pending = false; }
  }
  const timer = schedule(() => void refresh(), interval);
  timer?.unref?.();
  void refresh();
  return { refresh, invalidate: () => { generation++; previous = ''; ready = false; },
    stop: () => { disposed = true; generation++; unschedule(timer); } };
}
