import { existsSync, readFileSync, realpathSync, statSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, requireValue } from './protocol.mjs';
import { validateContractFiles, contractDigest } from './headless-contract.mjs';

const getOp = (journal, id) => {
  const row = journal.db.prepare('SELECT value FROM settings WHERE key=?').get(`headless-op:${id}`);
  requireValue(row, 'job_contract_missing', 'Original authorised contract digest is missing');
  return JSON.parse(row.value);
};
const saveOp = (journal, id, op) => journal.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(op), `headless-op:${id}`);
function exactPath(directory, relative) {
  const path = join(directory, relative);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  requireValue(realpathSync(directory) === directory && realpathSync(dirname(path)) === dirname(path) &&
    (!entry || !entry.isSymbolicLink() && entry.isFile() && realpathSync(path) === path), 'job_contract_missing', 'Contract paths must be canonical files without symlink redirection');
  return path;
}
export function inspectContract(journal, setup, grant) {
  const op = getOp(journal, setup.id), paths = op.contractManifest ?? [{ path: grant.contract, digest: op.contractDigest }];
  const files = paths.map(file => {
    const path = exactPath(setup.directory, file.path);
    requireValue(existsSync(path), 'job_contract_missing', 'Pinned instruction resource is missing');
    const content = readFileSync(path, 'utf8');
    requireValue(digest(content) === file.digest, 'job_contract_changed', 'The authorised job contract changed; reauthorisation required');
    return { path: file.path, content };
  });
  return { contractRevision: op.contractRevision ?? 0, contractDigest: op.contractManifest ? digest(op.contractManifest) : op.contractDigest,
    contractFiles: paths, contractInstructions: files.map(f => `Instructions: ${f.path}\n${f.content}`).join('\n\n') };
}

export function previewContractUpdate(journal, setup, grant, candidates) {
  requireValue(Array.isArray(candidates) && candidates.every(f => f && Object.keys(f).every(k => ['path', 'content'].includes(k)) && typeof f.content === 'string'),
    'invalid_contract_update', 'Supply exact candidate paths and Markdown content only');
  // Validate relative paths before resolving anything on the filesystem.
  validateContractFiles(candidates.map(f => ({ path: f.path, before: null, after: f.content })), grant.contract);
  const current = inspectContract(journal, setup, grant);
  const files = candidates.map(f => { const path = exactPath(setup.directory, f.path); return { path: f.path, before: existsSync(path) ? readFileSync(path, 'utf8') : null, after: f.content }; });
  validateContractFiles(files, grant.contract);
  const operation = { setupId: setup.id, expectedRevision: setup.revision, grantRevision: grant.revision,
    fromDigest: current.contractDigest, files, scopeDigest: digest(grant) };
  return { previewHash: digest(operation), toDigest: contractDigest(files), ...operation,
    capabilitiesUnchanged: true, instructionRevisionOnly: true,
    businessScopeReview: 'Review the exact content against the existing job purpose. This update cannot grant scope or capability expansion.' };
}

// Approval fences new admissions at the backend. A write-ahead local marker and
// before/after checks make a multi-file activation resumable after any rename.
export async function tickHeadlessContractUpdates(journal, api, resolveBinding) {
  for (const row of journal.db.prepare("SELECT value FROM settings WHERE key LIKE 'headless-setup:%'").all()) {
    const cached = JSON.parse(row.value);
    if (!cached.contract || cached.appliedContractRevision === cached.contract.revision) continue;
    let op;
    try {
      const { setup, grant } = await api('GET', `/v1/headless_setups/${cached.id}/authority`);
      op = getOp(journal, setup.id);
      const key = `contract-applied:${setup.id}:${setup.contract.revision}`;
      const receipt = journal.receipt(key);
      if (receipt?.state === 'recorded') continue;
      if (receipt?.state === 'pending') { await journal.flush(api); continue; }
      const active = journal.works().filter(w => w.execution.targetAgentId === setup.agentId);
      if (active.some(w => !['completed', 'cancelled', 'failed', 'rejected'].includes(w.execution.state) || ['conflict', 'uncertain', 'intent', 'observing'].includes(w.state))) continue;
      const ids = new Set(active.map(w => w.id));
      if (journal.db.prepare("SELECT data FROM outbox WHERE state IN ('pending','conflict')").all().some(r => {
        const p = JSON.parse(r.data).command.payload; return ids.has(p.id ?? p.executionId);
      })) continue;
      const binding = await resolveBinding(setup.agentId);
      if (!binding || binding.id !== setup.bindingId) continue;
      const snapshot = await binding.native.snapshot();
      if (!snapshot.idle || snapshot.inbox.length) continue;
      const request = await api('GET', `/v1/grant_requests/${setup.contract.requestId}`), p = request.operation;
      requireValue(request.state === 'approved' && request.kind === 'headless_contract' && digest(grant) === p.scopeDigest &&
        contractDigest(p.files) === setup.contract.digest && setup.contractActivation.previousDigest === p.fromDigest,
      'stale_contract_preview', 'Exact approved bundle and unchanged grant required');
      validateContractFiles(p.files, grant.contract);
      const resuming = op.contractActivation?.requestId === request.id && ['applying', 'files_applied'].includes(op.contractActivation.state);
      if (!resuming) {
        requireValue(inspectContract(journal, setup, grant).contractDigest === p.fromDigest, 'stale_contract_preview', 'Active instructions changed after preview');
        for (const f of p.files) {
          const path = exactPath(setup.directory, f.path), current = existsSync(path) ? readFileSync(path, 'utf8') : null;
          requireValue(current === f.before, 'stale_contract_preview', 'Instruction resource changed after approval');
        }
        op = { ...op, contractActivation: { state: 'applying', requestId: request.id } }; saveOp(journal, setup.id, op);
      }
      for (const f of p.files) {
        const path = exactPath(setup.directory, f.path), current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        requireValue(current === f.before || current === f.after, 'stale_contract_preview', 'Instruction resource changed during activation');
        if (current === f.after) continue;
        const temporary = join(dirname(path), `.relay-contract-${digest([request.id, f.path])}.new`);
        if (!existsSync(temporary)) {
          const fd = openSync(temporary, 'wx', existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
          try { writeFileSync(fd, f.after); fsyncSync(fd); } finally { closeSync(fd); }
        }
        requireValue(realpathSync(temporary) === temporary && readFileSync(temporary, 'utf8') === f.after, 'operation_conflict', 'Activation temporary file differs');
        requireValue((existsSync(path) ? readFileSync(exactPath(setup.directory, f.path), 'utf8') : null) === current,
          'stale_contract_preview', 'Instruction resource changed while preparing the atomic rename');
        renameSync(temporary, path);
        const fd = openSync(dirname(path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      op = { ...op, contractRevision: setup.contract.revision, contractManifest: setup.contract.files,
        contractDigest: digest(p.files.find(f => f.path === grant.contract).after), contractBlocker: null,
        contractActivation: { state: 'files_applied', requestId: request.id } };
      saveOp(journal, setup.id, op);
      journal.queue({ key, action: 'headless.contract_applied', payload: { id: setup.id, expectedRevision: setup.revision, requestId: request.id, digest: setup.contract.digest } });
      await journal.flush(api);
    } catch (error) {
      if (op) saveOp(journal, cached.id, { ...op, contractBlocker: /^[a-z][a-z0-9_]{1,95}$/.test(error.code ?? '') ? error.code : 'contract_activation_unavailable' });
    }
  }
}
