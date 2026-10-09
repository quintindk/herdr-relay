# Backend task commands

Tasks remain in Paperclip. Relay records mutation intent, request identity and
receipts in schema 4, preserving prior schemas.

## Daily Tracker CLI

The [daily task tracker](daily-task-tracker.md) documents `queryTasks`, `humanTask`,
reference identity, authority and recovery. The commands below have **no RUN
argument** and require operator authority with a configured backend context.
Worker credentials are not an alternative. `--context FILE` or `RELAY_CONTEXT`
selects a credential file. Never put a token in command arguments, print the file
or obtain operator credentials to bypass a bridge refusal.

```bash
herdr-relay task list --company COMPANY_ID --status todo,blocked --limit 50
herdr-relay task list --company COMPANY_ID --status done,cancelled --limit 50
herdr-relay task children --company COMPANY_ID --task TASK_ID --limit 50
herdr-relay task inspect --company COMPANY_ID --task TASK_ID
herdr-relay task comments --company COMPANY_ID --task TASK_ID --limit 499
herdr-relay task activity --company COMPANY_ID --from 2026-10-08T00:00:00+02:00 --to 2026-10-09T00:00:00+02:00 --limit 200
```

List filters are `--project ID`, `--status STATUS[,STATUS...]`, `--agent ID`,
`--user ID`, `--parent ID`. Children accepts the same filters except `--parent`.
Comments accepts only task and pagination. Activity accepts optional `--task`, not
list filters. Status values are distinct, without spaces around commas. Omit status
to include all statuses, including terminal tasks. Query task/project/agent/parent
IDs must be lowercase UUIDs. Human IDs must be explicit, not `me`.

All four queries accept `--limit N` and `--cursor TOKEN`. Default limit is 50;
maximums are 999 for list/children, 499 for comments, 200 for activity. The CLI
returns one JSON page unchanged, not automatic pagination. Follow `nextCursor`
with unchanged arguments until `complete`. Preserve `fetchedAt`, `scope` and
`warnings`. Descriptions in lists are previews. Comments fetch the full backend
collection each time, capped at 10,000 rows, then page locally without the backend's
lossy timestamp cursor. Short or empty pages alone do not prove completeness.
Activity uses `[from,to)` with timezone-qualified RFC3339 bounds of at most
millisecond precision, and requires full all-actor issue audit access. List
exhaustion also requires full audit proof. Never synthesise precision-sensitive
cursors or report a failed traversal as empty.

### Capture And Mutate

Human-safe creation is `task capture`, **not** generic `task create` below:

```bash
herdr-relay task capture --company COMPANY_ID --key follow-up-1 --file capture.json
```

`capture.json` is an envelope, unlike the generic create file:

```json
{
  "payload": {
    "title": "Review the proposed change",
    "description": "Confirm the result with the owner.",
    "status": "todo",
    "priority": "low"
  },
  "externalReference": {
    "namespace": "manual",
    "externalId": "change-review-1"
  }
}
```

`externalReference` is optional and accepts optional `url`. The payload can supply
`assigneeUserId`, otherwise the company default human is required. It cannot assign
an agent. Optional `parentId`, `projectId` and `blockedByIssueIds` are supported by
operator capture. There are no due-date or planning fields.

Existing-task mutations use these exact CLI verbs:

```bash
herdr-relay task edit --company COMPANY_ID --task TASK_ID --key edit-1 --file changes.json
herdr-relay task reassign --company COMPANY_ID --task TASK_ID --key owner-1 --file assignment.json
herdr-relay task comment --company COMPANY_ID --task TASK_ID --key note-1 --file comment.json
herdr-relay task complete --company COMPANY_ID --task TASK_ID --key complete-1 --file completion.json
herdr-relay task reopen --company COMPANY_ID --task TASK_ID --key reopen-1 --file reopen.json
herdr-relay task cancel --company COMPANY_ID --task TASK_ID --key cancel-1 --file cancellation.json
```

Inspect first. Mutation files accept only `expectedRevision`, `payload`, `reason`.
For example, `changes.json`:

```json
{
  "expectedRevision": "REVISION_FROM_FRESH_INSPECT",
  "payload": { "description": "Updated human follow-up scope." },
  "reason": "The human owner clarified the request."
}
```

Use `payload: {"assigneeUserId":"HUMAN_USER_ID"}` for reassign,
`payload: {"body":"Human progress note"}` for comment, and
`payload: {"status":"in_progress"}` or `{}` for reopen (`todo` default).
Complete and cancel **omit payload entirely**. Cancel requires `reason`, which
stays in the Relay journal, not a backend comment. Agent reassign also requires a
reason and can wake that agent. Other operator reasons are optional.

