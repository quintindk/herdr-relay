# Lifetimes and verified continuation

Bindings may declare `lifetime` as `persistent`, `service` or `task`. Omission retains
the original persistent behaviour. Task-scoped bindings also require a `taskId`
and a same-company `controllerBindingId`. Optional `worktreeKey` identifies the
owned worktree to clean up after acceptance.

Task-scoped bindings refuse other tasks. After submission, a new invocation is
blocked until the current candidate has a recorded rejection. Acceptance observed
by the lifecycle controller triggers retirement. Acceptance remains authoritative
in Paperclip if shutdown or cleanup fails. Durable `retirement:RUN_ID` operations
record blockers. Retry with `result retire CONTROLLER_RUN --file review.json`.

Retirement refreshes exact candidate acceptance, requires all bound turns to have
settled, and requires recorded commit finalisation for worktree-backed workers.
It prevents further dispatch before stopping a managed runtime. Owned OpenCode
servers can be stopped. Pull bindings have no runtime owned by Relay. Shared native
servers cannot be retired by this path. Worktree cleanup follows separately and
preserves dirty or ignored files. Persistent peers are unaffected.

Service windows are implemented by [bounded schedules](schedules.md), and owned
Hermes retirement is supported. When `--backend-context` is configured,
Relay polls registered task-candidate reviews and resumes acceptance-driven
retirement after restart. The original controller binding is preserved. Dirty
cleanup remains blocked without changing accepted outcome.

## Rebinding

For an orphaned controller, the operator can use `agent controller --file FILE`
with `id`, current `revision` and a new `controllerBindingId`. The replacement must
be active, independent and in the same company. Unsettled worker execution blocks
transfer. History is retained and the revision increments. Update the backend
adapter revision before dispatching again.

`agent rebind --file continuation.json` is operator-only. It verifies the new
native endpoint, requires an idle target and no unsettled Relay work, preserves the
exact stored conversation and harness, and increments the binding revision.
Credentials remain stable. Prior binding configurations are retained in history.

The file contains the binding `id`, current `revision`, exact `conversationId`,
`harness`, new `instanceId`, and the full updated `opencode` or `hermes` configuration.
For Hermes, explicitly resume the existing stored session first and supply its new
runtime ID and gateway replay epoch. Relay never guesses a replacement conversation.

Update Paperclip's `bindingRevision` after rebinding. Old revision dispatches are
rejected. Managed bindings use the separate `runtime resume` contract described in
[managed runtimes](managed-runtimes.md).
