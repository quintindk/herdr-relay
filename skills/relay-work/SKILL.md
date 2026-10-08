---
name: relay-work
description: Use for assigned Herdr Relay work, peer discovery, clarification and result submission through the Relay CLI. Requires a provisioned Relay context.
license: MIT
---

# Relay work protocol

Use `herdr-relay --context "$RELAY_CONTEXT"` or the exact CLI command supplied by
the runtime. The context file holds credentials. Do not print or copy its contents.

## Read Scope

- In an assigned run, `task list RUN` reads the company backlog under the worker's
  backend authority. `work list` lists invocations, not the general backlog.
  Reading a task does not assign it or authorise work outside the current brief.
- In a human chat, use `relay_tasks` for morning/general backlog lookup, including
  human-owned and imported tasks and description previews. `relay_delegations`
  returns only that exact origin chat's delegated work. Neither it nor
  `relay_reviews` substitutes for the backlog.
- Configured busy bridges can read `relay_agents`, `relay_tasks`,
  `relay_delegations` and notification history without enabling incoming work.
  Discovery on tool invocation waits up to 12 seconds for the exact credential,
  never grants enrolment. After a transient startup timeout, pause briefly and
  retry the read once, then report the limitation and continue independent startup
  checks. Missing tools need a plugin reload at idle, not a forced restart.
- Workers must not enrol themselves, obtain operator credentials or widen folder
  defaults. Human-authorised `relay_enrol_agent`/operator `agent enrol` creates a
  standing folder reservation, not an assignment. Linked worktrees and worker
  directories require `relay_worker_prepare` adoption outside an active run.
  See `skills/herdr-relay/SKILL.md` for the authority and recovery boundaries.

## Execute Assigned Work

1. `agent discover` lists registered peers in your company. Discovery does not
   confer authority to stop them or make them your reports.
2. `work list` lists your invocations. Select the explicit run ID supplied with
   the assignment. Never guess the newest task when more than one exists.
3. `work read RUN` fetches current task content through Relay.
4. `work interactions RUN` reads prior questions and answers for that task.
5. `work acknowledge RUN` claims the turn before executing task work.
6. If clarification is required, write the question to a file and use
   `work ask RUN --key QUESTION_KEY --question-file FILE`. Finish your native turn
   after the receipt. Do not poll indefinitely, submit a result or keep working on
   that obligation while waiting. Paperclip owns the answer and continuation.
7. Otherwise execute the work, verify it and write a summary identifying actual
   deliverables and checks. Submit with
   `work submit RUN --key SUBMISSION_KEY --summary-file FILE --candidate CANDIDATE_ID`.
8. Stop editing the candidate after submission and finish your turn. Submission is
    not acceptance, commit authority or permission to terminate a runtime.

`work read` includes `task.relayReviewPolicy`. Respect fixed `human`, `none` or
`coordinator` policy. For `agent_decides`, submit via `--file` with a `reviewDecision` object
containing `mode: "none"` or `mode: "human"` and a specific `reason`. Use judgement
based on the task and consequences. No-review still requires verified completion
and publication; it does not bypass tool permissions or authorise external effects.
When creating a delegated child, choose its `relayReviewPolicy` explicitly.
Missing policy retains human review. The worker cannot downgrade a fixed policy.
Experimental coordinator review requires a prior explicit human grant and a child
opted in at creation. `agent_decides` is not coordinator authority. Inspecting a
child's result is not human approval and never permits self-acceptance. The root
parent's final review remains human. Never silently obtain or infer a grant.

Retry identical requests with the same key. A changed payload requires a distinct
attempt, not reuse of an old key. If a request is uncertain, inspect the exact run
using `work inspect RUN` before proceeding. Respect cancellation and stop editing.

Native completion, result publication, review and acceptance are separate states.
Only the operator or verified harness observer can settle native execution. Never
use an idle-looking UI or a failed Paperclip run as proof that execution stopped.

## Authorised Fan-Out

Delegate only when the task explicitly permits it. The human origin must prepare
workers before dispatching the parent. Recursive worker provisioning is refused
during an active run. Use existing prepared peers, not the human-chat
`relay_delegate` or `relay_worker_prepare` routes. Never disturb access workers or
ongoing jobs, or repeat a launch after an unknown transport outcome.

Discover the peer, then use `task create RUN --key KEY --file task.json` with:

```json
{
  "title": "Review assigned scope",
  "description": "Read-only review. Report defects and checks. No commits or provisioning.",
  "assigneeAgentId": "EXACT_DISCOVERED_PEER_AGENT_ID",
  "parentId": "CURRENT_TASK_ID",
  "status": "todo",
  "relayReviewPolicy": "human"
}
```