Complete, reopen, cancel and comment require current human ownership and cannot
bypass execution, pending interactions or review guards. Non-comment mutations
check the latest result's exact acceptance or recorded policy-matched no-review
completion. Comments forbid `agent://` links and require exact human attribution
on readback. Parent/dependency edits are separate and cycle-checked. Relay does
not PATCH a child's parent, but backend child transitions can still wake its agent.

Reuse the exact key, revision, payload and source on an uncertain retry. Existing
task writes reconcile without resending, and an unresolved write fences other
human-mutation keys for that task. Revisions are best effort, not backend CAS.
`state: "recorded"` is not proof of the desired disposition: check actual `task`
and `outcome.confirmed`. A reference reuse also returns `outcome.reused`.

### Reference Commands

```bash
herdr-relay task reference-lookup --company COMPANY_ID --namespace manual --external-id change-review-1
herdr-relay task reference-attach --company COMPANY_ID --task TASK_ID --key reference-1 --file reference.json
```

`reference.json` contains:

```json
{
  "expectedRevision": "REVISION_FROM_FRESH_INSPECT",
  "payload": {
    "namespace": "manual",
    "externalId": "change-review-1",
    "url": "https://example.com/changes/1"
  },
  "reason": "Link the existing source record."
}
```

URL and operator reason are optional. The company/namespace/external ID tuple is
unique. URL metadata, including its absence, is immutable. Lookup returns `null`,
reserved state, or an attached reference with freshly checked task summary.
Attachment writes only local metadata, never PATCHes or reopens the task. Capture
with an attached identity reuses the actual task without editing it. Reserved
identities are unresolved creation, not permission to use a new key. Attached
references appear in inspect and participate in revision hashing.

## Operator Creation

Create a task without a worker run using the operator credential:

```bash
herdr-relay task create --company COMPANY_ID --key human-follow-up --file task.json
```

```json
{
  "title": "Review the proposed change",
  "description": "Confirm the result, then mark this human task Done.",
  "assigneeUserId": "HUMAN_USER_ID",
  "assigneeAgentId": null,
  "status": "todo",
  "priority": "low"
}
```

The service must have a `--backend-context` configured. It uses that board/operator
authority, not an agent's credentials. Worker and bridge credentials cannot call
the operator `/tasks` endpoint. On this loopback local-trusted installation, the
human account is `local-board` (displayed as Board), not the LiteLLM admin email.
Use the actual Paperclip company member ID on other installations.

`--company`, `--key` and `--file` are required without a run ID. Do not combine
`--company` with a worker run. Human/agent assignees are mutually exclusive, and
unknown payload fields are rejected rather than silently dropped. Parent,
project, agent and blocker references must belong to the selected company.
Paperclip validates human membership and assignment permissions.

The response contains the persisted operation and backend task receipt. Repeat
the identical command/key to retrieve the same receipt. Changed input under that
company/key conflicts. The intent is durable before POST, and a lost response
reuses the same backend idempotency key across restart. Operator keys have a
separate namespace from worker task mutations. Creating a human-only task does
not ask Relay to run a harness. Creating an agent-owned task can trigger its
configured Paperclip assignment wake.

## Task Review Policy

Operator and worker `task create` payloads may include `relayReviewPolicy`:

| Value | Completion |
| --- | --- |
| `human` | Published/settled result creates a review card; acceptance completes the issue. Default for existing and unspecified tasks. |
| `none` | Published/settled result completes the issue with no acceptance card. |
| `agent_decides` | Worker chooses `none` or `human` in its submission and records a reason. |

The delegating agent sets the policy for each child it creates. The responding
agent can choose only when the creator selected `agent_decides`. The policy is
stored with the immutable Relay creation receipt, scoped to the exact company and
task ID, and exposed by `work read` as `task.relayReviewPolicy`. It is not inferred
from prose and is not sent as an unsupported Paperclip field. Paperclip's native
`reviewPolicy` is a reviewer-eligibility restriction, not this completion policy;
an explicit native restriction prevents no-review completion.

Example child creation field: `"relayReviewPolicy": "none"`. To exercise worker
judgement, create with `"relayReviewPolicy": "agent_decides"`, then submit via
`work submit RUN --file submission.json`:

```json
{
  "key": "result-1",
  "candidate": "calculation:v1",
  "summary": "Verified informational result",
  "reviewDecision": {
    "mode": "none",
    "reason": "Deterministic calculation with checked inputs; no external changes."
  }
}
```

A fixed creator policy cannot be overridden by submission. Missing/invalid
decisions are rejected before recording a result. Identical creation/submission
retries retain their policy, and changed retries conflict. `none` still requires
a published result, verified terminal settlement, current assignee/execution,
latest candidate and no pending interactions or recovery blockers. Completion
intent is persisted before mutation, and an uncertain write is never blindly
repeated. Tool approvals, permissions and external-action authorisation are
unchanged. No-review completion is not represented as a fabricated acceptance.

