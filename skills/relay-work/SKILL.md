---
name: relay-work
description: Use for assigned Herdr Relay work, peer discovery, clarification and result submission through the Relay CLI. Requires a provisioned Relay context.
license: MIT
---

# Relay work protocol

## Job Authority

The assignment authorises execution of its stated work and necessary bookkeeping.
Do not ask for a second approval of in-scope task changes. Execute, verify and
report results and failures in chat. Default review mode is `none`, meaning no
separate acceptance card, not absence of user feedback. Formal approval is opt-in.

For job bookkeeping use `task create/update/comment/reference-attach RUN --key KEY
--file FILE` and `task reference-lookup RUN --namespace NS --external-id ID` with the
supplied context. Create human-owned intake with the relevant customer parent and
stable source `externalReference`, not execution-child lineage. Read changes back.
Comments are agent-attributed. Do not close active execution instead of submitting
its result. Scope changes or real ambiguity need a decision; routine mutations do not.

Scheduled routine occurrences are ordinary tasks with verified routine provenance.
Read and acknowledge the supplied run as usual, preserve its review policy and
finish the turn after submission. A timer is not human authority to create, enable,
retarget or cancel schedules. Do not invoke `relay_schedule_*` from a worker turn.
Do not mark future occurrences completed merely because this occurrence finished.

Outside assigned work, an explicit human instruction may create and activate a cron
for the current standing-enrolled folder. Omit both target fields on
`relay_schedule_create` to make the timer persist across new chats, or supply an
authorised `targetDirectory`. Folder setup does not require an open or idle chat;
each occurrence selects one idle chat only when admitted and is then pinned there.
Never replay an admitted occurrence into a new chat. `targetBindingId` deliberately
selects exact-chat mode instead. This is not worker authority.

Use `herdr-relay --context "$RELAY_CONTEXT"` or the exact CLI command supplied by
the runtime. The context file holds credentials. Do not print or copy its contents.

## Read Scope

- In an assigned run, `task list RUN` reads the company backlog under the worker's
  backend authority. `work list` lists invocations, not the general backlog.
  `task inspect RUN --task TASK_ID` reads full task text and comments for any task
  in that company, including unrelated, human-owned and terminal tasks. No child,
  project or assignee restriction applies to this read. Inspection grants no
  mutation, dependency or review authority.
  Reading a task does not assign it or authorise work outside the current brief.
- In a human chat, use paginated `relay_task_list` for morning/general lookup,
  including human-owned and terminal tasks. `relay_tasks` is a legacy preview.
  Use `relay_task_inspect` for full text and revision. `relay_delegations`
  returns only that exact origin chat's delegated work. Neither it nor
  `relay_reviews` substitutes for the backlog.
- Configured busy bridges can read `relay_agents`, task queries,
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

## Human Tracker Boundary

- Worker `task list RUN` and `task inspect RUN --task ID` are not runless tracker
  queries. Operator `task list|children|comments|activity --company ID` requires
  operator credentials and no RUN. Never fake a run or obtain operator credentials
  to use these routes from assigned work. Continue the worker protocol below.
- Human-chat `relay_task_children` reads direct children, `relay_task_comments`
  returns full bodies, and `relay_task_activity` requires explicit RFC3339 `[from,to)`
  bounds with timezone and at most millisecond precision. List filters include
  project, statuses, human/agent owner and parent; terminal tasks are not excluded.
- Follow `nextCursor` with unchanged scope/limit until `complete`; retain `fetchedAt`
  and warnings. Limits default to 50, max 999 list/children, 499 comments, 200 activity.
  Complete is not a snapshot. Full audit access is needed for activity and list
  exhaustion. Comments re-fetch the unbounded collection with a 10,000-row cap,
  not the lossy backend timestamp cursor. Do not invent cursors or treat errors as
  empty results. Restart traversal for earlier comment edits.
- Human-safe CLI creation is `task capture`, not generic `task create`. Human-chat
  create/edit/assign/comment/complete/reopen/cancel tools require explicit human
  instruction, and active workers cannot use them. Existing writes need inspect's
  revision and a stable key. Parent/dependency edits reject cycles. Disposition and
  comment routes require current human ownership. Latest-result acceptance or exact
  recorded no-review completion is not bypassed by changing owner or status.
- Comments forbid `agent://` and require user-attributed receipts. Cancel reasons
  stay in the journal. No parent PATCH is sent, but backend transitions can wake
  parent agents. `recorded` is not success unless actual `outcome.confirmed` agrees.
  Revisions are best effort without backend CAS. Uncertain existing-task writes
  reconcile without replay and fence different human-write keys for the same task.
  Create retries retain backend idempotency.
- External references are unique company/namespace/external-ID links. Lookup is
  null, reserved or attached; reserved is unresolved creation. Optional create
  `externalReference` reuses an attached task without editing/reopening it.
  Explicit attach requires a revision and writes only local metadata, included in
  subsequent revisions. Optional HTTP(S) URL metadata is immutable.

Full envelopes and exact commands: `docs/daily-task-tracker.md` and
`docs/task-commands.md`. No due dates, planning metadata, ingestion/migration,
scheduler or engagement entity belongs to this tracker contract.

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
New jobs without a policy use chat output review. Existing explicit formal policies
are retained until the user changes that workflow. The worker cannot downgrade one itself.
Experimental coordinator review requires a prior explicit human grant and a child
opted in at creation. `agent_decides` is not coordinator authority. Inspecting a
child's result is not human approval and never permits self-acceptance. The root
parent's final review remains human. Never silently obtain or infer a grant.

Retry identical requests with the same key. A changed payload requires a distinct
attempt, not reuse of an old key. If a request is uncertain, inspect the exact run
using `work inspect RUN` before proceeding. Respect cancellation and stop editing.

Cancellation stops further work, not evidence recording. Already acknowledged work
may submit its existing report after cancellation, including after cancelled native
settlement. This preserves the report without clearing cancellation, reopening the
run, completing the task or authorising more changes. Describe incomplete work.
The local adapter's delivery deadline does not automatically cancel a persisted
native invocation; explicit cancellation remains effective.

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
