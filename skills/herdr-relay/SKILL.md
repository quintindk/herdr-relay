---
name: herdr-relay
description: Read the Relay company backlog, enrol exact folders with human authority, prepare scoped Herdr workers, delegate tasks and relay origin-bound human review. Use for morning task lookup, enrolment, worker preparation or adoption, peer coordination and delegated results. Replaces the former herdr-envoy and opencode-herdr workflow.
license: MIT
compatibility: opencode
---

# Herdr Relay

Coordinate agents with the `relay_*` tools. Paperclip owns tasks and
review; Relay delivers into enrolled conversations and returns notices. The user
does not need to open Paperclip. Peers are separate conversations, not subagents.

## Startup And Backlog

- Use `relay_tasks` for morning startup and general task lookup. It is a read-only
  company backlog preview, including human-owned and imported tasks, with
  description previews. Reading a task neither assigns it nor starts work.
  Check returned warnings before treating the preview as complete.
- `relay_delegations` is only for tasks delegated from this exact origin chat and
  their results/notification history. Neither it nor `relay_reviews` is a general
  backlog lookup. A fresh chat does not inherit the previous chat's origin scope.
- `relay_agents`, `relay_delegations`, `relay_tasks` and notification-history reads
  work from an authenticated `configured` bridge while the caller is busy. These
  reads do not arm the bridge or enable incoming assignments. Ready-peer discovery
  still excludes targets that are not ready.
- With `configDirectory`, a tool invocation triggers credential discovery and waits
  up to 12 seconds for the exact chat before refusing. Discovery does not grant
  enrolment. On a transient startup timeout, wait briefly and retry the read once.
  If it still fails, report the missing Relay portion and continue independent
  startup checks. Do not skip the entire startup, substitute reviews/delegations
  for the backlog, loop indefinitely or auto-enrol the user.
- If the tools are absent, arrange an OpenCode plugin reload when idle. A Relay
  service restart does not load new tools into an existing OpenCode process.
  Do not force a restart or interrupt active work.

## Enrol Exact Folders

- `relay_enrolment_candidates` lists observed candidates read-only. Listing is not
  an enrolment grant or proof of readiness. Match the exact canonical directory
  and resolve `observedId` from the returned candidate, never invent it.
- On explicit human instruction, state the exact directory, candidate and standing
  reservation visibly before `relay_enrol_agent`. Pass `key`, `directory`,
  `reserved: true` and optionally the discovered `observedId`. The tool checks
  permission and the current native human source. Reuse the same key, immutable
  request and human source on retries. Enrolment is not task assignment.
- This is a persisted standing folder reservation, not a one-chat permission.
  Reconciliation follows unique fresh chats in that folder under the recorded
  scope. It does not transfer old results or review rights. Do not widen folder
  defaults, edit live config or silently issue new grants to repair discovery.
- A caller with no matching bridge credential cannot bootstrap itself through the
  tool. Use an already enrolled coordinator on explicit human authority, or the
  operator CLI below when the user has authorised enrolment. Never obtain operator
  credentials or elevate automatically merely because a read failed.

```bash
herdr-relay agent enrolment-candidates
herdr-relay agent enrol --directory /exact/canonical/folder --key KEY --reserved
```

- The CLI requires operator authority. With the discovery plugin already loaded,
  no Relay service restart is needed. A `requested`/`configured` receipt is not
  readiness. Inspect candidates and `relay_agents` after reconciliation.
- Linked Git worktrees and worker-owned directories require `relay_worker_prepare`
  in `adopt` mode, not generic enrolment. Worker reservations, including blocked
  workers, take priority and are checked during each reconciliation.
- Duplicate chats, stale identity, unsettled prior work and manual-pull reservations
  are blockers, not permission to pick another chat or force replacement.
- Limitation: an active standing grant can rearm a disarmed bridge. Enrolment-grant
  revoke is not implemented, so disarm is not permanent withdrawal. Report the
  need for operator repair rather than inventing a revoke command or altering
  persisted grants yourself. Coordinator-review revoke is a different operation.

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
   plugin reload at idle. Report that limitation. Do not silently create a
   replacement, interrupt ongoing jobs, inject terminal input or claim its work is queued.
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
`coordinator` is a separate experimental opt-in, not an `agent_decides` choice.

