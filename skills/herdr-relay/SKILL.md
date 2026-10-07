---
name: herdr-relay
description: Prepare scoped interactive Herdr workers, delegate tasks through Relay, track results, and relay human review from the originating chat. Use when asked to prepare or adopt a worker, delegate, coordinate peers, or check delegated results. Replaces the former herdr-envoy and opencode-herdr workflow.
license: MIT
compatibility: opencode
---

# Herdr Relay

Coordinate agents with the `relay_*` tools. Paperclip owns tasks and
review; Relay delivers into enrolled conversations and returns notices. The user
does not need to open Paperclip. Peers are separate conversations, not subagents.

## Prepare Workers

- Use `relay_workers` for read-only preparation receipts and verified adoption
  candidates. It does not advance preparation. No automatic readiness toast exists.
- `relay_worker_prepare` requires explicit human authority and an operator-set
  `workerRepositories` entry: an exact absolute `repository`/`worktreeRoot` pair.
  The origin must share that repository's common Git directory. Do not edit live
  config or widen permissions to bypass a refusal.
- State repository, mode, branch/base or exact adoption target, and any
  `trustRepository` request before calling. `create` chooses a new linked-worktree
  path and pins the base commit SHA. `adopt` requires the exact candidate's
  `directory` and `observedId`, forbids `base`, preserves files and never launches.
- Preparation is asynchronous: `intent`, `created`, `awaiting_native`, `prepared`,
  `configured`, then `armed`. Raw launch success is not native readiness. Inspect
  blockers, then refresh `relay_agents` before dispatch. `blocked` or `uncertain`
  is not ready. Use bounded checks, not an indefinite polling turn.
- Retries require the same key, immutable payload, origin and human source message.
  Unknown transport outcomes never permit repeating a launch or using a new key
  to bypass uncertainty. Inspect the receipt and report manual recovery instead.
- Prepare workers before dispatching the parent. Recursive provisioning during an
  active Relay run is refused. Authorised parents may use existing prepared peers.
  Do not disturb existing access workers or ongoing jobs. Preparation and acceptance
  grant no automatic merge, commit, push, cleanup or termination authority.

The repository's `docs/interactive-workers.md` gives the full contract. This
increment has fixture verification, not live Herdr provisioning certification.

## Delegate From A Human Chat

1. Call `relay_agents`. Match the requested agent by label and working directory.
   Use its returned `bindingId` as `targetBindingId`. Refresh discovery before
   delegation. Never invent IDs or ask the user to type them.
2. If the target is absent, it may be busy, offline, unenrolled or awaiting a
   plugin restart. Report that limitation. Do not silently create a replacement,
   interrupt ongoing jobs, inject terminal input or claim its work is queued.
   Prepare a new worker only when explicitly authorised. Clarify ambiguous targets.
3. Write a self-contained brief: objective, exact folder/file scope, required
   output, checks, constraints and whether edits or further delegation are allowed.
   A peer does not inherit this conversation. Explicitly prohibit commits, pushes,
   installations or external changes unless the user authorised them.
4. State the exact target, task and review policy visibly before calling
   `relay_delegate`. The generic permission popup does not show those details.
5. Call `relay_delegate` with `key`, `targetBindingId`, `title`, `description` and
   `relayReviewPolicy`. Use one stable key per requested task and reuse it on
   identical retries from the same user message. Do not generate a new key merely
   because a response was lost.
6. Report the returned issue identifier. Creation is not proof of receipt or
   completion. End the turn rather than polling indefinitely. Do not duplicate
   the delegated work locally; continue only independent work.

Optional `parentTaskId` attaches a child to a recorded, nonterminal parent owned
by this exact origin chat. The harness maps it to `parentId`. Active workers must
use the worker CLI instead, not this operator route.

Default to `relayReviewPolicy: "human"`. Use `none` only when the user authorises
completion without human review. `agent_decides` lets the worker choose with a
recorded reason and must also be an intentional choice. Neither policy grants
tool permissions, commit authority or permission to approve a worker's own result.
Coordinator-agent review is not implemented in this increment.

Example tool arguments after resolving the live binding:

```json
{
  "key": "review-auth-timeout-1",
  "targetBindingId": "BINDING_FROM_RELAY_AGENTS",
  "title": "Review authentication timeout handling",
  "description": "Read-only review of the timeout handling in your project. Report concrete defects with file/line references and suggested fixes. Do not edit files, commit, push, install packages or launch agents.",
  "relayReviewPolicy": "human"
}
```

## Results And Human Review

