import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { candidate } from './candidate.mjs';
import { canonical, digest, requireValue, text } from './protocol.mjs';

const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const clean = directory => git(directory, ['status', '--porcelain=v1', '--untracked-files=all']).length === 0;

function worktreeIdentity(resource) {
  const path = resource.request.path;
  const common = realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir']).trim()));
  const metadata = realpathSync(git(path, ['rev-parse', '--absolute-git-dir']).trim());
  requireValue(common === resource.commonDirectory && metadata === resource.gitDirectory &&
    realpathSync(path) === resource.realPath &&
    git(path, ['symbolic-ref', '--short', 'HEAD']).trim() === resource.request.branch,
  'resource_conflict', 'Owned worktree or repository identity changed', 409);
}

export function reconcileWorktree(store, input) {
  const resource = store.operation(`worktree:${text(input.key, 'key')}`);
  requireValue(resource && ['ready', 'retiring'].includes(resource.state), 'resource_not_ready', 'Existing owned resource required', 409);
  if (resource.gitDirectory && resource.realPath) { worktreeIdentity(resource); return resource; }
  const path = resource.request.path;
  const common = realpathSync(resolve(path, git(path, ['rev-parse', '--git-common-dir']).trim()));
  const expected = realpathSync(resolve(resource.request.repository, git(resource.request.repository, ['rev-parse', '--git-common-dir']).trim()));
  requireValue(common === expected && common === realpathSync(resource.commonDirectory) &&
    git(path, ['symbolic-ref', '--short', 'HEAD']).trim() === resource.request.branch,
  'resource_conflict', 'Legacy worktree no longer belongs to the recorded repository and branch', 409);
  const registered = git(resource.request.repository, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  requireValue(registered.includes(`worktree ${realpathSync(path)}`), 'resource_conflict', 'Git does not list this owned worktree', 409);
  return store.saveOperation({ ...resource, commonDirectory: common, realPath: realpathSync(path),
    gitDirectory: realpathSync(git(path, ['rev-parse', '--absolute-git-dir']).trim()), identityReconciledAt: new Date().toISOString() });
}

export function provisionWorktree(store, input, { pendingBinding = false } = {}) {
  const id = `worktree:${text(input.key, 'key')}`;
  const request = { repository: resolve(text(input.repository, 'repository')), path: resolve(text(input.path, 'path')),
    branch: text(input.branch, 'branch'), base: text(input.base ?? 'HEAD', 'base'), bindingId: text(input.bindingId, 'bindingId') };
  if (!pendingBinding) store.binding(request.bindingId);
  requireValue(!request.branch.startsWith('-') && !request.base.startsWith('-'), 'invalid_git_ref', 'Git refs cannot begin with a dash');
  git(request.repository, ['check-ref-format', '--branch', request.branch]);
  let operation = store.operation(id);
  if (operation) {
    requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Worktree key has different configuration', 409);
    requireValue(['intent', 'ready'].includes(operation.state), 'resource_retired', 'Worktree is retiring or retired', 409);
    if (operation.state === 'ready') {
      worktreeIdentity(operation);
      return operation;
    }
  } else {
    requireValue(!existsSync(request.path), 'path_occupied', 'Worktree path already exists', 409);
    const refs = git(request.repository, ['for-each-ref', '--format=%(refname)', `refs/heads/${request.branch}`]).trim();
    requireValue(!refs, 'branch_occupied', 'Worktree branch already exists', 409);
    operation = store.saveOperation({ id, runId: '', request, state: 'intent', baseCommit: git(request.repository, ['rev-parse', `${request.base}^{commit}`]).trim() });
  }
  if (!existsSync(request.path)) {
    const ref = git(request.repository, ['for-each-ref', '--format=%(objectname)', `refs/heads/${request.branch}`]).trim();
    if (ref) {
      requireValue(ref === operation.baseCommit, 'resource_conflict', 'Provisioned branch changed before worktree creation', 409);
      git(request.repository, ['worktree', 'add', request.path, request.branch]);
    } else git(request.repository, ['worktree', 'add', '-b', request.branch, request.path, operation.baseCommit]);
  }
  requireValue(git(request.path, ['symbolic-ref', '--short', 'HEAD']).trim() === request.branch,
    'resource_conflict', 'Worktree branch identity changed', 409);
  const common = realpathSync(resolve(request.path, git(request.path, ['rev-parse', '--git-common-dir']).trim()));
  const expected = realpathSync(resolve(request.repository, git(request.repository, ['rev-parse', '--git-common-dir']).trim()));
  requireValue(common === expected, 'resource_conflict', 'Worktree belongs to another repository', 409);
  return store.saveOperation({ ...operation, state: 'ready', commonDirectory: common,
    gitDirectory: realpathSync(git(request.path, ['rev-parse', '--absolute-git-dir']).trim()), realPath: realpathSync(request.path) });
}

export function finaliseWorktree(store, input) {
  const resource = store.operation(`worktree:${text(input.key, 'key')}`);
  requireValue(resource?.state === 'ready', 'resource_not_ready', 'Owned worktree must be ready', 409);
  const run = store.run(text(input.runId, 'runId'));
  requireValue(run.request.bindingId === resource.request.bindingId, 'resource_conflict', 'Result does not belong to the resource binding', 409);
  requireValue(!store.runs(resource.request.bindingId).some(item => item.nativeState !== 'settled'),
    'resource_busy', 'Binding still has unsettled native work', 409);
  requireValue(run.nativeState === 'settled' && run.settlement.outcome === 'completed' && run.result,
    'result_not_ready', 'Native result must settle before finalisation', 409);
  requireValue(input.candidate === run.result.candidate, 'stale_candidate', 'Submitted candidate must match', 409);
  const request = { resourceId: resource.id, runId: run.id, candidate: input.candidate, message: text(input.message, 'message') };
  const id = `commit:${digest([resource.id, run.id, input.candidate])}`;
  let operation = store.operation(id);
  if (operation) requireValue(canonical(operation.request) === canonical(request), 'operation_conflict', 'Finalisation payload changed', 409);
  const directory = resource.request.path;
  worktreeIdentity(resource);
  requireValue(candidate(directory).id === input.candidate, 'stale_candidate', 'Working bytes differ from submitted candidate', 409);
  if (operation?.state === 'recorded') {
    requireValue(git(directory, ['rev-parse', 'HEAD']).trim() === operation.commit, 'finalisation_changed', 'Worktree HEAD changed after finalisation', 409);
    return operation;
  }
  const head = git(directory, ['rev-parse', 'HEAD']).trim();
  if (!operation) operation = store.saveOperation({ id, runId: run.id, request, state: 'intent', parent: head });
  const marker = `Herdr-Relay-Finalisation: ${id}`;
  const message = git(directory, ['log', '-1', '--format=%B']);
  if (head !== operation.parent) {
    requireValue(message.split('\n').includes(marker) && git(directory, ['rev-parse', 'HEAD^']).trim() === operation.parent && clean(directory),
      'finalisation_uncertain', 'HEAD changed without matching finalisation evidence', 409);
  } else {
    git(directory, ['add', '--all']);
    requireValue(candidate(directory).id === input.candidate, 'stale_candidate', 'Candidate changed while staging', 409);
    requireValue(git(directory, ['diff', '--cached', '--name-only']).trim().length > 0, 'empty_candidate', 'No changes to commit');
    git(directory, ['commit', '-m', `${request.message}\n\n${marker}`]);
    requireValue(clean(directory) && candidate(directory).id === input.candidate,
      'finalisation_changed', 'Hooks or concurrent edits changed candidate bytes', 409);
  }
  return store.saveOperation({ ...operation, state: 'recorded', commit: git(directory, ['rev-parse', 'HEAD']).trim() });
}

export async function retireWorktree(store, input, verifyAcceptance) {
  const resource = store.operation(`worktree:${text(input.key, 'key')}`);
  requireValue(resource, 'resource_not_found', 'Unknown owned worktree', 404);
  const run = store.run(text(input.runId, 'runId'));
  requireValue(run.request.bindingId === resource.request.bindingId, 'resource_conflict', 'Result does not belong to the resource binding', 409);
  requireValue(!store.runs(resource.request.bindingId).some(item => item.nativeState !== 'settled'),
    'resource_busy', 'Binding still has unsettled native work', 409);
  requireValue(run.result?.candidate === input.candidate && run.nativeState === 'settled', 'stale_candidate', 'Settled exact candidate required', 409);
  // Refresh authority from Paperclip on every destructive retry.
  await verifyAcceptance(run);
  const finalisation = store.operation(`commit:${digest([resource.id, run.id, input.candidate])}`);
  requireValue(finalisation?.state === 'recorded', 'finalisation_required', 'Candidate must be committed before worktree removal', 409);
  requireValue(!store.runs(resource.request.bindingId).some(item => item.nativeState !== 'settled'),
    'resource_busy', 'Binding became active during acceptance verification', 409);
  if (resource.state === 'retired') return resource;
  const directory = resource.request.path;
  if (existsSync(directory)) {
    worktreeIdentity(resource);
    requireValue(git(directory, ['symbolic-ref', '--short', 'HEAD']).trim() === resource.request.branch &&
      git(directory, ['rev-parse', 'HEAD']).trim() === finalisation.commit,
    'resource_conflict', 'Worktree identity or commit changed', 409);
    requireValue(clean(directory), 'dirty_cleanup_blocked', 'Worktree has modified or untracked files', 409);
    // Ignored files are not candidates, but must not be silently deleted either.
    requireValue(!git(directory, ['ls-files', '--others', '--ignored', '--exclude-standard']).trim(),
      'dirty_cleanup_blocked', 'Worktree has ignored files', 409);
    requireValue(candidate(directory).id === input.candidate, 'stale_candidate', 'Worktree no longer matches accepted candidate', 409);
    store.saveOperation({ ...resource, state: 'retiring', acceptedRunId: run.id, commit: finalisation.commit });
    git(resource.request.repository, ['worktree', 'remove', directory]);
  } else requireValue(resource.state === 'retiring', 'resource_missing', 'Worktree disappeared without retirement intent', 409);
  // Branch deletion is a separate action. The committed result remains reachable.
  return store.saveOperation({ ...resource, state: 'retired', acceptedRunId: run.id, commit: finalisation.commit });
}
