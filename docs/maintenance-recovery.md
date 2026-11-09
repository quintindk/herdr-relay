# Administrative recovery without journal edits

Compatible code upgrades do not depend on work settlement. Use recovery when the
human actually wants to withdraw stale bookkeeping, not to make an upgrade pass.
Cross-schema database migrations are unsupported.

## Changed OpenCode project identity

`native_project_identity_changed` means the same OpenCode conversation, directory
and creation time now report a different project ID from Relay's pinned binding.
Interactive preparation stops before enqueue and returns explicit recovery steps:

1. Ask the human to run `/relay-attach` in the **existing initiating chat** and
   confirm the **same Relay enrolment**. Do not enrol a duplicate agent.
2. Wait for the attachment to be confirmed. The error does not authorise an agent
   to update identity pins, change permissions or perform attachment itself.
3. Retry `relay_interactive_prepare` with the original ID, key and payload, reusing
   the existing worktree. Review any resulting permission request in Grants.

A wider `native_identity_mismatch` requires inspection of the exact conversation
and workspace first. It does not get the project-only attachment shortcut.
`native_model_unavailable` instead asks the human to resolve the current model
and check the existing attachment before retrying. Do not use the backend-admin
CLI, copy credentials, create another worktree or restart OpenCode to bypass these
checks. Managed/headless bindings require their own coordinator inspection, not
interactive reattachment.

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

## Refused attachment binding recovery

A refused attachment can retain a prepared binding without ever designating its
conversation. Older nodes attempted to load that retained evidence as a receiver,
so a `conversation_alias` refusal could block the refresh of unrelated agents.

```sh
herdr-relay node recover attachment ORIGINAL_ATTACHMENT_KEY \
  --reason 'Retire the refused binding blocking receiver refresh' --key attachment-recovery-v1
```

Review the preview, then repeat the same command with `--preview-hash HASH --apply`.
The local operator CLI checks the exact refused command and binding, confirms the
backend designates a different binding, rechecks ownership after an integrity-checked
backup, and records a separate immutable retirement receipt. The original attachment
remains `refused`. Its binding, command and error are not deleted or rewritten, and
the current agent and receiving chat remain unchanged.

Confirmed, uncertain, designated, explicitly configured, headless, work-pinned or
notice-pinned bindings are ineligible. The running node honours the retirement
marker on its next binding refresh. No OpenCode restart, prompt replay, native
settlement or process termination is involved. Repeat application returns the
original receipt.

A later, separately confirmed attachment cannot reuse the retired binding ID,
even if it targets the same conversation and generation. Its new operation key
pins a distinct binding while the refused attempt and retirement remain intact.

Current node loading excludes validated, unreferenced refused bindings directly,
so ordinary attachment refusals do not require manual recovery. Upgrade checks
continue to inspect both legacy and workspace-scoped terminal outboxes. Pending
keyboard decisions must still be resolved rather than discarded to force reload.

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
retains conflicting publications without replay. These fixtures never control the
user's services or source work.