### Coordinator Grants

- Never silently grant agent review. State the recorded root parent, its assigned
  reviewer and direct-child scope, then obtain explicit human authorisation.
- Only the exact parent origin chat may call `relay_coordinator_grant` with `key`,
  `parentTaskId` and `reviewerBindingId`. The root parent's final policy must remain
  human. The reviewer must be its separate, armed native OpenCode conversation.
- Retain the returned `grantId`. Each new child must explicitly use
  `relayReviewPolicy: "coordinator"`, `parentTaskId` and `grantId` on
  `relay_delegate`. Worker creation uses `parentId` and `relayReviewGrantId` instead.
  Policy and grant reference are immutable. Existing policies are unchanged, and
  omission stays human. A grant never implies provisioning, fan-out or commit authority.
- Grant retries retain the exact key, request and human source. Revoke only on a
  later explicit human instruction with `relay_coordinator_revoke({grantId})` in
  the same origin chat. Revocation preserves confirmed decisions and cannot be undone
  by retrying the grant. Active workers cannot grant themselves authority.
- The parent learns grants through `work read RUN` at `task.coordinatorReviewGrants`.
  It inspects child IDs with `task inspect`, then decides only from its exact active
  acknowledged parent run. Both accept and reject require a reason. Backend resolver
  proof must match that coordinator agent and run, not merely an accepted status.
- Candidate-ready comments use the standard backend wake path. `recorded` proves
  the comment receipt, not admission: `awaiting_admission` / `continuation_unconfirmed`
  stays pending without automatic repost. Rejection needs explicit follow-up, with
  no automatic rework wake implemented.

See `docs/coordinator-review.md`. This feature is offline-tested, with live tests
deferred by the user. Do not claim a fully verified final workflow or complete
autonomous recovery. If the tools are absent, report that rather than using raw APIs.

Example human-reviewed delegation after resolving the live binding:

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

- Use `relay_delegations` for tasks delegated from this exact chat, submitted results
  and durable notification history. The creation receipt's `status` is historical, not a
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
  continuation. Rejection needs explicit follow-up, not an assumed automatic rework
  wake. Do not mark the issue Done yourself or resubmit the task.
- An uncertain decision must not be reposted. Exact retries from the same source
  message can reconcile a committed decision. Inspect pending reviews and decision
  receipts before acting; do not bypass a conflict with new keys or raw API calls.
- Human override remains available for exact pending coordinator candidates, unless
  a coordinator decision intent already owns the candidate. Revocation before
  disposition can yield `human_only` recovery under the exact original scope, not
  a rewrite of existing cards. Legacy `anyone` cards still require explicit human
  review with recorded source/candidate proof. They never authorise agent approval.

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

- Only explicitly configured folders or persisted standing folder grants auto-enrol.
  A unique fresh chat gets its own binding; old unsettled deliveries block
  replacement. Two live chats in one allowed folder are ambiguous, not permission
  to choose whichever is idle. Discovery alone never grants a reservation.
- Returning results and review authority remain bound to the exact originating
  chat. Resume that conversation to inspect its work. A new chat in the same folder
  does not inherit old delegation receipts or review rights.
- Use the scoped preparation tools for authorised interactive workers, never
  ad hoc launch commands. If those tools are absent, report the limitation.
- Do not use former `list_agents`, `request_agent`, `delegate`, `open_session`,
  `hand_back`, `reply_delegate` or `reap_delegate` instructions. Those belonged to
  the removed coordinator and are not Relay aliases.
- If `relay_*` tools are missing, report that the global bridge plugin must reload
  in OpenCode when idle. Do not force a restart or fall back to raw operator task
  creation: that can omit the originating chat and lose the return path.
- Existing peers and their dirty work belong to the user. Never kill, restart,
  rebind, clean up or force delivery into them merely to complete a delegation.

After changing this installed skill or the plugin, arrange a user-controlled quit
and restart of OpenCode when idle to refresh skill discovery and tool code. Do not
interrupt active workers. Enrolment itself needs no service restart. The backlog
and enrolment behaviour has local automated coverage, not live certification.