Task policies currently require Relay creation. Tasks created directly in the
Paperclip UI retain human review. Requesting-agent review is not implemented by
this policy field yet; use explicit existing independent-review commands for that
workflow. The installed adapter's disposition gate must be enabled (the bridge
sets it automatically).

Live verification on 2026-10-05: DEF-16 was created with `agent_decides`.
scriptorium verified `17 * 23 = 391` using `expr`, selected `none` with a recorded
reason, and submitted through the bridge. Native settlement and publication were
confirmed, then Relay completed the issue with a recorded no-review receipt.
Paperclip readback showed Done, a succeeded run, zero interaction/review cards,
and no recovery blocker or missing-disposition handoff. No human acceptance was
requested. Fixed no-review child creation and policy-override refusal are covered
by automated tests; the earlier two-agent test still used human review.

## Worker Commands

Worker commands require an acknowledged, active Relay run and its attached backend
credentials. They execute under that agent's Paperclip permissions:

```bash
herdr-relay task list RUN
herdr-relay task inspect RUN --task TASK_ID
herdr-relay work wait-child RUN --task CHILD_ID
herdr-relay task create RUN --key subnet-request --file task.json
herdr-relay task assign RUN --key handoff --file assignment.json
herdr-relay task update RUN --key complete --file changes.json
herdr-relay work answer RUN --key answer-1 --interaction INTERACTION_ID --file answers.json
```

Worker inspection returns full task text and comments for any task in the run's
company, including unrelated tasks, other owners and terminal statuses. It uses
the attached backend credential and does not require parent/child relationships.
Company isolation remains enforced. Reading a task does not grant write, dependency
wait or review authority; those operations retain their separate contracts.

An assignment is authority for in-scope bookkeeping, not another approval request.
Use job-context `task create/update/comment/reference-attach` and `reference-lookup`.
Creation payloads may include `externalReference` to deduplicate intake across
new jobs and chats. Comments retain agent/run attribution. Ordinary bookkeeping
completion does not need a candidate review when none was explicitly requested;
the execution issue itself completes through result submission and verified settlement.
New execution tasks default to chat output review (`none`). Formal acceptance is opt-in.

Example delegated task:

```json
{
  "title": "Vend the demo subnet",
  "description": "Return the subnet resource ID and verified configuration.",
  "assigneeAgentId": "PEER_AGENT_ID",
  "parentId": "REQUESTING_TASK_ID"
}
```

Use `assigneeUserId` for human ownership, or omit both assignees for backlog work.
The same human-task JSON above works with
`herdr-relay --context WORKER_CONTEXT task create RUN --key KEY --file task.json`.
Add `parentId` to link a follow-up to the worker's current issue when appropriate.
Optional `blockedByIssueIds` expresses dependencies. Parentage does not itself
imply a dependency. Tasks need no project or manager. `task assign` changes the
  task associated with the supplied Relay run, not an arbitrary guessed task.

Answers use Paperclip's question IDs:

```json
{"answers":[{"questionId":"answer","optionIds":["text"],"otherText":"southafricanorth"}]}
```

Create retries reuse a stable backend idempotency key. Changed input under the
same key conflicts locally. Uncertain assignment and answer writes are read back
on identical retry. A matching current assignee or recorded answer reconciles the
receipt without another write. Otherwise uncertainty remains visible. Never
manufacture a new key to hide it.

Real-backend evidence: the question smoke creates one human-owned dependent
follow-up and repeats the identical request without producing another task.

Use `--task TARGET_TASK_ID` for an explicitly addressed peer task. Relay verifies
same-company ownership and Paperclip applies the caller's normal permissions.
The subnet scenario now answers the provider's question from the requesting agent
through this path. No board impersonation is needed.

Task updates support title, description, priority, dependencies and status. Setting
`status: "done"` requires the latest Relay candidate to be settled and accepted,
and refreshes the matching Paperclip review disposition before writing completion.
The worktree scenario verifies actual backend completion after accepted cleanup.

## Waiting For Another Agent

When explicitly authorised to delegate, create one child assigned to a peer, then
call `work wait-child RUN --task CHILD_ID` and end the turn without submitting a
candidate. Relay validates the same-company parent/child relationship and distinct
agent assignment, records mutation intent, marks the parent blocked on that child,
and reads the dependency back. Lost PATCH replies are read back, never blindly
repeated. Native terminal evidence settles the parent turn as `waiting`.

The child follows its normal result/review flow. Once accepted and marked Done,
Paperclip owns the dependency-unblock/continuation wake. On that new run,
`task inspect RUN --task CHILD_ID` returns the exact child and its comments under
the caller's backend authority. The parent uses the actual attributed result,
not a coordinator-pasted answer. A child already terminal at wait time is refused
with `dependency_already_terminal` so the worker can inspect it instead.

