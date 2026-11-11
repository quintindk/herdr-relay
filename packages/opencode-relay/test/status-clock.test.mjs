import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClockTime, registerStatusClock, watchClock } from '../status-clock.mjs';

function clock(t, date) {
  const f = { date, updates: [], timers: [], cleared: [], unrefs: 0 };
  f.stop = watchClock({ now: () => f.date, update: value => f.updates.push(value),
    timeout: (callback, delay) => {
      const timer = { callback, delay, unref() { f.unrefs++; } };
      f.timers.push(timer); return timer;
    }, clear: timer => f.cleared.push(timer) });
  f.tick = date => { f.date = date; f.timers.at(-1).callback(); };
  t.after(f.stop); return f;
}

test('clock uses local, zero-padded 24-hour time without seconds or a date', () => {
  for (const [hour, minute, expected] of [[0, 0, '00:00'], [1, 9, '01:09'], [12, 0, '12:00'], [23, 59, '23:59']]) {
    assert.equal(formatClockTime(new Date(2026, 10, 11, hour, minute, 37, 456)), expected);
  }
});

test('clock renders immediately and aligns updates to minute boundaries, not one-second polling', t => {
  const f = clock(t, new Date(2026, 10, 11, 8, 4, 37, 250));
  assert.deepEqual(f.updates, ['08:04']);
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 22750);
  f.tick(new Date(2026, 10, 11, 8, 5));
  assert.deepEqual(f.updates, ['08:04', '08:05']);
  assert.equal(f.timers[1].delay, 60000); assert.equal(f.unrefs, 2);
});

test('clock follows midnight, sleep and wall-clock changes without accumulating timer drift', t => {
  const f = clock(t, new Date(2026, 10, 11, 23, 59, 59, 999));
  assert.equal(f.timers[0].delay, 1);
  f.tick(new Date(2026, 10, 12, 0, 0));
  f.tick(new Date(2026, 10, 12, 9, 17, 12, 500));
  assert.equal(f.timers.at(-1).delay, 47500);
  f.tick(new Date(2026, 10, 12, 8, 17, 42));
  assert.deepEqual(f.updates, ['23:59', '00:00', '09:17', '08:17']);
  assert.equal(f.timers.at(-1).delay, 18000);
});

test('clock cleanup cancels its timer once and ignores callbacks queued before disposal', t => {
  const f = clock(t, new Date(2026, 10, 11, 8, 4));
  f.stop(); f.stop();
  assert.deepEqual(f.cleared, [f.timers[0]]);
  f.tick(new Date(2026, 10, 11, 8, 5));
  assert.deepEqual(f.updates, ['08:04']); assert.equal(f.timers.length, 1);
});

test('clock appends to both built-in status bars, avoids a duplicate on Home and follows theme changes', () => {
  const claims = [], removed = [], events = [];
  const ctx = { theme: { text: { muted: 'grey' } }, ui: {
    slot: claim => { claims.push(claim); return () => removed.push(claim.append); },
  } };
  const stop = registerStatusClock(ctx, { renderClock: props => props, record: event => events.push(event) });
  assert.deepEqual(claims.map(claim => claim.append), ['home.footer.status', 'prompt.footer.status']);
  assert.equal(claims.some(claim => 'replace' in claim), false);
  const home = claims[0].render({}), input = {}, prompt = claims[1].render(input);
  assert.equal(home.visible, true); assert.equal(prompt.visible, false);
  input.sessionID = 'session'; assert.equal(prompt.visible, true);
  delete input.sessionID; assert.equal(prompt.visible, false);
  ctx.theme = { text: { muted: 'blue' } }; assert.equal(home.theme.text.muted, 'blue');
  home.record('08:04');
  assert.deepEqual(events, [{ type: 'status_clock_rendered', slot: 'home.footer.status', time: '08:04' }]);
  stop(); stop(); assert.deepEqual(removed, ['home.footer.status', 'prompt.footer.status']);
});

test('clock skips hosts without slots and rolls back a partial registration', () => {
  registerStatusClock({ ui: {} }, {})();
  let removed = 0;
  const ctx = { ui: { slot: claim => {
    if (claim.append === 'prompt.footer.status') throw new Error('slot unavailable');
    return () => { removed++; };
  } } };
  assert.throws(() => registerStatusClock(ctx, { renderClock: () => null }), /slot unavailable/);
  assert.equal(removed, 1);
});
