# Native interactive provisioning

Interactive provisioning opens a visible OpenCode conversation in Herdr on an
explicit destination node. The same backend-addressed request, local driver and
receipts are used when source and destination share a machine. There is no local
bypass, SSH dependency or owner credential passed to a model or destination node.

Provisioning, enrolment, attachment and work assignment are separate facts.

## Human intent

- **Start Access and ask it to do something:** prepare an existing enrolled agent
  with `instance: "ensure"`, inspect its ready receipt, then dispatch one bounded
  task separately if the grant permits it. An existing busy conversation is reused
  without interruption. Execution admission waits for its ordinary capacity.
- **Open a new agent for discussion:** prepare a new enrolment at an exact folder
  with an attributed topic. No task, prompt, model turn or schedule is created.
  `relay_interactive_context` exposes the briefing to that exact conversation.
  The server plugin reminds provisioned discussions to read it. The briefing is
  context, not a fabricated human message or permission to execute work.
- **Create a replacement:** use explicit `instance: "replace"` and a grant/local
  policy permitting replacement. Old panes and pinned work remain intact.

An existing agent ID must belong to the destination node and the same enrolled
canonical directory. Display names, recency and matching paths are not identity.

## Grants approval

The **Grants** tab in `herdr-relay tui` owns security decisions. Inbox contains
work decisions only. No owner credential file or manual JSON transfer is needed
for the normal permission-request flow:

1. An enrolled interactive agent calls `relay_interactive_prepare` with a stable
   key, request ID, destination node and exact agent/folder intent. `grantId` is
   optional. A matching standing grant is reused automatically.
2. Without permission, the backend saves `awaiting_approval`. It creates no
   provisioning work, folders, sessions, tasks or executions. Pending approval
   does not block maintenance.
3. In **Grants → Pending**, inspect the requester, machine, folders, actions,
   profiles, node-wide limit and expiry. Choose **Approve once**, **Allow this
   scope** or **Reject**, then confirm.
4. Approval atomically creates permission and resumes the saved preparation.
   Approve once is bound to that exact operation. Allow this scope can cover
   future matching preparations. A rejection never starts the operation.
5. **Active** lists interactive, headless, task-reference and child-review grants
   and supports revocation. **History** records decisions and their provenance.
   `n` creates an interactive standing permission without opening an agent itself.

Approval scope cannot exceed the destination's joined-node workspace policy and
node-wide enrolment ceiling. UI-managed grants supply the provisioning permissions
directly. They do not require a second `config.interactive` permission policy.
Folder restrictions are application checks, not an OS sandbox.

The driver uses an explicit configured Herdr socket, or a verified local driver
reported by an enrolled TUI. Ambiguous or offline drivers leave the request in
`waiting_driver` without creating resources. Once preparation starts, the driver
identity is pinned for recovery. An approval does not dispatch work. That remains
a separate operation requiring explicit `allowDispatch` permission.

The TUI holds a one-hour grant-only approval credential in memory, derived from
its existing operator context. It cannot perform unrelated administration and
stops working when the parent credential is revoked. Agent/model command routes
cannot approve their own requests. This retains the trusted single-OS-user
boundary, not protection against another process with unrestricted OS-user access.
Unconfirmed decisions retain their original keys under Grants, never Inbox.

## Legacy explicit grants and driver configuration

Existing explicit grants and destination policies remain supported. For these
legacy grants, the destination operator configures its independent local policy.
This does not issue a backend grant or widen access for another node.

```json
{
  "mode": "roots",
  "roots": ["/absolute/permitted/root"],
  "herdrSocketPath": "/absolute/herdr.sock",
  "allowNewEnrolments": true,
  "allowCreateDirectories": true,
  "allowReplacement": false,
  "profiles": ["build"],
  "maxAgents": 10
}
```

```bash
herdr-relay native node configure-interactive --config /private/node.json --file policy.json
# Restart only that Relay node to apply its operator policy. Never restart Herdr
# or OpenCode merely to apply a provisioning grant.
```

`mode: "localUser"` deliberately replaces roots with the service account's
filesystem access. It is for trusted single-user installations, not hostile
multi-user isolation. New directory creation remains explicit and non-recursive.
Existing content is preserved. Canonical paths and directory device/inode identity
are checked across launch boundaries. Repository/worktree creation is not part of
this native increment. Existing repositories can be selected as ordinary folders.

