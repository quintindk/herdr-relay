# Coordinator Review

Experimental, opt-in coordinator review is implemented and offline-tested. Live
tests are deferred at the user's request. The final workflow is not fully verified,
and complete autonomous recovery is not implemented.

## Explicit Human Grant

The parent must be a recorded native-origin root task with final review fixed to
`human` (omission also means human). Its assigned coordinator must be a separate,
armed OpenCode conversation in the same company. Only the exact originating human
chat may grant authority. An active worker cannot grant itself authority.

State the parent, assigned reviewer and direct-child scope visibly, then obtain
explicit human authorisation before calling:

```json
{
  "key": "review-direct-children-1",
  "parentTaskId": "RECORDED_ROOT_TASK_ID",
  "reviewerBindingId": "EXACT_PARENT_ASSIGNEE_BINDING_ID"
}
```

These are `relay_coordinator_grant` arguments. Retain its returned `grantId`.
The grant pins company, parent, origin and reviewer binding/revision/native session.
Retries must retain the same key, immutable request and human source message.
Neither a permission popup, fan-out instruction, notification nor worker output
substitutes for explicit human consent. Never silently issue a grant.

`relay_coordinator_revoke` takes `{"grantId":"EXACT_GRANT_ID"}` from that same
origin chat with a later explicit human message. Revoked grants cannot be
reactivated. Revocation does not require the reviewer or parent to remain live,
and does not undo already confirmed decisions.

## Opt In Each Child

The grant does not change existing tasks. Each new direct child must explicitly
select `relayReviewPolicy: "coordinator"` and reference the grant at creation:

| Route | Parent field | Grant field |
| --- | --- | --- |
| Origin chat `relay_delegate` | `parentTaskId` | `grantId` |
| Worker `task create PARENT_RUN --key KEY --file child.json` | `parentId` | `relayReviewGrantId` |

The child must be assigned to another agent, not the parent reviewer. Backend-only
parent links, grandchildren and inferred grants confer no authority. Recorded
creation policy and grant reference are immutable. Omitted policy remains human,
even beneath a granted parent. `agent_decides` only selects human/no-review with a
reason. It is not coordinator review and cannot be used for the granted parent.

The parent learns available grants through `work read PARENT_RUN`, under
`task.coordinatorReviewGrants`, with `grantId`, `scope: "direct_children"` and
`parentTaskId`. Missing or invalid authority is not permission to improvise.
Use the supplied worker context, acknowledge the current parent run, and create
children only if fan-out is authorised. Example worker payload:

```json
{
  "title": "Review assigned scope",
  "description": "Read-only review. Report defects and checks. No commits or provisioning.",
  "assigneeAgentId": "EXACT_DISCOVERED_PEER_AGENT_ID",
  "parentId": "CURRENT_PARENT_TASK_ID",
  "status": "todo",
  "relayReviewPolicy": "coordinator",
  "relayReviewGrantId": "GRANT_ID_FROM_WORK_READ"
}
```

Use the existing child-wait protocol and finish the turn after recording the wait.
Preparation, grant creation and task creation are separate operations.

## Inspect And Decide

On an admitted parent continuation, read and acknowledge its exact run. Use
`task inspect PARENT_RUN --task CHILD_ID` for each child. Its `relayReview` contains
the submitted `runId`, `candidate`, `summary`, review `state`, `interactionId` and
applicable active `grantId`. Null fields or an inspection response alone do not
prove review readiness or authority.

Review the actual work and check evidence. For filesystem candidates, independently
recapture the digest with `candidate inspect --directory REPOSITORY_ROOT`. Use
`result inspect PARENT_RUN --file review.json`, then `result accept` or `result
reject` with the same exact target and a specific reason, required for both decisions
(at most 4,000 characters):

```json
{
  "runId": "CHILD_SUBMITTED_RELAY_RUN_ID",
  "candidate": "EXACT_SUBMITTED_CANDIDATE",
  "reason": "Describe the inspected work, checks and basis for this decision."
}
```

`PARENT_RUN` is the caller, not the child run. The file's `runId` names the child
submission. Relay resolves the exact candidate interaction and grant, rather than
taking review authority from caller-supplied IDs. Do not substitute a human reviewer
or reassign the child to make the call succeed.

Only the current claimed, acknowledged parent run in the granted binding revision
and native conversation may decide. It must have no submitted final result or
cancellation. The child must have its latest candidate settled and published, with
no unsettled invocation. Relay records decision intent before sending and requires
backend resolver proof matching the exact coordinator agent and backend run, with
no user resolver. Backend `accepted` status alone is not proof. Unconfirmed decisions
must not be reposted. Identical retries may reconcile a committed decision, not
repeat a pending mutation.

## Notices And Follow-Up

A settled, published child awaiting review can trigger a machine-labelled
`candidate_ready` comment on the parent through the backend's standard comment
wake path. It requires the exact parent to be waiting for that child, a valid grant,
fresh native readiness and matching backend scope. The comment names parent, child,
submitted run, candidate, interaction and grant. It is informational, not approval
or human authority, and does not clear dependency blockers.

A read-back comment receipt is `recorded`, not proof that a parent turn was admitted.
It remains `continuationState: "awaiting_admission"` with
`reason: "continuation_unconfirmed"`, even if a later local parent invocation exists.
An uncertain POST is reconciled by reading the exact comment receipt, never by
automatic repost. Report pending/unconfirmed continuation rather than claiming
delivery or complete recovery. This is separate from UI-only origin toasts.

Confirmed acceptance can proceed through guarded completion. Rejection requires
explicit follow-up to arrange authorised rework. No automatic rejection/rework wake
is implemented. Do not resubmit, reopen, duplicate tasks or mark them Done as a
shortcut. The parent's final candidate still requires human review.

## Human Recovery And Legacy Cards

- Existing `relay_reviews` / `relay_review` human override remains available for an
  exact pending candidate in its authorised chat, including the recorded origin.
  Present the candidate and obtain an explicit human decision. A coordinator intent
  for that candidate blocks a conflicting human decision, and vice versa.
- Revocation before a review interaction is recorded permits a `human_only`
  recovery disposition when the exact original creation scope remains valid. It
  retains coordinator policy metadata with `reviewerMode: "human_recovery"`, but
  grants no agent decision rights. Revocation does not rewrite an existing card or
  establish a general automatic recovery path.
- New human cards require `human_only`. Existing legacy `anyone` cards do not grant
  agent authority and are not silently migrated. They require explicit human review
  through the existing route. Reconciliation accepts their decision only with an
  exact recorded human source and matching candidate/interaction receipt, not a
  bare backend status.
- Acceptance grants no commit, merge, push, cleanup or worker-termination rights.

## Verification Boundary

Offline fixtures cover grants/revocation, child creation, exact reviewer authority,
resolver proof, human override/recovery, legacy constraints and notice uncertainty.
They do not certify the installed plugin, live backend wake admission, rejection
follow-up or a complete parent/child round trip. No live tests, global installation
changes or service restarts are part of this documentation update.

Sources: `src/coordinator-review.mjs`, `src/coordinator-notices.mjs`,
`src/review.mjs`, `src/disposition.mjs`, `src/harness-answers.mjs`,
`src/operations.mjs`, `src/service.mjs` and `src/opencode-bridge-plugin.mjs`.
See [interactive workers](interactive-workers.md) and the
[worker protocol](../skills/relay-work/SKILL.md).