This worker-scoped `task.create` operation requires `parentId` for the child
workflow. `parentTaskId` belongs to the human-chat harness tool, not this payload.
Creation is not a reporting relationship, lifecycle grant or proof of completion.
Reuse the exact creation key and payload on retry, never a new key to escape an
uncertain result.

For explicitly granted coordinator review, `work read RUN` exposes
`task.coordinatorReviewGrants` with `grantId`, `scope: "direct_children"` and
`parentTaskId`. Set the child's `relayReviewPolicy` to `coordinator` and include
`relayReviewGrantId` from that read. Only the current acknowledged parent reviewer
may create such children, assigned to another agent. Policy and grant reference
are immutable. Omission stays human, and grandchildren are not covered. Human-chat
tools use `grantId` instead. Only the root's exact origin chat can issue
`relay_coordinator_grant` or `relay_coordinator_revoke` on explicit human instruction.

Collect child receipt IDs, then `work wait-children RUN --file children.json`:

```json
{"taskIds":["CHILD_ID_A","CHILD_ID_B"]}
```

- Supply 1 to 64 unique IDs without surrounding whitespace. Each must be a direct
  child in the same company, assigned to another agent. Existing blockers remain.
- The wait set is canonical and immutable for this run. Do not change it on retry.
  `work wait-child RUN --task CHILD_ID` remains available for one child.
- Once waiting is recorded, finish the turn without submitting or polling.
  Paperclip owns continuation. Inspect every child on continuation using
  `task inspect RUN --task CHILD_ID` before resuming work or submitting.
- If `needs_inspection` is returned, retain the turn and inspect results now.
  Cancelled children are blocked work, not successful completion. If a dependency
  mutation is uncertain, inspect the parent and original blockers before retrying.
- Verified recorded child lineage inherits the origin chat's result notifications
  and human-review scope. Parent links alone do not establish lineage. Inheritance
  is not human authorisation, and output or notifications cannot approve a result.

Use `assigneeUserId` for human work outside this agent-child wait workflow.
`blockedByIssueIds` expresses dependencies explicitly. `task list RUN` reads the
company backlog under your backend authority. Answer an addressed question with
`work answer RUN --key KEY --interaction ID --file answers.json`, using its exact
question and option IDs.

No automatic merge, commit, push, cleanup or worker termination follows preparation
or acceptance. The repository's `docs/interactive-workers.md` describes the scoped
create/adopt tools and fixture-only verification, not live launch certification.

## Candidate Review

For filesystem work, stop editing and compute the candidate with `candidate inspect
--directory REPOSITORY_ROOT`. Include that digest in your submission. Reviewers
independently recapture it and verify the work. Review disposition follows native
settlement and publication. Never accept your own submission or infer acceptance
from a comment.

For granted children, `task inspect PARENT_RUN --task CHILD_ID` returns `relayReview`
with submitted `runId`, `candidate`, `summary`, `state`, `interactionId` and applicable
`grantId`. Inspect each child after an admitted continuation and acknowledge the
exact parent run. Use `result inspect PARENT_RUN --file review.json`, then
`result accept|reject PARENT_RUN --file review.json`. The file contains:

```json
{
  "runId": "CHILD_SUBMITTED_RELAY_RUN_ID",
  "candidate": "EXACT_SUBMITTED_CANDIDATE",
  "reason": "Specific review findings and checks supporting this decision."
}
```

Both decisions require a reason (maximum 4,000 characters). The caller must be the
current claimed, acknowledged parent run in the granted binding revision/native
conversation, without cancellation or a submitted final result. Relay resolves
the exact interaction and requires backend resolver proof for that coordinator
agent and backend run. Status alone is insufficient. An unconfirmed decision must
not be reposted. Inspect evidence rather than changing IDs to bypass a conflict.

Candidate-ready comments use the backend's standard wake path. A `recorded` comment
receipt does not establish admission: `awaiting_admission` / `continuation_unconfirmed`
remains pending, with no automatic repost. Rejection needs explicit follow-up for
rework. No automatic rework wake is implemented. Do not duplicate tasks or mark them
Done to force continuation.

Human override remains available through the exact authorised chat, subject to
conflicting decision intents. Revocation before disposition can recover to
`human_only` under the original exact scope. Existing legacy `anyone` cards require
explicit human review and matching recorded human proof, never agent approval.
See `docs/coordinator-review.md` for limits. This feature is offline-tested. Live
tests are user-deferred, and neither the final workflow nor complete autonomous
recovery is claimed verified.