This is distinct from a human clarification and does not create a question card.
It does not grant peer process ownership or bypass child review. Do not delegate
through the separate OpenCode-Herdr queue for a Paperclip dependency test.

### Live Two-Agent Verification

On 2026-10-05, scriptorium created DEF-15 under parent DEF-14, assigning the
Johannesburg/London working-hour calculation to the existing tmp agent. The parent
recorded a first-class blocked dependency and its initial turn settled as waiting.
tmp submitted its independently calculated result from a distinct native
conversation. Human acceptance completed DEF-15 at `2026-10-05T13:59:38.760Z`.

Paperclip automatically resumed the parent's original scriptorium conversation.
It read the child's result through scoped `task inspect`, cited tmp's exact result
comment and candidate, and submitted a recommendation without rerunning the
delegated calculation. Human acceptance completed DEF-14 at
`2026-10-05T14:03:35.537Z`. Both completion receipts were recorded, both issues
were Done, and neither had an active execution, recovery blocker or
missing-disposition handoff. No coordinator-pasted answer, replacement runtime
or manual settlement was used. The child and parent each retained human review.

## Live Human-Task Verification

On 2026-10-05, the standalone operator CLI created DEF-6 assigned to the local
Board user. Repeating the identical CLI command returned the same persisted
receipt and issue ID. The user subsequently marked it Done. No agent was assigned
and its runs list was empty.

The operator CLI also created DEF-7 assigned to the armed scriptorium bridge.
That existing conversation used its scoped worker CLI to create human-owned child
DEF-8, then repeated the same creation command and verified the same receipt.
Backend readback confirmed one child, the correct human owner, parent issue,
creator agent and originating backend run. Its creation audit recorded
`assignmentWakeSkipped: true` with `no_agent_assignee`. Paperclip may list the
originating creation run under the child's runs view; that does not mean the human
task was assigned to an agent. The parent run settled automatically and reached
In Review. Human completion of DEF-8 and acceptance of DEF-7 are separate actions.
Subsequent readback confirmed both issues Done with no active recovery blocker.
DEF-8 retained human ownership. DEF-7's original review expired and a later run's
review was accepted; Relay recorded completion for that later run. This is not
evidence of a single-run review lifecycle for the parent task.

Investigation confirmed the second backend run was an automation wake with
`wakeReason: issue_children_completed`, caused by completing DEF-8. The original
DEF-7 result was already awaiting review. The worker created no duplicate child,
but submitted a new verification result, and Paperclip expired the original
confirmation as `superseded_by_newer_request`. This was not a retry of the original
creation command, an adapter crash, or a user-requested rerun.

Relay now checks child-completion wakes before dispatch. When the current issue
is still In Review with the same agent and the exact latest settled/published
Relay candidate has a pending confirmation, it returns a durable successful
no-op receipt instead of starting another native turn. The original review and
candidate remain authoritative. Other wake reasons and resolved/rejected reviews
use the normal dispatch path. Already-admitted runs cannot turn into a no-op on
retry. Backend run identity and wake reason are read using the current run token,
not trusted solely from the adapter's context. No token is stored in the receipt.

Paperclip still records the child-completion heartbeat. Suppression prevents the
extra worker turn, comment and replacement review; it does not erase the backend
event. The change is covered by unit and real-Relay-socket adapter tests.

The live regression passed on 2026-10-05: completing human child DEF-10 triggered
the child-completion heartbeat for parent DEF-9. Paperclip recorded that heartbeat
as succeeded, while Relay recorded `candidate_review_pending` suppression. The
parent retained exactly one Relay worker run and its original pending review
`51a82a6e-775e-4039-9096-938a9747d46a`. No replacement review, missing-disposition
handoff, execution blocker or active recovery action appeared. DEF-9 remained
In Review until the user accepted that original candidate. Relay then marked
DEF-9 Done automatically at `2026-10-05T12:26:50.009Z`, with a recorded completion
receipt and the same sole accepted review. No manual status repair was needed.

## Verification

Offline commands from the checkout root:

```bash
node src/cli.mjs --help
npm run check
node --test test/task-query.test.mjs test/task-references.test.mjs test/human-tasks.test.mjs test/task-tracker-service.test.mjs test/task-cli.test.mjs test/opencode-bridge-plugin.test.mjs
```

Allow at least 300,000 ms when running the targeted checks through a tool runner.
For the full suite (`npm test`), allow at least 600,000 ms. These commands exercise
fixtures and CLI argument routing, not live task creation or parent wake behaviour.
The historical live evidence above concerns the earlier creation/review workflows,
not certification of the new daily tracker.

Shell examples use actual operator company/task IDs and opaque cursors obtained
from reads. Those identifiers are not credentials. Mutation JSON belongs in the
named files; credential contents do not. Do not invent a worker RUN to make a
runless command work, and do not claim an example was executed without its result.
