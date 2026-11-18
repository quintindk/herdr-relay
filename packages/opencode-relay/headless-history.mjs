const responseNamespaces = ['openai', 'openresponses', 'openai-compatible', 'github-copilot'];
const connectionFields = ['itemId', 'responseId', 'reasoningEncryptedContent'];

function portableMetadata(metadata) {
  if (!metadata || !connectionFields.some(key => Object.hasOwn(metadata, key))) return metadata;
  const clean = { ...metadata };
  for (const key of connectionFields) delete clean[key];
  return clean;
}

function portableRecord(record) {
  const original = record.providerMetadata;
  let providerMetadata = original;
  for (const key of responseNamespaces) {
    const before = original?.[key], after = portableMetadata(before);
    if (after === before) continue;
    if (providerMetadata === original) providerMetadata = { ...original };
    if (Object.keys(after).length) providerMetadata[key] = after;
    else delete providerMetadata[key];
  }
  const native = portableMetadata(record.native);
  return providerMetadata === original && native === record.native ? record : { ...record,
    ...(providerMetadata === original ? {} : { providerMetadata }), ...(native === record.native ? {} : { native }) };
}

// Responses item IDs belong to the connection that issued them. Carry earlier
// text and tool call/result pairs inline, never their provider-side handles.
// Retain the active invocation's context, and never modify the saved transcript.
export function portableHeadlessHistory(messages, sourceMessageId) {
  const boundary = sourceMessageId ? messages.findIndex(message => message.role === 'user' && message.id === sourceMessageId) : -1;
  // An OpenCode context window can start after the invocation. With no exact
  // boundary, inline what remains rather than risk sending foreign handles.
  const start = boundary < 0 ? messages.length : boundary;
  const history = messages.slice(0, start).flatMap(message => {
    const clean = portableRecord(message);
    const content = message.content.flatMap(part => {
      const portable = portableRecord(part);
      if ((part.type === 'compaction' && part.encrypted !== undefined) ||
          (part.type === 'reasoning' && portable !== part)) return [];
      return [portable];
    });
    if (content.length === message.content.length && content.every((part, i) => part === message.content[i])) return [clean];
    return content.length ? [{ ...clean, content }] : [];
  });
  return [...history, ...messages.slice(start)];
}
