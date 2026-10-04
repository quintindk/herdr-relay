import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { canonical, requireValue, text } from './protocol.mjs';

export function nativeConfig(input) {
  requireValue(input && typeof input === 'object', 'invalid_native_config', 'opencode configuration is required');
  const url = new URL(text(input.url, 'opencode.url'));
  requireValue(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'invalid_native_config', 'OpenCode must use a local HTTP origin without embedded credentials');
  requireValue(isAbsolute(text(input.directory, 'opencode.directory')), 'invalid_native_config', 'Native directory must be absolute');
  requireValue(input.exclusive === true, 'native_reservation_required', 'Reserve the conversation for Relay before enabling native delivery');
  requireValue(Number.isSafeInteger(input.sessionCreatedAt) && input.sessionCreatedAt > 0,
    'invalid_native_config', 'Native session creation time is required');
  const config = {
    url: url.origin, directory: input.directory, projectID: text(input.projectID, 'opencode.projectID'),
    sessionCreatedAt: input.sessionCreatedAt, exclusive: true,
  };
  if (input.authFile !== undefined) {
    requireValue(isAbsolute(text(input.authFile, 'opencode.authFile')), 'invalid_native_config', 'Authentication file must be absolute');
    config.authFile = input.authFile;
  }
  if (input.model !== undefined) config.model = {
    providerID: text(input.model.providerID, 'model.providerID'), modelID: text(input.model.modelID, 'model.modelID'),
  };
  if (input.runtimeKey !== undefined) config.runtimeKey = text(input.runtimeKey, 'opencode.runtimeKey');
  return config;
}

export class OpenCode {
  constructor(binding) {
    this.config = binding.opencode;
    this.sessionId = binding.conversationId;
    this.path = `/session/${encodeURIComponent(this.sessionId)}`;
  }

  async request(method, path, body) {
    const url = new URL(path, this.config.url);
    url.searchParams.set('directory', this.config.directory);
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.authFile) {
      const auth = JSON.parse(readFileSync(this.config.authFile, 'utf8'));
      requireValue(typeof auth.password === 'string' && auth.password.length > 0,
        'invalid_native_auth', 'Native authentication file requires a password');
      headers.Authorization = `Basic ${Buffer.from(`${auth.username ?? 'opencode'}:${auth.password}`).toString('base64')}`;
    }
    const response = await fetch(url, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(5000),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    requireValue(response.ok, 'native_http_error', `OpenCode returned HTTP ${response.status}`, 502);
    if (response.status === 204) return;
    return response.json();
  }

  async verify() {
    const session = await this.request('GET', this.path);
    requireValue(session.id === this.sessionId && session.directory === this.config.directory &&
      session.projectID === this.config.projectID && session.time?.created === this.config.sessionCreatedAt &&
      !session.time?.archived && !session.revert,
    'native_identity_mismatch', 'Native conversation identity or eligibility changed', 409);
    return session;
  }

  async snapshot() {
    await this.verify();
    const messages = await this.request('GET', `${this.path}/message`);
    requireValue(Array.isArray(messages) && messages.every(message => message.info?.sessionID === this.sessionId && Array.isArray(message.parts)),
      'invalid_native_response', 'Expected native session messages', 502);
    const statuses = await this.request('GET', '/session/status');
    requireValue(statuses && typeof statuses === 'object' && !Array.isArray(statuses),
      'invalid_native_response', 'Expected native session statuses', 502);
    return { messages, idle: !statuses[this.sessionId] || statuses[this.sessionId].type === 'idle' };
  }

  async send(invocation) {
    await this.request('POST', `${this.path}/prompt_async`, {
      messageID: invocation.messageId,
      ...(this.config.model ? { model: this.config.model } : {}),
      parts: [{ type: 'text', text: invocation.prompt }],
    });
  }

  async interrupt() { await this.request('POST', `${this.path}/abort`, {}); }
}

export function observe(snapshot, invocation) {
  const user = snapshot.messages.find(message => message.info.id === invocation.messageId);
  if (!user) return { state: 'uncertain', reason: 'message_not_observed' };
  const texts = user.parts.filter(part => part.type === 'text' && !part.synthetic).map(part => part.text);
  // OpenCode commits message metadata before its parts. A read in that window
  // proves neither a matching payload nor a conflicting one.
  if (user.info.role === 'user' && texts.length === 0) return { state: 'uncertain', reason: 'message_parts_pending' };
  if (user.info.role !== 'user' || canonical(texts) !== canonical([invocation.prompt])) {
    return { state: 'conflict', reason: 'message_payload_mismatch' };
  }
  // Newly introduced user messages (including compaction continuation) invalidate
  // attribution. Never infer that a later assistant response belongs to our work.
  const unexpected = snapshot.messages.some(message => message.info.role === 'user' &&
    message.info.id !== invocation.messageId && !invocation.priorUserIds.includes(message.info.id));
  if (unexpected) return { state: 'conflict', reason: 'concurrent_native_input' };
  const replies = snapshot.messages.filter(message => message.info.role === 'assistant' && message.info.parentID === invocation.messageId);
  const last = replies.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id)).at(-1);
  const terminal = last && last.info.time.completed && !last.info.summary &&
    (last.info.error || (last.info.finish && !['tool-calls', 'unknown'].includes(last.info.finish) &&
      !last.parts.some(part => part.type === 'tool' && !part.metadata?.providerExecuted)));
  const activeTool = replies.some(message => message.parts.some(part => part.type === 'tool' && ['pending', 'running'].includes(part.state?.status)));
  if (!snapshot.idle || !terminal || activeTool) return { state: 'observed', reason: 'awaiting_terminal_response' };
  return {
    state: 'finished', messageId: last.info.id,
    ...(last.info.error ? { error: last.info.error.name ?? 'NativeError' } : {}),
  };
}
