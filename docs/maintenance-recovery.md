# Administrative recovery without journal edits

Compatible code upgrades do not depend on work settlement. Use recovery when the
human actually wants to withdraw stale bookkeeping, not to make an upgrade pass.
Database migrations retain their quiescence and integrity requirements.

## Human assignment handback

```sh
herdr-relay native execution handback EXECUTION_ID --revision N \
  --reason 'Human owner takes over this assignment' --key owner-handback-v1
```

This human-only backend operation is revisioned and idempotent. It returns the
task to Todo, withdraws the assignment as cancelled and supersedes its unanswered
questions without fabricating answers. It does not discard submitted results or
silently withdraw active child assignments. Native completion and process
termination are not claimed. A terminal backend assignment with unresolved native
evidence is tracked locally as `terminal_unresolved`, not apparently running or
silently converted into successful settlement.

## Local record inspection and abandonment

```sh
herdr-relay node recover list
herdr-relay node recover work EXECUTION_ID \
  --reason 'Cancelled assignment retained an input conflict' --key local-work-v1
herdr-relay node recover publication ORIGINAL_KEY \
  --reason 'Discard malformed rejected comment' --key bad-comment-v1
```

The work/publication commands preview only. Repeat the exact command with
`--preview-hash HASH --apply`. The local operator CLI verifies the pinned node and
backend, takes an integrity-checked backup and records the original record and an
immutable administrative receipt. It never restores a database or restarts
OpenCode. The recovery and upgrade locks prevent concurrent maintenance operations.

Work uses the distinct state `administratively_abandoned`. The original invocation,
conflicting observation, command, error and command hash remain intact. Abandonment
survives restart. Stale callbacks cannot turn it back into active work or dispatch
the old invocation. It does not stop native processes or undo effects already sent.
The CLI displays that warning before application and stores it in the disposition.

Work abandonment requires a current terminal backend execution, or a cancelled
local-only schedule whose occurrence never materialised in the backend. Unknown or
active assignments must be inspected and withdrawn first. Associated uncertain
publications must be reconciled, not erased through work abandonment. No successful
native terminal, result or process termination is manufactured.

Publication abandonment accepts only:

- A hash-verified transactional validation refusal.
- An inspected absent backend receipt plus an execution-revision fence that
  prevents the original command applying.

It does not infer non-application from HTTP status alone. Unknown 4xx responses,
operation-key collisions and unresolved transport uncertainty remain fenced.
Revision conflicts require inspection, not an automatic retry or a changed payload
under the original key. A proven refusal is not an uncertain external effect; an
unknown outcome is not quietly downgraded into a refusal.

## Headless payload validation

Tool, node and backend share operation-specific headless task payload schemas.
For `comment.create` the fields are `taskId`, `expectedRevision` and `body`.
An extra `reason` fails before durable enqueue with:

```text
Unsupported field: payload.reason
```

Malformed local input never acquires an outbox entry. Correct it before retrying.
If an older version already persisted a refusal, retain and inspect that original
command. Do not overwrite its payload under the same idempotency key.

New native publications distinguish `definitively_rejected`, `revision_conflict`
and `uncertain`. Applied backend receipts remain authoritative. Audited abandonment
is a local administrative disposition, not a result publication or grant change.

## Verification

Regression coverage includes cancelled backend projections, preserved invocation
and conflict evidence, unsupported fields before enqueue, definitive and uncertain
refusals, revision fences, idempotent CLI recovery and restart/no-replay behaviour.

`node scripts/verify-upgrade.mjs --active-work` additionally uses disposable real
backend/node/owned OpenCode processes, holds an active model turn across compatible
upgrade and rollback, checks the same process and execution continue once, and
retains conflicting publications without replay. Migration variants retain the
stricter guards. These fixtures never control the user's services or source work.
