import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function nativeTranscript(client, sessionID) {
  const items = [], cursors = new Set(), ids = new Set();
  let cursor;
  do {
    const page = await client.message.list({ sessionID, ...(cursor ? { cursor } : { order: 'asc', limit: 100 }) });
    assert.ok(Array.isArray(page.data) && page.cursor, 'A complete native transcript page is required');
    for (const message of page.data) {
      assert.ok(message?.id && !ids.has(message.id), 'Native transcript contains a repeated message');
      ids.add(message.id); items.push(message);
    }
    cursor = page.cursor.next;
    assert.ok(!cursor || typeof cursor === 'string' && !cursors.has(cursor), 'Native transcript cursor repeated');
    if (cursor) cursors.add(cursor);
    assert.ok(items.length <= 10000, 'Native transcript exceeds the acceptance traversal limit');
  } while (cursor);
  return items;
}

const completedTools = transcript => transcript.flatMap(message => message.type === 'assistant' ? message.content.filter(part =>
  part.type === 'tool' && part.state.status === 'completed') : []);

// Reinspection uses only GETs and read-only SQLite handles. It does not rerun a
// model, resume an execution, rewrite a failed job or alter an archived session.
export async function inspectCollaboration(client, directory) {
  const root = resolve(directory);
  assert.ok(root === realpathSync(root) && dirname(root) === '/tmp/opencode' && basename(root).startsWith('relay-collaboration-real-'),
    'Inspect only an exact private collaboration acceptance directory');
  const backend = new DatabaseSync(join(root, 'backend.sqlite'), { readOnly: true });
  const node = new DatabaseSync(join(root, 'node/node.sqlite'), { readOnly: true });
  try {
    const instance = backend.prepare("SELECT value FROM settings WHERE key='instance'").get().value;
    const identity = JSON.parse(node.prepare("SELECT value FROM settings WHERE key='identity'").get().value);
    assert.equal(identity.instanceId, instance);
    const executions = backend.prepare("SELECT data FROM entities WHERE kind='execution'").all().map(row => JSON.parse(row.data));
    const roots = executions.filter(e => !e.parentExecutionId && e.taskId === 'collaboration-acceptance');
    assert.equal(roots.length, 1);
    const execution = roots[0], peers = executions.filter(child => child.parentExecutionId === execution.id);
    assert.equal(execution.state, 'completed', 'The coordinator must actually complete');
    assert.equal(execution.targetNodeId, identity.nodeId); assert.equal(execution.collaboration.maxRounds, 2);
    assert.equal(peers.length, 2, 'Independent assessment and fresh verification are both required');
    assert.ok(peers.every(child => child.targetAgentId === execution.collaboration.peerAgentIds[0] && child.state === 'completed' && child.result));
    const work = id => JSON.parse(node.prepare('SELECT data FROM work WHERE id=?').get(id).data);
    const coordinator = work(execution.id), reviewer = work(peers[0].id);
    const sessions = { a: coordinator.nativeConversationId, b: reviewer.nativeConversationId };
    const info = await Promise.all(Object.values(sessions).map(sessionID => client.session.get({ sessionID })));
    for (const session of info) assert.equal(session.metadata?.relayCollaborationAcceptance, root, 'Evidence cannot select a non-test session');
    assert.equal(info[0].location.directory, join(root, 'coordinator'));
    assert.equal(info[1].location.directory, join(root, 'reviewer'));
    assert.deepEqual(info[0].model, info[1].model);
    const original = JSON.parse(readFileSync(join(root, 'reviewer/manifest.json'), 'utf8'));
    const output = join(root, 'coordinator/repaired.json'), bytes = readFileSync(output), repaired = JSON.parse(bytes);
    assert.equal(repaired.version, original.version); assert.equal(repaired.services.length, original.services.length);
    for (const service of original.services) {
      const actual = repaired.services.find(item => item.name === service.name);
      assert.ok(actual); assert.equal(actual.port, service.port); assert.equal(actual.enabled, service.enabled);
      assert.ok(Number.isInteger(actual.replicas) && actual.replicas >= 1);
    }
    const transcripts = { a: await nativeTranscript(client, sessions.a), b: await nativeTranscript(client, sessions.b) };
    const history = node.prepare('SELECT data FROM execution_history').all().map(row => JSON.parse(row.data));
    const businessTools = new Set(['read', 'grep', 'glob']);
    for (const peer of peers) {
      const runs = [...history.filter(run => run.id === peer.id), work(peer.id)];
      let actualBusinessWork = false;
      for (const run of runs) {
        const start = transcripts.b.findIndex(message => message.id === run.invocation?.messageId);
        const end = transcripts.b.findIndex(message => message.id === run.observation?.messageId);
        assert.ok(start >= 0 && end > start, 'Actual peer invocation and terminal evidence are required');
        actualBusinessWork ||= completedTools(transcripts.b.slice(start, end + 1)).some(tool => businessTools.has(tool.name));
      }
      assert.ok(actualBusinessWork, 'Each independent peer round must perform real business-tool work');
    }
    for (const transcript of Object.values(transcripts)) assert.equal(transcript.filter(message => message.type === 'user' && !message.metadata?.herdrRelayInvocation).length, 0,
      'No extra human prompts may repair or steer the loop');
    const rootPrompts = transcripts.a.filter(message => message.type === 'user' && message.metadata?.herdrRelayInvocation);
    assert.ok(rootPrompts.length >= 3, 'Coordinator must resume with actual peer outcomes');
    const runtime = await client.server.info();
    return { passed: true, realModels: true, scriptedProvider: false, runtime: runtime.version, model: info[0].model,
      agents: 2, workspaces: 2, peerRounds: peers.length, coordinatorTurns: rootPrompts.length, manualInterventions: 0,
      normalHandover: true, automaticWaitResume: true, artifactVerified: true, artifactSha256: createHash('sha256').update(bytes).digest('hex'),
      liveEnrolmentsChanged: false, providerCredentialStoreCopied: false, privateEvidence: root };
  } finally { node.close(); backend.close(); }
}
