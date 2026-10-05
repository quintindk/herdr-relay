---
name: relay-work
description: Use for assigned Herdr Relay work, peer discovery, clarification and result submission through the Relay CLI. Requires a provisioned Relay context.
license: MIT
---

# Relay work protocol

Use `herdr-relay --context "$RELAY_CONTEXT"` or the exact CLI command supplied by
the runtime. The context file holds credentials. Do not print or copy its contents.

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

`work read` includes `task.relayReviewPolicy`. Respect fixed `human` or `none`
policy. For `agent_decides`, submit via `--file` with a `reviewDecision` object
containing `mode: "none"` or `mode: "human"` and a specific `reason`. Use judgement
based on the task and consequences. No-review still requires verified completion
and publication; it does not bypass tool permissions or authorise external effects.
When creating a delegated child, choose its `relayReviewPolicy` explicitly.
Missing policy retains human review. The worker cannot downgrade a fixed policy.

Retry identical requests with the same key. A changed payload requires a distinct
attempt, not reuse of an old key. If a request is uncertain, inspect the exact run
using `work inspect RUN` before proceeding. Respect cancellation and stop editing.

Native completion, result publication, review and acceptance are separate states.
Only the operator or verified harness observer can settle native execution. Never
use an idle-looking UI or a failed Paperclip run as proof that execution stopped.

For delegation, discover the peer, then `task create RUN --key KEY --file task.json`
with its `assigneeAgentId`. This creates a task, not a reporting relationship or
lifecycle grant. Use `assigneeUserId` for human work. `blockedByIssueIds` expresses
dependencies explicitly. `task list RUN` reads the company backlog under your
backend authority. Answer an addressed question with `work answer RUN --key KEY
--interaction ID --file answers.json`, using its exact question and option IDs.

For filesystem work, stop editing and compute the candidate with `candidate inspect
--directory REPOSITORY_ROOT`. Include that digest in your submission. Reviewers
independently recapture it, verify the work and use `result request|inspect|accept|reject
CALLER_RUN --file review.json`. The JSON must identify the submitted run and exact
candidate. Never accept your own submission or infer acceptance from a comment.
