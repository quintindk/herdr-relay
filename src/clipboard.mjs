import { spawnSync } from 'node:child_process';

export const MAX_CLIPBOARD_BYTES = 64 * 1024;

export function osc52Sequence(text, { tmux = Boolean(process.env.TMUX) } = {}) {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return tmux ? `\x1bPtmux;\x1b\x1b]52;c;${encoded}\x07\x1b\\` : `\x1b]52;c;${encoded}\x07`;
}

export function copyTextToClipboard(text, { platform = process.platform, env = process.env, stdout = process.stdout, run = spawnSync } = {}) {
  if (typeof text !== 'string' || !text.length) return { ok: false, error: 'Nothing to copy' };
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) return { ok: false, error: 'Content exceeds clipboard limit' };

  const candidates = [];
  if (platform === 'darwin') candidates.push(['pbcopy', []]);
  if (env.WAYLAND_DISPLAY) candidates.push(['wl-copy', []]);
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) candidates.push(['clip.exe', []]);
  if (env.DISPLAY) candidates.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]);
  let nativeMethod;
  for (const [command, args] of candidates) {
    try {
      const result = run(command, args, { input: text, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 });
      if (!result.error && result.status === 0) { nativeMethod = command; break; }
    } catch { /* Try the next clipboard transport. */ }
  }

  // A graphical clipboard can be on the Relay host, while OSC 52 reaches the
  // user's terminal. Send to the terminal even if a native command succeeded.
  let sent = false;
  if (stdout?.isTTY && typeof stdout.write === 'function') {
    try { stdout.write(osc52Sequence(text, { tmux: Boolean(env.TMUX) })); sent = true; }
    catch { /* The terminal is no longer writable. */ }
  }
  if (nativeMethod || sent) return { ok: true, method: nativeMethod ?? 'osc52' };
  return { ok: false, error: 'Clipboard unavailable in this terminal' };
}
