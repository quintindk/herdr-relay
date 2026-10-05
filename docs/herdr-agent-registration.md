# Herdr-First Agent Registration

## Decision

Herdr owns harness launch, panes, workspaces and terminal placement. Relay observes
Herdr's recognised agents and registers their existing conversations in Paperclip.
The launch path is the same for shortcuts, manual shell commands and agents
starting other agents. Pane creation is not agent creation.

Relay-owned headless runtimes remain an explicit existing capability for callers
that need exclusive runtime control. They are not the default registration path.
Existing persisted owned runtimes are not migrated, stopped or removed.

## Implemented Behaviour

- Empty panes and shell commands do not create Paperclip agents.
- Detection without a native session ID or absolute session path remains pending.
- Identity is scoped by configured machine ID, Herdr session, company, harness,
  and native conversation reference. Pane IDs, names and working directories are
  mutable placement, not identity.
- Startup subscribes to events before reading a full session snapshot. Events
  trigger coalesced reconciliation. A five-second snapshot also repairs missed
  updates. Subscription and snapshot RPCs use separate socket connections.
- Exit/replacement marks a previously observed conversation offline. A session
  reference temporarily missing from the same terminal is unknown, not offline.
- Simultaneous appearances of the same conversation are ambiguous and do not
  create duplicate registrations. Resumption in another pane reuses the agent.
- Disconnect marks local observations unknown and reconnect takes a fresh
  inventory. Paperclip metadata contains the observation timestamp; its last
  observation can be stale while either service is unreachable.
- Backend creation persists a random ownership marker before POST. Lost replies
  reconcile by marker; absence never authorises another creation. Deleted or
  externally reconfigured agents produce conflicts rather than replacements.

The Herdr 0.9.3 protocol-22 API supplies `events.subscribe`, `session.snapshot`,
`pane.agent_detected`, `pane.updated`, `pane.moved`, `pane.exited` and `pane.closed`.
Inspect the installed contract with `herdr api schema --json`. No terminal output
is scraped and no prompts are sent by this observer.

## Names And Details

Paperclip names follow the explicit Herdr agent name when set. Otherwise they use
the workspace label, directory basename, pane label, or harness plus pane ID, in
that order. Conversation titles and session IDs are not included in agent names.
Titles show the harness, workspace and tab. Structured observation metadata also
retains those labels, the original terminal title, working/foreground directories,
machine, native session and exact placement IDs. Terminal controls are stripped
and display strings are bounded.

Herdr renames and moves update the existing Paperclip record, not its identity.
Relay owns the name/title of observation-only registrations, so change them in
Herdr rather than Paperclip. Offline/ambiguous observations retain their last known
display details. Other metadata, capabilities, role and instructions are preserved.

## Registration Is Not Dispatch

Automatically observed agents use the `herdr_relay` adapter with
`observationOnly: true`. They are paused in Paperclip and created with heartbeats
and on-demand wakes disabled. The adapter rejects invocation even if someone
manually unpauses one. Metadata includes `dispatch: unavailable` and
`lifecycleAuthority: observe_only`.

These records are deliberately separate from deliverable Relay bindings. Agent
detection does not provide a verified native endpoint, credentials, turn
reservation, or correlated completion receipt. Herdr's `idle`/`done` indicators
must never settle Paperclip work. Registration does not grant abort, termination,
pane close, worktree cleanup or replacement authority.

Next work is a verified attach-existing-conversation delivery contract per
harness, including coexistence with human input and explicitly authorised child
retirement. This change does not claim that capability. Creator metadata must
come from an actual launch receipt, not be inferred from pane placement.

## Configure

An operator explicitly selects the Herdr socket and company in a private JSON
file, for example `~/.local/state/herdr-relay/herdr.json`:

```json
{
  "socketPath": "/absolute/path/to/herdr.sock",
  "machineId": "stable-local-machine-label",
  "session": "default",
  "companyId": "PAPERCLIP_COMPANY_ID",
  "excludedWorkspaces": []
}
```

An empty exclusion list enrols all detected conversations in that configured
session. This is an operator opt-in, not automatic access to arbitrary local or
remote Herdr sessions. Use a stable machine label and do not reuse it for another
machine. Changing machine/session/company creates a different registration scope.

