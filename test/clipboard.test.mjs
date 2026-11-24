import assert from 'node:assert/strict';
import test from 'node:test';
import { copyTextToClipboard, MAX_CLIPBOARD_BYTES, osc52Sequence } from '../src/clipboard.mjs';

const body = 'Full message\névidence 📎';
const success = { status: 0 };
const missing = { error: new Error('ENOENT'), status: null };

for (const [platform, env, command, args] of [
  ['darwin', {}, 'pbcopy', []],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0' }, 'wl-copy', []],
  ['linux', { WSL_DISTRO_NAME: 'Ubuntu' }, 'clip.exe', []],
  ['linux', { WSL_INTEROP: '/run/WSL/interop' }, 'clip.exe', []],
  ['linux', { DISPLAY: ':0' }, 'xclip', ['-selection', 'clipboard']],
]) test(`copies exact UTF-8 text via ${command}`, () => {
  const calls = [];
  const run = (...argv) => { calls.push(argv); return success; };
  assert.deepEqual(copyTextToClipboard(body, { platform, env, stdout: {}, run }), { ok: true, method: command });
  assert.deepEqual(calls, [[command, args, { input: body, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 }]]);
});

test('falls back to xsel after xclip fails and also writes OSC 52 on a TTY', () => {
  const calls = [], frames = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return cmd === 'xsel' ? success : missing; };
  assert.deepEqual(copyTextToClipboard(body, { platform: 'linux', env: { DISPLAY: ':0' }, run,
    stdout: { isTTY: true, write: frame => frames.push(frame) } }), { ok: true, method: 'xsel' });
  assert.deepEqual(calls, [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]);
  assert.deepEqual(frames, [osc52Sequence(body, { tmux: false })]);
});

test('headless SSH and Herdr TTY use OSC 52, with DCS passthrough under tmux', () => {
  const b64 = Buffer.from(body).toString('base64');
  for (const env of [{ SSH_TTY: '/dev/pts/0' }, { TERM_PROGRAM: 'herdr' }, { TMUX: '/tmp/tmux' }]) {
    const frames = [];
    const result = copyTextToClipboard(body, { platform: 'linux', env, run: () => assert.fail('No display'),
      stdout: { isTTY: true, write: frame => frames.push(frame) } });
    assert.deepEqual(result, { ok: true, method: 'osc52' });
    assert.deepEqual(frames, [env.TMUX ? `\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\` : `\x1b]52;c;${b64}\x07`]);
  }
});

test('OSC 52 encodes hostile control sequences as data', () => {
  const hostile = '\x1b]52;c;inject\x07\x1b\\\x1b[2J\n\0👋';
  const match = /^\x1b\]52;c;([A-Za-z0-9+/=]+)\x07$/.exec(osc52Sequence(hostile, { tmux: false }));
  assert.ok(match);
  assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), hostile);
});

test('refuses empty and oversized UTF-8 input without using any clipboard transport', () => {
  const calls = [], options = { platform: 'darwin', env: {}, run: (...args) => calls.push(args),
    stdout: { isTTY: true, write: (...args) => calls.push(args) } };
  assert.deepEqual(copyTextToClipboard('', options), { ok: false, error: 'Nothing to copy' });
  assert.deepEqual(copyTextToClipboard(null, options), { ok: false, error: 'Nothing to copy' });
  assert.deepEqual(copyTextToClipboard('é'.repeat(MAX_CLIPBOARD_BYTES / 2) + 'x', options), { ok: false, error: 'Content exceeds clipboard limit' });
  assert.deepEqual(calls, []);
  assert.deepEqual(copyTextToClipboard('é'.repeat(MAX_CLIPBOARD_BYTES / 2), { ...options, run: () => success }), { ok: true, method: 'pbcopy' });
});

test('without a working command or TTY, reports failure without throwing', () => {
  const calls = [], unavailable = { ok: false, error: 'Clipboard unavailable in this terminal' };
  assert.deepEqual(copyTextToClipboard(body, { platform: 'linux', env: { WAYLAND_DISPLAY: '', DISPLAY: '' },
    run: (...args) => calls.push(args), stdout: { isTTY: false, write: (...args) => calls.push(args) } }), unavailable);
  assert.deepEqual(calls, []);
  const closed = { isTTY: true, write: () => { throw Error('TTY closed'); } };
  assert.deepEqual(copyTextToClipboard(body, { platform: 'darwin', env: {}, run: () => { throw Error('Command failed'); }, stdout: closed }), unavailable);
  assert.deepEqual(copyTextToClipboard(body, { platform: 'darwin', env: {}, run: () => success, stdout: closed }), { ok: true, method: 'pbcopy' });
});
