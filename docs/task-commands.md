# Backend task commands

Tasks remain in Paperclip. Relay records mutation intent, request identity and
receipts in schema 4, preserving prior schemas.

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

## Worker Commands

Worker commands require an acknowledged, active Relay run and its attached backend
credentials. They execute under that agent's Paperclip permissions:

```bash
herdr-relay task list RUN
herdr-relay task create RUN --key subnet-request --file task.json
herdr-relay task assign RUN --key handoff --file assignment.json
herdr-relay task update RUN --key complete --file changes.json
herdr-relay work answer RUN --key answer-1 --interaction INTERACTION_ID --file answers.json
```

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