```bash
herdr-relay install --paperclip-url http://127.0.0.1:3100 \
  --backend-context /absolute/private/backend-context.json \
  --herdr-config /absolute/private/herdr.json
systemctl --user restart herdr-relay.service
herdr-relay agent observed
```

The installer updates the service definition; restart applies configuration to
an already-running coordinator. The backend context needs board authority.
Loopback trusted mode accepts `{"localTrusted":true}`. Other deployments require
an operator token. Keep both configuration files owner-readable only.

`agent observed` reports connection status, exact mappings, availability and
per-agent errors. The Herdr plugin exposes this as **Relay: Herdr agent
registrations**. `agent list` and `agent discover` still report deliverable Relay
bindings, not these observation-only entries.

Disabling the listener stops synchronisation but preserves Paperclip history.
The listener does not delete agents, modify their instructions, or change
non-Relay metadata. It synchronises names/titles from Herdr and keeps its own
observation-only agents paused until explicit delivery support exists.

## Operator-Reserved Pull Pilot

For a bounded integration test, an operator can reserve an existing idle OpenCode
conversation for one Paperclip task without launching another runtime:

```json
{
  "observedId": "herdr-agent:EXACT_OBSERVATION_ID",
  "taskId": "EXACT_PAPERCLIP_ISSUE_ID",
  "reserved": true
}
```

```bash
herdr-relay agent prepare-pull --file /private/reservation.json
```

This verifies a recent unique idle observation and the backend agent/task,
creates a pull binding with a private worker context, and configures the existing
Paperclip agent's adapter. It does not launch a process, send a prompt, assign
the issue or enable automatic wakes. The reservation admits one backend run of
that exact task within 15 minutes. The same run can reconnect, but a second run
or another task is rejected. A consumed/closed reservation cannot be silently
rearmed. To explicitly reserve a different task on the same binding, pass
`previousTaskId` identifying the closed reservation's task. The previous issue
must be Done/Cancelled and all binding runs settled. Previous reservations are
retained in history, and a previously attempted task cannot be rearmed. Release
of a subsequent reservation must include its exact `taskId`, preventing a stale
release from closing newer work. This pilot is not general automatic task delivery.

The operator then assigns the issue, explicitly enables one manual heartbeat and
records the returned backend/Relay run IDs. The current OpenCode TUI's detected
listener may not be a public native API. Do not start another server against its
conversation as a substitute. An already-installed harness-side queue, such as
OpenCode-Herdr, can deliver the scoped CLI instructions to that exact conversation.
Persist its request/generation/delivery identity and do not blindly resend.

The recipient reads and acknowledges the real issue through Relay and submits
its result with the worker context. The Paperclip adapter publishes the result
under the recipient agent and backend run. A correlated queue handback is
operator evidence, not a native terminal receipt; settlement must be explicitly
recorded as operator-attested using `operation settle`, never inferred from idle.
Prepared adapters set `requireReviewDisposition: true`: before returning success,
the adapter creates/reuses an idempotent candidate confirmation addressed to the
responsible user, moves the issue to `in_review`, and reads that status back.
Publication alone is not a valid Paperclip disposition. Terminal issues are not
reopened, and a changed assignee/execution or already-decided review requires
reconciliation rather than overwriting the board's decision.
Human input must stay out of the reserved conversation during the test.

After settlement, restore observation-only mode:

```json
{"bindingId":"EXACT_PREPARED_BINDING_ID"}
```

```bash
herdr-relay agent release-pull --file /private/release.json
```

Release refuses unsettled work, closes the dispatch reservation, pauses the
backend agent and disables its heartbeat/wake settings. It does not abort or
close the harness. Issue acceptance remains a separate board action; Relay then
reconciles accepted review dispositions to issue completion as described below.
If the coordinator stops mid-test, inspect the persisted reservation, Relay run,
Paperclip run and queue request before taking another action. Request timeouts
do not establish that the worker stopped.

### Verified Pilot

On 2026-10-05, DEF-1 (Alaska date/time) ran in the existing `scriptorium`
conversation through this operator-reserved pull path. The worker retrieved the
actual Paperclip issue, acknowledged it, measured Anchorage and Adak from one
system-clock instant, and submitted with scoped Relay credentials. Paperclip
recorded exactly one comment attributed to that agent and backend run. The
OpenCode-Herdr queue returned a correlated completed handback. Operator-attested
settlement made the backend run succeed, and release restored the agent's paused
observation-only configuration. No new runtime, pane or conversation was created.

