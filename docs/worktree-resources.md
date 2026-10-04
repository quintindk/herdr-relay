# Owned worktree resources

Operator-only commands provision and finalise owned Git worktrees:

```bash
herdr-relay resource provision --file worktree.json
herdr-relay resource finalise --file finalisation.json
herdr-relay resource retire --file retirement.json
```

Provisioning requires an existing binding and a fresh path and branch:

```json
{
  "key": "graph-worker-1",
  "bindingId": "graph-worker",
  "repository": "/absolute/repository",
  "path": "/absolute/worktrees/graph-worker-1",
  "branch": "relay/graph-worker-1",
  "base": "main"
}
```

The operation records the resolved base commit before Git changes. Repeating the
same key reconciles the owned branch and worktree. Existing unrelated paths and
branches conflict. The command creates only a Git resource, not an agent runtime.

Finalisation input contains `key`, `runId`, `candidate` and `message`. It requires
the bound worker's native execution to have settled and its submitted candidate
to match the current working bytes. It stages and commits those bytes under the
operator's authority, using configured Git identity and normal hooks. A durable
commit trailer allows recovery after a crash between commit and receipt storage.
Changed HEAD, candidate or finalisation input blocks replay. No empty commits.

Retirement input contains `key`, `runId`, `candidate` and `callerRunId` identifying
a reviewer run whose backend credentials can read acceptance. Every retry refreshes
the exact candidate's Paperclip review disposition. All work on the resource's
binding must be settled. Dirty, untracked or ignored files block cleanup. The
operation persists retirement intent before removing the owned worktree.

Branch deletion is separate and not performed. The final commit stays reachable.
This increment does not stop a native server or close a herdr pane. Runtime
retirement needs verified process/placement ownership and remains separate work.

Tests use a real disposable Git repository, retry provisioning and finalisation,
simulate a lost commit receipt, reject unaccepted or dirty cleanup, and verify the
retained branch after repeatable worktree removal.
