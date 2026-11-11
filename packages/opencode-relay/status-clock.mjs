export function formatClockTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function watchClock({ update, now = () => new Date(), timeout = setTimeout, clear = clearTimeout }) {
  let closed = false, timer;
  const tick = () => {
    if (closed) return;
    const date = now();
    update(formatClockTime(date));
    // Re-read wall time after every tick, including resume from sleep or a clock change.
    timer = timeout(tick, 60000 - (date.getSeconds() * 1000 + date.getMilliseconds()));
    timer?.unref?.();
  };
  tick();
  return () => {
    if (closed) return;
    closed = true;
    clear(timer);
  };
}

export function registerStatusClock(ctx, { renderClock, record = () => {} }) {
  if (!ctx.ui.slot) return () => {};
  if (!renderClock) throw new Error('Status clock renderer was not provided by the TUI entrypoint');
  let closed = false;
  const removers = [];
  const stop = () => {
    if (closed) return;
    closed = true;
    for (const remove of removers) remove();
  };
  try {
    for (const slot of ['home.footer.status', 'prompt.footer.status']) removers.push(ctx.ui.slot({ append: slot,
      render: input => renderClock({
        // Home also has a prompt footer. Show its clock only in the bottom status bar.
        get visible() { return slot === 'home.footer.status' || Boolean(input.sessionID); },
        get theme() { return ctx.theme; },
        record: time => record({ type: 'status_clock_rendered', slot, time }),
      }),
    }));
  } catch (error) { stop(); throw error; }
  return stop;
}
