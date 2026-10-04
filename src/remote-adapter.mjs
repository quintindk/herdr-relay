import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { execute as localExecute } from './adapter.mjs';
import { remoteCommand } from './remote.mjs';
import { RelayError, requireValue } from './protocol.mjs';

export async function executeRemote(ctx, { spawnProcess = spawn } = {}) {
  const config = JSON.parse(readFileSync(ctx.config.relayNodeFile, 'utf8'));
  const args = remoteCommand(config, ['adapter-stdio']);
  const timeoutSec = ctx.config.timeoutSec ?? 300;
  requireValue(Number.isFinite(timeoutSec) && timeoutSec > 0, 'invalid_config', 'timeoutSec must be positive');
  const deadline = Date.now() + timeoutSec * 1000;
  await ctx.onCancellationReady?.();
  ctx.onDispatch?.();
  for (;;) {
    const child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let result;
    let failure;
    const onAbort = () => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'cancel' })}\n`); };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      for (;;) {
        const index = output.indexOf('\n');
        if (index < 0) break;
        const line = output.slice(0, index);
        output = output.slice(index + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.type === 'result') result = frame.result;
          else if (frame.type === 'error') failure = new RelayError(frame.code, 'Remote adapter rejected the invocation');
          else if (frame.type === 'log') void ctx.onLog(frame.stream, frame.message);
        } catch {}
      }
    });
    // SSH diagnostics can include local paths but never the stdin run credential.
    child.stderr.on('data', () => {});
    child.stdin.write(`${JSON.stringify({ type: 'execute', context: {
      agent: ctx.agent, runId: ctx.runId, authToken: ctx.authToken, context: ctx.context,
      config: { ...ctx.config, relayNodeFile: undefined, relayContextFile: config.contextFile },
      cancelled: Boolean(ctx.signal?.aborted || Date.now() >= deadline),
    } })}\n`);
    await new Promise(resolve => { child.once('error', resolve); child.once('exit', resolve); });
    ctx.signal?.removeEventListener('abort', onAbort);
    clearTimeout(timer);
    if (result) return result;
    if (failure) throw failure;
    await ctx.onLog('stderr', `${JSON.stringify({ code: 'remote_adapter_disconnected', reconciliationPending: true })}\n`);
    // Same immutable backend-run key. Disconnect is not evidence of native stop.
    await delay(1000);
  }
}

export async function serveAdapterStdio() {
  const abort = new AbortController();
  let buffer = '';
  let started = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 2 * 1024 * 1024) process.exit(1);
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === 'cancel') abort.abort();
      if (frame.type !== 'execute' || started) continue;
      started = true;
      if (frame.context.cancelled) abort.abort();
      void localExecute({ ...frame.context, signal: abort.signal,
        onLog: async (stream, message) => process.stdout.write(`${JSON.stringify({ type: 'log', stream, message })}\n`),
      }).then(result => {
        process.stdout.write(`${JSON.stringify({ type: 'result', result })}\n`, () => process.exit(0));
      }).catch(error => {
        process.stdout.write(`${JSON.stringify({ type: 'error', code: error.code ?? 'adapter_failed' })}\n`, () => process.exit(1));
      });
    }
  });
  // Native work belongs to the remote Relay service. A lost SSH stream ends only
  // this adapter attachment, allowing the caller to reconcile the same run.
  process.stdin.on('end', () => process.exit(1));
  process.stdout.on('error', () => process.exit(1));
}