This proves the scoped worker/result round trip and existing-conversation queue
delivery. It does not prove unattended task acceptance, automatic native terminal
settlement, or atomic protection against concurrent human input. The issue itself
remains separate from run success and requires board review/completion.

The initial pilot omitted that review disposition and left DEF-1 in progress.
Paperclip consequently launched a `finish_successful_run_handoff` corrective run,
which the one-run reservation correctly rejected. Paperclip then blocked the
issue. The published result was preserved. Operator repair added a pending review
confirmation and moved DEF-1 to `in_review` without rerunning the task. The failed
corrective run remains historical evidence, not a failed Alaska calculation.
This finding led to the `requireReviewDisposition` gate above. Its retry/conflict
behaviour is unit-tested; the original pilot did not exercise that new gate.

## Accepted Review Completion

When `requireReviewDisposition` creates a review, Relay persists a
`review-disposition:RUN_ID` operation. The lifecycle worker polls these operations
with backend operator authority, including after restart. A Paperclip acceptance
must match the interaction, run, candidate and result digest. Pending, rejected,
superseded or malformed reviews never mark work done and never trigger new work.

Completion requires the latest submitted candidate, settled/published Relay work,
a successful matching Paperclip run, the same assignee and company, and an issue
still `in_review` with no active execution, checkout or recovery blocker. Paperclip
may return an accepted confirmation to `todo` even with continuation disabled.
That state is also eligible only when the latest issue-update audit identifies
`request_confirmation_accept` for the exact review, from `in_review`, with the
same assignee and no newer issue modification. Ordinary Todo states, manual
reopens, ambiguous audit ordering and recovery blockers remain refused. Relay
checks the issue again immediately before writing. Then it persists completion
intent, PATCHes only `status: done`, and reads the status back. It does not wake,
unpause, retire or close a persistent agent.

`completion:RUN_ID` records completion separately from review acceptance. If a
reply is lost, a later `done` read reconciles it. A nonterminal read after an
uncertain write never authorises another PATCH, and new Relay dispatch for the
task is blocked pending operator reconciliation. A recorded completion never
undoes a later board reopen. Existing Done/Cancelled issues are not reopened.

Inspect failures with `herdr-relay operation list` or
`herdr-relay operation inspect completion:RUN_ID`. The installed Paperclip PATCH
API has no documented conditional-update contract: the final read narrows but
does not eliminate a race with a simultaneous board edit. Do not claim atomic
cross-system completion. Do not edit/reassign an issue while accepting its result.

Only reviews registered through the disposition path opt into automatic completion.
DEF-1 was repaired and completed manually before this path was installed; it is
not retroactively used as proof. The subsequent live tests below distinguish
operator repair from automatic acceptance completion.

DEF-2 subsequently verified the new pre-exit review gate against real Paperclip:
the existing scriptorium conversation submitted one UTC observation, the adapter
created a pending confirmation and moved the issue to `in_review` before its run
finished `succeeded`. No missing-disposition handoff or execution blocker was
present. The reservation was released without closing the harness. Human
acceptance exposed Paperclip's `in_review` to `todo` confirmation behaviour.
Before the reconciler understood that transition, Paperclip raised a stranded-task
recovery action. The operator resolved that specific recovery to `in_review` using
the existing acceptance and successful run as evidence, without rerunning the
worker or directly marking the issue Done. Relay then completed DEF-2 automatically
and persisted its completion receipt. This verifies automatic completion after
recovery, not an entirely intervention-free acceptance flow.

DEF-3 verified the corrected acceptance path on 2026-10-05. The existing
scriptorium conversation submitted its result, the adapter established review,
and the user accepted interaction `9f7110f1-edca-4da3-98bc-281a0dd3b27a`.
Relay automatically marked the issue Done at `2026-10-05T11:06:14.216Z` and
recorded `completion:81c56906-ea08-42a2-a388-2a5170329f49` for candidate
`def-3:utc-clock-observation`. Readback confirmed no execution run, missing-
disposition handoff, execution blocker or active recovery action. No manual
status repair was performed after acceptance. Initial delivery and worker
settlement still used the operator-assisted pull pilot; this result verifies
automatic review-to-completion, not unattended end-to-end task execution.
