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

## Two independent authorisations

The destination operator configures its local policy. This does not issue a
backend grant or widen filesystem access for another node.

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
Scheduled and delegated worker turns cannot recursively provision through the
human-chat route. A future execution-specific provisioning capability would need
its own explicit grant rather than reusing this interface.

## Scoped agent tools

1. `relay_interactive_grants`: discover grants belonging to the initiating agent.
2. `relay_interactive_prepare`: submit `{key,payload}`. Payload contains an exact
   request `id`, `grantId`, `nodeId` and either an existing `agentId`, or a new
   `name` and absolute `directory`. Optional fields are `instance`, `profile`,
   `createDirectory` and `topic`.
3. `relay_interactive_status({id})`: inspect durable progress, blockers and the
   eventual exact ready receipt. Do not repeat prepare to drive the operation.
4. `relay_interactive_dispatch`: separately submit `{key,payload:{id,taskId,
   executionId,title,instructions}}`. The grant must explicitly allow dispatch.
   One task/execution can be assigned per preparation. Review policy comes from
   the human grant, not the requesting model. The prepared binding must still be
   current before assignment.
5. `relay_interactive_cancel`: cancel an outstanding preparation with its current
   revision and reason. Cancellation never kills processes or deletes directories.

Operator `native interactive request` and `dispatch` accept the same native
payloads through explicit owner context. Agent calls always use scoped node-socket
credentials instead. The maintained worker CLI exposes the same operations.

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

The default server policy remains **off** until configured. Offline destinations
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
