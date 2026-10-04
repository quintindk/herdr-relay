# Backend task commands

Tasks remain in Paperclip. Relay records mutation intent, request identity and
receipts in schema 4, preserving prior schemas.

Commands require an acknowledged, active Relay run and its attached backend
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
