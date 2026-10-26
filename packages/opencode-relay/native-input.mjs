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
  if (!name || typeof id !== 'string' || !id || !['completed', 'failed', 'cancelled'].includes(metadata.state)) return false;
  // A native completion must identify a tool started in this same input's work.
  // Unrelated peer/schedule notifications never inherit earlier human authority.
  return preceding.some(message => message.type === 'assistant' && message.content?.some(part =>
    part.type === 'tool' && part.name === name && (JSON.stringify(part.state ?? {}).match(/(?:sh|ses)_[A-Za-z0-9_-]+/g) ?? []).includes(id)));
}

export function supportingInput(message, preceding) {
  return instructionInput(message) || completionInput(message, preceding);
}
