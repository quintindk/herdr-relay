import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { digest, canonical, requireValue } from '../../src/protocol.mjs';
import { launchOwnedV2 } from './owned-runtime.mjs';
import { NativeOpenCodeV2, observeV2 } from './native.mjs';

// Separate owned v2 path. Stored configuration/session IDs survive repeated
// provisioning calls. Launch/session uncertainty is reconciled, never replaced.
export async function provisionOwnedV2({ stateDirectory, bindingId, agentId, executable, workspace, config, workerContextFile, resume = false }) {
  const directory = join(resolve(stateDirectory), 'managed', digest(bindingId));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const request = { bindingId, agentId, executable: resolve(executable), workspace: resolve(workspace), config, workerContextFile };
  const receiptPath = join(directory, 'provision.json');
  let receipt;
  if (existsSync(receiptPath)) {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    requireValue(canonical(receipt.request) === canonical(request), 'provision_conflict', 'Managed binding configuration changed');
  } else {
    receipt = { request, state: 'intent', sessionId: `ses_${digest([bindingId, agentId, directory]).slice(0, 32)}` };
    writeFileSync(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  }
  const plugin = fileURLToPath(new URL('.', import.meta.url));
  const runtime = await launchOwnedV2({ directory: join(directory, 'runtime'), executable, workspace, resume,
    config: { ...config, plugins: [...(config.plugins ?? []), { package: plugin, options: { workerContextFile } }] } });
  let session;
  try { session = await runtime.client.session.get({ sessionID: receipt.sessionId }); }
  catch (error) {
    requireValue(error._tag === 'SessionNotFoundError' || error.status === 404 || error._tag === 'NotFoundError',
      'session_lookup_failed', 'Managed session lookup failed without a definitive not-found receipt');
    requireValue(receipt.state === 'intent', 'session_creation_uncertain', 'Prior session create must reconcile before another attempt');
    receipt = { ...receipt, state: 'uncertain' };
    writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    session = await runtime.client.session.create({ id: receipt.sessionId, location: { directory: request.workspace }, title: `Relay ${agentId}` });
  }
  requireValue(session.id === receipt.sessionId && session.location.directory === request.workspace, 'native_identity_mismatch', 'Managed session scope changed');
  const identity = { sessionId: session.id, projectId: session.projectID, directory: session.location.directory, createdAt: session.time.created };
  if (receipt.identity) requireValue(canonical(receipt.identity) === canonical(identity), 'native_identity_mismatch', 'Managed session identity changed');
  receipt = { ...receipt, state: 'ready', identity };
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const native = new NativeOpenCodeV2(runtime.client, identity);
  return { id: bindingId, identity, runtime, native, observe: observeV2,
    interrupt: () => runtime.interrupt(identity.sessionId) };
}