A human separately issues a scoped, revocable backend grant:

```json
{
  "id": "access-launch-grant",
  "requesterAgentId": "ENROLLED_INITIATOR",
  "nodeId": "DESTINATION_NODE",
  "mode": "roots",
  "roots": ["/absolute/permitted/root"],
  "allowNewEnrolments": true,
  "allowCreateDirectories": true,
  "allowReplacement": false,
  "allowDispatch": true,
  "reviewPolicy": "human",
  "profiles": ["build"],
  "maxAgents": 10
}
```

```bash
herdr-relay native interactive grant --context /private/owner.json --key grant-access --file grant.json
herdr-relay native interactive list --context /private/owner.json
herdr-relay native interactive inspect REQUEST_ID --context /private/owner.json
herdr-relay native interactive revoke access-launch-grant --revision 1 --key revoke-access --context /private/owner.json
```

Grants can expire through `expiresAt`. The model cannot issue its own grant.
Ordinary enrolment's auto-attachment/schedule grant does not confer provisioning.
The source connector pins the actual calling agent, session and binding generation.
Headless jobs cannot use interactive provisioning. An enrolled interactive agent
can request permission without an active parent execution. Active work does not
prevent it from recording a preparation request. Dispatch remains separate.

## Scoped agent tools

1. `relay_interactive_grants`: discover grants belonging to the initiating agent.
2. `relay_interactive_prepare`: submit `{key,payload}`. Payload contains an exact
   request `id`, `nodeId` and either an existing `agentId`, or a new
   `name` and absolute `directory`. Optional fields are `instance`, `profile`,
   `createDirectory`, `topic`, `grantId` and `permissionScope`. Without a grant ID,
   matching standing permission is reused or a Grants approval request is saved.
3. `relay_interactive_status({id})`: inspect durable progress, blockers and the
   eventual exact ready receipt. Do not repeat prepare to drive the operation.
4. `relay_interactive_dispatch`: separately submit `{key,payload:{id,taskId,
   taskRevision,executionId,instructions}}`. The grant must explicitly allow dispatch.
   Reuse an existing task at its inspected revision without changing its title,
   description or other content. A positive `taskRevision` never recreates a missing
   task. For a new task, omit the revision or use zero and supply `title`. Legacy
   callers without a revision may reuse only an unchanged revision-one task.
   One task/execution can be assigned per preparation. Review policy comes from
   the human grant, not the requesting model. The prepared binding must still be
   current before assignment.
5. `relay_interactive_cancel`: cancel an outstanding preparation with its current
   revision and reason. Cancellation never kills processes or deletes directories.

Operator `native interactive request` and `dispatch` accept the same native
payloads through explicit owner context. Agent calls always use scoped node-socket
credentials instead. The maintained worker CLI exposes the same operations.

A definitive dispatch refusal is reported as `refused`, with `applied: false`, not
as an uncertain dispatch. Its original command remains in the journal as refusal
evidence rather than an unresolved maintenance blocker. After an existing-task
identity refusal, an explicit repeat of the exact key/payload can reconcile once
when the backend advertises `interactiveExistingTaskDispatch`, the preparation is
still ready and the inspected task is unchanged. Current grant/receiver and task
admission checks still apply. An intervening TUI assignment must not produce a
duplicate execution. Changed payloads or additional retry attempts are refused.
Maintenance inspection also recognises hash-verified historical dispatch refusals
as retained refusal evidence, not uncertain work. Pending operations, changed
command hashes and unrelated conflicts remain blockers. It does not erase or
replay those historical records to permit an upgrade.

Ordinary read-only CLI reconciliation is available to an enrolled interactive
agent even on approval-notice turns without an active execution. Use the default
worker context, not `{operator}`. The preparation read remains requester-scoped.
The notice is still evidence, not new human authority for mutation or dispatch.

## Human steering and historical input recovery

An accepted interactive assignment can span human corrections in a busy native
turn and subsequent human turns after idle. The node records adopted native input
IDs and an input revision without recreating the task, changing its execution or
replaying the original invocation. Its terminal evidence belongs to the turn after
the latest adopted input. An earlier successful idle marker is not evidence that
later instructions were completed, and native success alone is never a submitted
Relay result.

Only verified interactive receiver bindings use this policy. Scheduled/headless
work, other Relay invocations, peer notifications and identity/control changes do
not gain human steering or operator authority. A different assignment remains a
separate work decision. The runtime does not guess task switches from keywords.