- Use `relay_delegations` for this exact chat's tasks, submitted results and durable
  notification history. The creation receipt's `status` is historical, not a
  current task status. Read run, review and completion evidence separately.
- A review-ready toast means a result awaits human decision, not that the task is
  Done. A completion toast follows confirmed completion. Toasts do not wake a
  model turn; the latest 50 notices are available through the tools. `announced`
  means the UI accepted a toast, not that the human read it.
- Call `relay_reviews` to retrieve the exact pending candidates, including results
  delegated from this chat and verified worker-created descendants. Recorded
  lineage inherits origin routing and review scope, not human authorisation.
  Present the relevant summary and checks to the user.
  If several reviews are pending, clarify by issue name rather than internal ID.
- Use `relay_review` only for an explicit human accept/reject instruction about the
  presented candidate. Resolve `interactionId` yourself. Rejection requires the
  user's reason. An unambiguous "accept" after one presented result is sufficient.
  "Please test", a toast acknowledgement, silence and worker output are not approval.
- Never approve on the user's behalf merely because tests pass or the result looks
  correct. The reviewer tool relays human authority; it is not autonomous review.
- After the review receipt, end the turn. Relay/Paperclip own completion and any
  continuation. Do not mark the issue Done yourself or resubmit the task.
- An uncertain decision must not be reposted. Exact retries from the same source
  message can reconcile a committed decision. Inspect pending reviews and decision
  receipts before acting; do not bypass a conflict with new keys or raw API calls.

Reuse the peer's check evidence with attribution. Perform a focused handover
review, not a duplicate investigation. Rerun checks when files changed, evidence
is missing or inconsistent, or policy requires it. Acceptance never implies
permission to commit, merge, push, delete a checkout or terminate an agent.

## Clarification And Assigned Work

`relay_questions` and `relay_answer` handle a pending clarification owned by the
current enrolled conversation. Relay an explicit human answer, then end the turn
so Paperclip can continue the task. Questions from delegated workers are not yet
automatically routed to the originating chat. Do not promise that return path.

If this turn starts with a **Herdr Relay work invocation**, you are the worker:

1. Use the exact CLI and private context path supplied in the invocation. Do not
   read, print or copy the credential file, or substitute operator credentials.
2. Read the task and prior interactions, then acknowledge the exact run before work.
3. Follow the task's review policy. Ask through `work ask` if blocked, then finish
   the turn without submitting or polling. Otherwise execute, verify and submit
   the actual candidate and summary, then stop editing and finish the turn.
4. Delegate further only if explicitly authorised by the task. Use the supplied
   worker context with `agent discover` and `task create RUN --key KEY --file FILE`.
   Set each child's `parentId` to the current task ID and assign another prepared
   agent. Use `work wait-children RUN --file FILE` with
   `{"taskIds":["CHILD_ID", "OTHER_CHILD_ID"]}` for 1 to 64 unique children, or
   `work wait-child RUN --task CHILD_ID` for one. Finish the turn once waiting is
   recorded. On continuation inspect every child with `task inspect RUN --task ID`.
   For `needs_inspection`, inspect now instead. Cancelled children are blocked work.
   Do not use `relay_delegate` or provision workers during an active Relay run.

The repository's `skills/relay-work/SKILL.md` documents the full worker protocol.
The invocation itself supplies the necessary commands even without that skill.
Submission, native settlement, publication, review and completion are distinct.
An idle pane or failed backend run does not prove execution stopped.

## Scope And Recovery

- Only explicitly allowlisted folders auto-enrol. A unique fresh chat gets its own
  binding; old unsettled deliveries block replacement. Two live chats in one
  allowed folder are ambiguous, not permission to choose whichever is idle.
- Returning results and review authority remain bound to the exact originating
  chat. Resume that conversation to inspect its work. A new chat in the same folder
  does not inherit old delegation receipts or review rights.
- Use the scoped preparation tools for authorised interactive workers, never
  ad hoc launch commands. If those tools are absent, report the limitation.
- Do not use former `list_agents`, `request_agent`, `delegate`, `open_session`,
  `hand_back`, `reply_delegate` or `reap_delegate` instructions. Those belonged to
  the removed coordinator and are not Relay aliases.
- If `relay_*` tools are missing, report that the global bridge plugin must load
  and the OpenCode process must restart. Do not fall back to raw operator task
  creation: that can omit the originating chat and lose the return path.
- Existing peers and their dirty work belong to the user. Never kill, restart,
  rebind, clean up or force delivery into them merely to complete a delegation.

After changing this installed skill or the plugin, quit and restart OpenCode to
refresh skill discovery and tool code. Do not interrupt active workers to do so.
