import assert from 'node:assert/strict';
import test from 'node:test';
import server from '../server.mjs';
import { setupTui } from '../tui-setup.mjs';
const tui = { setup: setupTui };

function terminal() {
  let listener, commands, stopped = 0;
  let route = { type: 'session', sessionID: 'session-a' };
  const toasts = [];
  const requests = [];
  const rpc = {
    inspect: async () => ({ version: '2.1.0' }),
    notify: async input => { requests.push(input); },
    events: { on: (_type, callback) => { listener = callback; return () => { stopped++; }; } },
  };
  const ctx = {
    options: {}, location: { directory: '/workspace' }, client: { rpc: () => rpc },
    ui: { router: { current: () => route }, toast: { show: value => toasts.push(value) } },
    keymap: { layer: factory => { commands = factory().commands; } },
  };
  return { ctx, rpc, toasts, requests, emit: event => listener(event),
    switchTo: sessionID => { route = { type: 'session', sessionID }; },
    command: () => commands[0].run(), stopped: () => stopped };
}

test('TUI notifications require the exact local client, selected session and location', async () => {
  const a = terminal();
  const b = terminal();
  const closeA = await tui.setup(a.ctx);
  const closeB = await tui.setup(b.ctx);
  await a.command();
  await b.command();
  assert.notEqual(a.requests[0].clientId, b.requests[0].clientId);
  const event = { data: a.requests[0], location: { directory: '/workspace' } };
  a.emit(event);
  b.emit(event);
  assert.equal(a.toasts.length, 1);
  assert.equal(b.toasts.length, 0);
  a.emit({ ...event, location: { directory: '/different' } });
  a.switchTo('session-b');
  a.emit(event);
  assert.equal(a.toasts.length, 1);
  closeA();
  closeA();
  closeB();
  assert.equal(a.stopped(), 1);
  a.switchTo('session-a');
  a.emit(event);
  assert.equal(a.toasts.length, 1);
});

test('pane switch or disposal during RPC prevents a notification request', async () => {
  for (const transition of ['switch', 'dispose']) {
    const pane = terminal();
    let resolve;
    pane.rpc.inspect = () => new Promise(done => { resolve = done; });
    const close = await tui.setup(pane.ctx);
    const pending = pane.command();
    if (transition === 'switch') pane.switchTo('session-b');
    else close();
    resolve({ version: '2.1.0' });
    await pending;
    assert.equal(pane.requests.length, 0);
    close();
  }
});

test('server cleanup disposes both registrations once and setup failure releases transform', async () => {
  let transformDisposed = 0, rpcDisposed = 0;
  const context = {
    options: {},
    tool: { transform: async () => ({ dispose: async () => { transformDisposed++; } }) },
    rpc: { register: async () => ({ dispose: async () => { rpcDisposed++; } }) },
  };
  const close = await server.setup(context);
  await close();
  await close();
  assert.equal(transformDisposed, 1);
  assert.equal(rpcDisposed, 2);
  context.rpc.register = async () => { throw new Error('registration failed'); };
  await assert.rejects(server.setup(context), /registration failed/);
  assert.equal(transformDisposed, 2);
});