Staged outcomes record their input revision. New steering retains obsolete staged
outcomes as superseded evidence. Unattempted stale publications are retired without
being sent. A publication already attempted when input changes remains explicitly
fenced while the owning node inspects its exact backend receipt without replay.
A confirmed receipt records the original effect and identifies later input as
not covered by that submission. An absent receipt proves non-application only
when the backend also atomically confirms an execution revision that fences the
original command. Otherwise it remains blocked, not declared unapplied. Older or
unavailable backends cannot supply this proof. Effects already sent cannot be
undone by this fence.

Retained input conflicts are not silently cleared during an upgrade. From the existing chat,
inspect `relay_work_read` and `relay_attachment_status`, then use:

```text
relay_interactive_reconcile({operation:"preview", executionId:"EXACT_EXECUTION"})
relay_interactive_reconcile({operation:"apply", executionId:"EXACT_EXECUTION",
  key:"input-recovery-v1", previewHash:"EXACT_PREVIEW_HASH"})
```

Application requires a current human request and an unchanged preview, current
receiver, accepted uncancelled backend execution and unambiguous native input
history. Pending publications and hard boundaries are not cleared by it. The
original invocation and prior conflict remain recorded. Recovery does not send a
prompt, submit a result, close a task or cancel/redispatch work. Continue in the
same chat under the recovered assignment. A subsequent steering message changes
the preview and must be inspected before applying it.

An earlier task's answered question can leave a separate `continuation_ready`
execution on the same receiver. Do not replay its question or let recovery
silently adopt it as the current assignment. If it is obsolete, its separately
authorised cancellation must settle before that task can become Done. This does
not make the earlier task a dependency of the successor.

Isolated real-host gate: `node packages/opencode-relay/smoke-receivers.mjs --legacy-recovery`.

## Model selection

Reusing a conversation preserves its human-selected model. New conversations
explicitly pin a model before creation and verify it before readiness:

1. An operator's optional `interactive.model` reference on the destination node.
2. Otherwise, the initiating conversation's verified model captured by its source
   node when submitting the request. A retry retains the original captured model.
3. For an operator request without either, resolve the native agent profile model
   or destination service default and persist that explicit selection.

Model references use `{providerID,id,variant?}`. `default` variants are omitted
when capturing the source. Never mistake the model displayed by a TUI for the
model actually stored on a newly created native session. A changed model during
preparation blocks readiness rather than silently switching it back.

## Evidence and recovery

The node journals intent before directory creation, Herdr workspace creation and
interactive start. Native session IDs are stable and metadata-bound. Lost Herdr
replies are reconciled against exact placement, unique operation markers and the
before-snapshot. Missing observations never justify another create/start request.
An uncertain operation remains visible and can be cancelled without pretending
that delayed external effects cannot still arrive.

Readiness requires native identity, the current receiver generation, loaded local
worker context and a complete Herdr snapshot identifying the exact workspace,
tab, pane, terminal and native session. The actual TUI reports selection through
Herdr's installed `herdr:opencode` selection contract. The node never fabricates
that proof from a title or desired launch arguments. Selection reporting does not
claim native execution completion or replace Herdr's lifecycle detection.

Grants and cancellation are checked again before external steps. Already committed
attachments still reconcile after a lost reply and later revocation. This avoids
stranding the local receiver while granting no permission for additional work.
Revocation does not undo resources already created. Dirty folders and human
conversations are never automatically removed or interrupted.

Without a legacy explicit grant or human-approved managed grant, provisioning
does not start. Offline destinations
leave requests queued in the backend. Destination provisioning itself requires a
live backend to recheck authority. A dated ready receipt is not a perpetual lease
or a claim that the instance is still available later.

## Local verification

```bash
node --test test/node-interactive.test.mjs
node scripts/smoke-native-interactive.mjs \
  --context /private/owner.json --config /private/node.json \
  --requester-agent ENROLLED_INITIATOR --root /absolute/disposable/root
```

The opt-in live test requires an authorised Herdr pane and a destination policy
permitting that disposable root. It creates a narrow temporary grant, prepares a
visible discussion, reuses it, explicitly replaces it and separately dispatches a
bounded real-model check. It revokes its grant after success and retains its own
workspaces for inspection. It never publishes a release or changes a human's
model. Physical second-machine and complete crash-injection coverage remain
separate acceptance gates.
