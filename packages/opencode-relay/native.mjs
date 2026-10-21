import { isAbsolute } from 'node:path';

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export const supportedV2Versions = Object.freeze(['2.1.0', '2.1.2']);

export function checkV2Version(version) {
  check(supportedV2Versions.includes(version), 'unsupported_native_version');
  return version;
}

// A versioned spike adapter, not wired into the v1 Relay execution service yet.
export class NativeOpenCodeV2 {
  constructor(client, identity) {
    check(identity && typeof identity.sessionId === 'string' && identity.sessionId &&
      typeof identity.projectId === 'string' && identity.projectId &&
      typeof identity.directory === 'string' && isAbsolute(identity.directory) &&
      Number.isSafeInteger(identity.createdAt) && identity.createdAt > 0, 'invalid_native_identity');
    this.client = client;
    this.identity = structuredClone(identity);
  }

  async verify() {
    const session = await this.client.session.get({ sessionID: this.identity.sessionId });
    check(session.id === this.identity.sessionId && session.projectID === this.identity.projectId &&
      session.location?.directory === this.identity.directory && session.time?.created === this.identity.createdAt &&
      !session.time.archived && !session.revert, 'native_identity_mismatch');
    return session;
  }

  async snapshot() {
    await this.verify();
    const messages = [];
    const cursors = new Set();
    const ids = new Set();
    let cursor;
    do {
      const page = await this.client.message.list({ sessionID: this.identity.sessionId,
        ...(cursor ? { cursor } : { order: 'asc', limit: 100 }) });
      check(page && Array.isArray(page.data) && page.cursor, 'invalid_native_response');
      for (const message of page.data) {
        check(message && typeof message.id === 'string' && !ids.has(message.id), 'invalid_native_response');
        ids.add(message.id);
      }
      messages.push(...page.data);
      cursor = page.cursor.next;
      check(!cursor || typeof cursor === 'string' && !cursors.has(cursor), 'invalid_native_cursor');
      if (cursor) cursors.add(cursor);
      check(messages.length <= 10000, 'native_snapshot_incomplete');
    } while (cursor);
    const [active, inbox] = await Promise.all([
      this.client.session.active(), this.client.session.inbox.list({ sessionID: this.identity.sessionId }),
    ]);
    check(active && typeof active === 'object' && !Array.isArray(active) && Array.isArray(inbox), 'invalid_native_response');
    await this.verify();
    return { messages, idle: !active[this.identity.sessionId], inbox };
  }

  async send(invocation) {
    await this.verify();
    check(typeof invocation.messageId === 'string' && invocation.messageId &&
      typeof invocation.prompt === 'string' && invocation.prompt, 'invalid_native_invocation');
    // Caller must persist intent and enforce local admission. This method never
    // retries a prompt and does not claim an atomic idle-and-send primitive.
    return this.client.session.prompt({ sessionID: this.identity.sessionId,
      id: invocation.messageId, text: invocation.prompt, delivery: 'queue', metadata: { herdrRelayInvocation: invocation.messageId } });
  }
}

export function observeV2(snapshot, invocation) {
  const index = snapshot.messages.findIndex(message => message.id === invocation.messageId);
  if (index < 0) return { state: 'uncertain', reason: 'message_not_observed' };
  const user = snapshot.messages[index];
  if (user.type !== 'user' || user.text !== invocation.prompt) return { state: 'conflict', reason: 'message_payload_mismatch' };
  // The v2 transcript has no v1 assistant.parentID. Require a contiguous owned
  // turn through its first idle receipt and refuse any intervening foreign input.
  const terminalOffset = snapshot.messages.slice(index + 1).findIndex(message => message.type === 'idle');
  const end = terminalOffset < 0 ? snapshot.messages.length : index + 1 + terminalOffset;
  const foreign = snapshot.messages.slice(0, end).some(message =>
    ['user', 'synthetic', 'shell', 'location-switched', 'agent-switched', 'model-switched'].includes(message.type) &&
    message.id !== invocation.messageId && !invocation.priorMessageIds.includes(message.id));
  if (foreign) return { state: 'conflict', reason: 'concurrent_native_input' };
  if (terminalOffset < 0 || !snapshot.idle || snapshot.inbox.length) return { state: 'observed', reason: 'awaiting_terminal_response' };
  const terminal = snapshot.messages[end];
  if (!['succeeded', 'failed', 'interrupted'].includes(terminal.outcome)) return { state: 'uncertain', reason: 'invalid_terminal_outcome' };
  const activeTool = snapshot.messages.slice(index + 1, end).some(message =>
    message.type === 'assistant' && message.content.some(part => part.type === 'tool' && ['running', 'streaming'].includes(part.state.status)));
  if (activeTool) return { state: 'observed', reason: 'awaiting_tool_settlement' };
  return { state: 'finished', messageId: terminal.id, outcome: terminal.outcome,
    ...(terminal.error ? { error: terminal.error.type } : {}) };
}
