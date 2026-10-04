import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { RelayError, requireValue, text } from './protocol.mjs';

export function hermesConfig(input) {
  requireValue(input && typeof input === 'object', 'invalid_native_config', 'hermes configuration is required');
  const url = new URL(text(input.url, 'hermes.url'));
  requireValue(url.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    url.pathname === '/api/ws' && !url.username && !url.password && !url.search && !url.hash,
  'invalid_native_config', 'Hermes requires a local /api/ws URL without embedded credentials');
  requireValue(isAbsolute(text(input.directory, 'hermes.directory')) && isAbsolute(text(input.authFile, 'hermes.authFile')),
    'invalid_native_config', 'Hermes directory and token file must be absolute');
  requireValue(input.exclusive === true, 'native_reservation_required', 'Reserve the Hermes conversation before native delivery');
  return { url: url.href, directory: input.directory, authFile: input.authFile, exclusive: true,
    runtimeId: text(input.runtimeId, 'hermes.runtimeId'), epoch: text(input.epoch, 'hermes.epoch'),
    ...(input.profile ? { profile: text(input.profile, 'hermes.profile') } : {}) };
}

export class Hermes {
  constructor(binding) { this.config = binding.hermes; this.sessionId = binding.conversationId; }

  async request(method, params = {}) {
    const url = new URL(this.config.url);
    url.searchParams.set('token', readFileSync(this.config.authFile, 'utf8').trim());
    // One bounded connection per RPC. Server event replay supplies observations
    // across reconnects, so connection loss cannot become a fabricated receipt.
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.close();
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new RelayError('native_timeout', 'Hermes RPC timed out', 503)), 5000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method,
        params: { ...(method === 'session.create' ? {} : { session_id: this.config.runtimeId }),
          ...(this.config.profile ? { profile: this.config.profile } : {}), ...params } })));
      ws.addEventListener('error', () => finish(new RelayError('native_unavailable', 'Hermes connection failed', 503)));
      ws.addEventListener('close', () => finish(new RelayError('native_disconnected', 'Hermes connection closed before receipt', 503)));
      ws.addEventListener('message', event => {
        try {
          for (const line of String(event.data).split('\n').filter(Boolean)) {
            const frame = JSON.parse(line);
            if (frame.id !== 1) continue;
            finish(frame.error ? new RelayError('native_rpc_error', `Hermes rejected ${method}`, 502) : null, frame.result);
          }
        } catch { finish(new RelayError('invalid_native_response', 'Invalid Hermes RPC response', 502)); }
      });
    });
  }

  async snapshot() {
    const session = await this.request('session.activate');
    const events = await this.request('session.events.since', { last_seen: 0 });
    requireValue(session.session_id === this.config.runtimeId &&
      (session.stored_session_id ?? session.info?.stored_session_id ?? session.session_key) === this.sessionId &&
      session.info?.cwd === this.config.directory && events.epoch === this.config.epoch,
    'native_identity_mismatch', 'Hermes runtime, stored conversation, directory or replay epoch changed', 409);
    requireValue(Array.isArray(session.messages) && !session.messages_omitted && Array.isArray(events.events),
      'invalid_native_response', 'Full Hermes transcript and replay required', 502);
    return { session, events, idle: session.running === false && session.info.running !== true &&
      session.status === 'idle' && !session.queued && !session.hydrating };
  }

  async verify() { return this.snapshot(); }

  async send(invocation) {
    const receipt = await this.request('prompt.submit', { text: invocation.prompt, queued: true });
    requireValue(receipt.status === 'streaming' && Number.isSafeInteger(receipt.user_row_id),
      'native_delivery_unproven', 'Hermes did not confirm a persisted immediate turn', 409);
    return receipt;
  }
}

export function observeHermes(snapshot, invocation) {
  const messages = snapshot.session.messages;
  const matches = messages.filter(message => message.role === 'user' && message.text?.trim() === invocation.prompt.trim());
  if (matches.length === 0) return { state: 'uncertain', reason: 'message_not_observed' };
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].row_id)) return { state: 'conflict', reason: 'message_identity_ambiguous' };
  const user = matches[0];
  if (messages.some(message => message.role === 'user' && message.row_id !== user.row_id && !invocation.priorUserIds.includes(message.row_id))) {
    return { state: 'conflict', reason: 'concurrent_native_input' };
  }
  // PersistedTurn is stronger than an idle transcript: it explicitly identifies
  // this user row and the completed final row from the native execution.
  let terminal = snapshot.events.events.findLast(event => event.type === 'message.complete' &&
    event.session_id === snapshot.session.session_id && event.payload?.persisted_turn?.complete === true &&
    event.payload.persisted_turn.user_row_id === user.row_id);
  let finalId = terminal?.payload.persisted_turn.final_assistant_row_id;
  // Some installed gateways omit persisted_turn despite the published shape.
  // Accept a replayed terminal event only inside the reserved post-input segment,
  // with a unique durable matching final row and no intervening user messages.
  if (!terminal && Number.isSafeInteger(invocation.eventCursor)) {
    terminal = snapshot.events.events.findLast(event => event.type === 'message.complete' &&
      event.session_id === snapshot.session.session_id && event.seq > invocation.eventCursor &&
      typeof event.payload?.text === 'string' && event.payload.text.length > 0);
    if (terminal) {
      const finals = messages.filter(message => message.role === 'assistant' && Number.isSafeInteger(message.row_id) &&
        message.row_id > user.row_id && message.text === terminal.payload.text);
      if (finals.length === 1) finalId = finals[0].row_id;
    }
  }
  if (!terminal) return { state: 'observed', reason: snapshot.events.truncated ? 'terminal_evidence_evicted' : 'awaiting_terminal_response' };
  const final = messages.find(message => message.role === 'assistant' && message.row_id === finalId);
  if (!snapshot.idle || !final || !['complete', 'error', 'interrupted'].includes(terminal.payload.status)) {
    return { state: 'observed', reason: 'awaiting_terminal_response' };
  }
  return { state: 'finished', messageId: String(finalId),
    ...(terminal.payload.status !== 'complete' ? { error: terminal.payload.status } : {}) };
}
