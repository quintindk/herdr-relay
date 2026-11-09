// Classify native provenance, never prose claiming to be a human instruction.
// Instruction loads affect the model's instructions but do not start a new turn.
export function instructionInput(message) {
  const paths = message?.metadata?.instruction?.paths;
  return message?.type === 'synthetic' && Array.isArray(paths) && paths.length > 0 &&
    !message.metadata.source && !message.metadata.herdrRelayInvocation &&
    paths.every(path => typeof path === 'string' && path.startsWith('/') && !/[\x00-\x1f]/.test(path));
}

export function completionInput(message, preceding) {
  if (message?.type !== 'synthetic') return false;
  const metadata = message.metadata;
  const name = metadata?.source === 'shell' ? 'shell' : metadata?.source === 'subagent' ? 'subagent' : null;
  const id = name === 'shell' ? metadata.shellID : metadata?.childID;
  if (!name || typeof id !== 'string' || !(name === 'shell' ? /^sh_[A-Za-z0-9_-]+$/ : /^ses_[A-Za-z0-9_-]+$/).test(id) ||
    !['completed', 'failed', 'cancelled'].includes(metadata.state) || metadata.herdrRelayInvocation || metadata.notification || metadata.synthetic) return false;
  // A native completion must identify a tool started in this same input's work.
  // Unrelated peer/schedule notifications never inherit earlier human authority.
  return preceding.some(message => message.type === 'assistant' && message.content?.some(part => {
    if (part.type !== 'tool' || part.name !== name || part.state?.status !== 'completed') return false;
    const reported = part.state.metadata?.[name === 'shell' ? 'shellID' : 'sessionID'];
    if (reported !== undefined) return reported === id;
    // Older native receipts report the ID in tool output. Never match an ID
    // mentioned in the tool's input prompt or override a different native ID.
    return (JSON.stringify(part.state.content ?? []).match(/(?:sh|ses)_[A-Za-z0-9_-]+/g) ?? []).includes(id);
  }));
}

// OpenCode's runner emits these two untagged synthetic controls after a completed
// assistant step. Match the fixed control AND its adjacent native failure/finish,
// never arbitrary "continue" prose or a peer's tagged notification. These retain
// the existing source only. They are not human acknowledgement or new authority.
// Upstream: anomalyco/opencode v2.2.5, packages/core/src/session/runner/llm.ts.
export function continuationInput(message, preceding) {
  if (message?.type !== 'synthetic' || message.metadata !== undefined) return false;
  const finish = message.text === 'The previous response was interrupted. Continue from where you left off without repeating completed content.' ? 'error' :
    message.text === 'Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.' ? 'length' : null;
  const previous = preceding.at(-1), created = message.time?.created, start = previous?.time?.created, completed = previous?.time?.completed;
  return finish !== null && previous?.type === 'assistant' && previous.finish === finish &&
    Number.isSafeInteger(created) && created > 0 && Number.isSafeInteger(start) && start > 0 &&
    Number.isSafeInteger(completed) && completed >= start && created >= completed &&
    (finish === 'error' ? typeof previous.error?.type === 'string' && !!previous.error.type : !previous.error);
}

export function supportingInput(message, preceding) {
  return instructionInput(message) || completionInput(message, preceding) || continuationInput(message, preceding);
}

// Native user input is collaboration only inside a verified interactive binding.
// Relay/peer envelopes and synthetic prose never become human permission.
export function humanInput(message) {
  return message?.type === 'user' && typeof message.text === 'string' && !!message.text.trim() &&
    !message.metadata?.herdrRelayInvocation && !message.metadata?.synthetic && !message.metadata?.notification && !message.metadata?.source;
}

export function modelReference(value) {
  const valid = text => typeof text === 'string' && text.trim() === text && text.length > 0 && text.length <= 256 && !/[\x00-\x1f]/.test(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !Object.keys(value).every(key => ['providerID', 'id', 'variant'].includes(key)) || !valid(value.providerID) || !valid(value.id) ||
    value.variant !== undefined && !valid(value.variant)) return null;
  return { providerID: value.providerID, id: value.id, ...(value.variant && value.variant !== 'default' ? { variant: value.variant } : {}) };
}

// Native model selection is control evidence, not a human instruction. The
// observer also requires a later human input and a matching current selection.
export function modelSelectionInput(message) {
  return message?.type === 'model-switched' && Number.isSafeInteger(message.time?.created) && message.time.created > 0 &&
    !message.metadata?.source && !message.metadata?.herdrRelayInvocation && !message.metadata?.synthetic && !message.metadata?.notification &&
    !!modelReference(message.model) && (message.previous === undefined || !!modelReference(message.previous));
}
