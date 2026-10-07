# In-Process OpenCode Bridge

The bridge removes the manual queue request and operator settlement steps for an
explicitly reserved existing OpenCode conversation. It is opt-in per binding.
Herdr still owns launch and placement. No additional OpenCode server is launched.

## Flow

1. Configure a private bridge credential for an observed OpenCode conversation.
2. Load the plugin in that conversation's OpenCode process. It verifies the exact
   Herdr pane occupant, terminal, directory, native session and creation time.
3. Arm the bridge after it reports ready. This enables assignment-triggered wakes
   for that one Paperclip agent, with no periodic heartbeat and one concurrent run.
4. Assign an issue in Paperclip. The adapter persists a Relay run and attaches its
   scoped backend credential. The plugin waits for native idle and preserves the
   conversation's agent/model selection.
5. Relay records a message ID and prompt before sending. The plugin sends through
   its own OpenCode SDK, not terminal input or another process's HTTP listener.
6. The worker reads, acknowledges and submits using the existing Relay CLI.
7. The plugin reports bounded native message evidence. Relay verifies the exact
   prompt, assistant parent ID, terminal finish, no active tools and native idle.
   Successful settlement also requires a submitted result or published question.
8. The adapter publishes and establishes review. Accepted candidates follow the
   existing acceptance-to-Done reconciler.

## Safety Boundary

This is **reserved-conversation automation**, not an atomic queue for simultaneous
human interaction. Do not type into the enrolled conversation or send work through
another coordinator while its bridge is armed. OpenCode's SDK does not expose
atomic idle-and-send. Two reads narrow that race, and unexpected user input or a
chat-message event makes attribution conflict sticky. The bridge never suppresses
human input, auto-approves permissions, aborts a session, closes panes or kills a
process. It does not coordinate admission with the OpenCode-Herdr request queue.

Each delivery is attempted once. A lost `begin` response can leave an unsent but
uncertain intent. A lost prompt response is reconciled by message inspection,
never replayed. A restarted plugin process cannot adopt an unsettled invocation
from another epoch. That situation requires operator investigation; no automatic
recovery claim is made. Relay restart retains intent and accepts the same live
plugin epoch. Missing result, missing message, conflict and unknown state do not
mean completion. Cancellation waits for verified terminal evidence, not a timer.

The bridge credential can only poll/begin/report for its own binding. It cannot
submit results, settle arbitrary runs or use operator APIs. The normal worker
credential cannot report bridge evidence. Both remain within the existing trusted
Unix-user boundary: they are not isolation against malicious same-user processes.
Evidence comes from the trusted plugin's SDK reads, not cryptographic attestation.
The bridge also has narrowly scoped [harness question tools](questions-v1.md#reply-from-the-harness)
to relay an explicit source-bound answer after a clarification turn has settled.
These use the connector's operator authority and preserve that attribution.
Bridge observations have a 4 MiB limit, restricted to authenticated bridge
credentials on `/bridge/observe`; other requests retain the 128 KiB limit.
Evidence includes user-message identities for conflict detection and assistant
messages belonging to the exact invocation, not unrelated assistant history.

## Configure

### Daily Use

To opt folders into automatic enrolment, set `bridgeDirectories` to their absolute
paths in the service's Herdr configuration. This authorises Relay to reserve the
unique observed OpenCode chat in each listed folder. Other folders remain
observation-only. Configure the global OpenCode plugin with:

```json
["file:///absolute/path/herdr-relay/src/opencode-bridge-plugin.mjs",
 {"configDirectory":"/absolute/state/herdr-relay/bridges"}]
```

Restart OpenCode once after installing this mode. The plugin discovers matching
credentials every five seconds and follows fresh chats without another config
edit or restart. It matches the exact current pane, terminal and conversation,
not just the folder. Tools remain visible while enrolment is pending.

The observer configures each unique current chat and arms it only after an idle
plugin readiness report. A fresh conversation retains its own observed Paperclip
registration and gets a new binding. Old bridges are disarmed, not deleted or
retargeted. Any unsettled old delivery in that folder blocks replacement. Duplicate
live chats in a folder block enrolment. A terminal replacement for the same chat
rotates its bridge credential and requires fresh readiness. History is never
replayed into a new conversation.

Inspect `herdr-relay operation inspect bridge-enrolment` for per-folder results.
`configured` means awaiting the plugin, not ready to delegate. Removing a folder
from the allowlist does not revoke an existing reservation; disarm it explicitly.
Do not type into an agent while its delegated task is executing. Automatic
enrolment does not make simultaneous human and agent input atomic.

### Delegate From Chat

`relay_agents` lists ready peers in the same company. `relay_delegate` creates an
operator task after checking the current native user message and requesting tool
permission. The company and return address come from the authenticated bridge,
not caller-supplied routing. Use a stable key for retries. Human review is the
default. Before invoking the tool, state the proposed target, task and review
policy in the chat: OpenCode's generic permission popup does not render custom
metadata. Active Relay workers must use their worker-scoped child-task protocol.

Each created task records its exact originating binding, conversation, native
creation time and user-message attribution. Once Relay confirms accepted or
no-review completion, it queues one durable return notice. The origin plugin
waits until idle and shows a 15-second completion toast. `relay_delegations`
returns task results and notification history, including missed or uncertain
announcements. Notifications never append to model history, change model settings,
start a model turn or count as human approval.

The outbox survives service restarts and does not follow replacement chats.
`announced` means the TUI API accepted the toast, not that a human read it. A lost
send or acknowledgement remains `uncertain` and is not resent automatically.
Later notices are still attempted. Legacy tasks created without an origin are
not retrospectively assigned a return address. CLI/operator callers must include
an explicit validated origin through the task API to receive return notices.

Installing these tools requires one restart of each originating OpenCode process.
Worker processes do not need a restart merely to execute a delegated task.

### Review From Origin

`relay_reviews` includes both human reviews local to this conversation and results
of tasks delegated from this exact originating chat. Each delegated entry is
matched against its recorded company, assignee, native conversation and creation
time. A new chat in the same folder does not inherit review authority.

After a published result reaches a pending review, Relay queues a distinct
"awaiting your review" toast. Inspect the result here, then explicitly accept or
reject it using `relay_review`; rejection requires a reason. The plugin retains
the permission-selected candidate and the current human message as attribution.
Neither worker output nor a notification is human approval. Human approval from
the worker's own chat remains supported, but it competes for the same durable
decision intent as approval from the origin.

An unresolved decision prevents new dispatch for that task. Lost replies never
authorise another acceptance POST. An exact retry from the same user message can
reconcile the recorded decision even if completion already moved the task to
Done. Review receipts appear in `relay_reviews` separately from pending items.
New candidates, changed assignment and different originating chats cannot reuse
the decision. Old plugin processes do not receive review-ready toasts until they
restart with support for the new notification kind, preventing false completion
labels. Completion toasts continue to work unchanged.

### Explicit Enrolment

Write a private input file with the exact ID from `herdr-relay agent observed`:

```json
{"observedId":"herdr-agent:EXACT_ID","reserved":true}
```

```bash
herdr-relay agent configure-bridge --file /private/bridge-request.json
```

The response gives a binding ID and private `bridgeConfigFile` path. It does not
print the credential. Existing manual-pull reservations must be closed and all
work settled. The setup preserves the Paperclip agent and existing binding.

Add this plugin tuple to the existing OpenCode plugin array, preserving its other
entries (absolute paths required):

```json
[
  "file:///absolute/path/herdr-relay/src/opencode-bridge-plugin.mjs",
  {"configFile":"/absolute/private/bridges/observed-BINDING.json"}
]
```

For multiple enrolled agents, use one plugin entry with
`{"configFiles":["/private/first.json","/private/second.json"]}` instead.
The plugin selects the matching directory and, when several bindings share it,
the calling Herdr pane's exact terminal/session identity. Ambiguity fails closed.
Each newly enrolled harness must restart after its configuration is added;
restarting before enrolment does not load a future credential. Existing running
plugins keep their already-loaded binding until their own restart.

Quit and restart **the target OpenCode process**, resuming the same conversation.
If that recreates its Herdr terminal rather than only the harness process, setup
must be reconciled explicitly. Other conversations do not match the plugin's
directory/session/terminal checks and cannot take delivery for this binding.

Then inspect `herdr-relay operation inspect opencode-bridge:BINDING_ID`. It must
report a recent `lastSeen`, matching identity and `ready: true`. Arm with:

```json
{"bindingId":"EXACT_BINDING_ID"}
```

```bash
herdr-relay agent arm-bridge --file /private/binding.json
```

Assign a small issue only after arming. Arming enables on-demand wakes but does
not itself invoke a task. Stale plugin presence rejects new dispatch. Herdr's
observed availability remains separate from Paperclip's own run state.

After work is settled, return the agent to paused observation-only mode:

```bash
herdr-relay agent disarm-bridge --file /private/binding.json
```

Disarming refuses active/unsettled work. Credentials and history remain available
for later enrolment; no native resources are removed.

## Verification

### Rejection Rework

DEF-20 exercised rejection in tmp on 2026-10-07 without modifying access. Paperclip
confirmed the human rejection of `REWORK TEST v1` and immediately requested a
continuation despite the review card's `continuationPolicy: none` (its review-path
recovery behaviour). Relay's old decision readback rejected the new execution
owner, left the decision uncertain, and refused the continuation at admission.
Paperclip then placed the task under execution reconciliation.

The fix separates confirmation of an already-attempted exact human decision from
new execution admission. Background reconciliation reads the exact candidate,
interaction, reason and human resolver without reposting. The adapter waits within
its deadline for an unresolved decision instead of immediately failing the wake.
Automated coverage includes continuation racing rejection readback, lost replies,
wrong human receipts, cancellation and bounded admission waits.

After deployment, the original rejection reconciled to recorded. The failed
backend wake had no Relay run or native delivery intent. Its terminal failure and
cleanup events were inspected before resolving that exact recovery action through
Paperclip's supported endpoint with `actionOutcome: not_performed`. This explicit
recovery continued the SAME task in the SAME native tmp conversation and produced
`REWORK TEST v2`, published and pending human review. No replacement task, manual
native prompt or repeated rejection was used. This proves evidence-based recovery,
not a fully automatic rejection cycle: a fresh rejection after the fix is still
needed to verify the uninterrupted path. V2 was not automatically approved.
The user explicitly accepted v2 from the originating chat. Relay confirmed Done
at `2026-10-07T13:52:14.286Z` and announced its completion toast at
`2026-10-07T13:52:22.435Z`; the user confirmed seeing it. The implementation
checkpoint passed 855 automated tests plus syntax and diff whitespace checks.

### Chat Return Path

DEF-18 verified the live chat-origin round trip on 2026-10-06. The originating
OpenCode conversation used `relay_agents` and `relay_delegate` to assign a read-only
readiness check to scriptorium with human review required. The worker acknowledged
the task, submitted its working directory and readiness report, and reached
verified native settlement. The submitted report stated that no workspace files
were changed and no packages, commits or other agents were created.

After acceptance, Relay recorded completion and announced the origin-bound toast
at `2026-10-06T12:23:23.444Z`. A subsequent `relay_delegations` read returned the
settled result, accepted review and durable notification in `announced` state,
targeting the original conversation. The user reported seeing a toast. This
confirms the live return path without requiring the Paperclip UI or another model
turn. It does not turn toast API acceptance into proof of human readership.

The implementation checkpoint passed 213 automated tests, syntax checks and diff
whitespace checks before deployment. The earlier DEF-17 operator task completed
successfully but had no recorded origin, so it correctly has no retrospective
return notification.

### Polling Cost

Idle/configured bridges perform a lightweight identity/status/Relay poll every
three seconds after the previous poll finishes. They do not fetch conversation
history when Relay has no active run. Work-bearing polls retain full history and
correlation checks at a one-second cadence. Answer/review tools load history only
when invoked; read-only pending-item lists use lightweight snapshots.

Discovery, identity and transport failures back off from two seconds up to thirty
seconds, resetting after a successful poll. No overlapping ticks or retries after
plugin disposal are allowed. Herdr event-triggered reconciliation is capped at
one pass per second, retaining the five-second periodic inventory repair.

CPU investigation found that the old plugin loaded full history every second even
without a task, and stale terminal bindings retried discovery at that same rate.
Regression tests assert zero idle history reads and bounded failure retries.
Existing OpenCode processes must restart to load these changes. Relay service
restart alone cannot replace their plugin code. Stale terminal identities remain
refused; performance changes do not silently rebind a restored pane.

The investigation also measured high CPU in OpenCode processes not enrolled in
this bridge. These optimisations do not establish that all OpenCode CPU use comes
from Relay. Measure per-process CPU deltas over a fixed interval, distinguishing
active model turns and other plugins from idle bridge overhead.

Automated tests cover explicit arming, wrong credentials/identity, one-shot
delivery, lost responses, changed plugin epoch, concurrent input, result-required
settlement and disarming. An SDK fixture runs the real plugin against a real Relay
socket with a deterministic native client, including a lost prompt response.

On 2026-10-05 the user restarted scriptorium in its existing Herdr terminal and
resumed the same native conversation. Its plugin reported a fresh epoch, matching
session creation time and idle readiness. The bridge was explicitly armed after
checking there were no unfinished assignments. Paperclip readback confirmed idle
status, on-demand wakes, no periodic heartbeat, one concurrent run and required
review disposition. Arming did not create or invoke a task.

DEF-4 verified assignment-triggered delivery and native settlement on 2026-10-05.
The existing scriptorium conversation received one durable message, read and
acknowledged the actual issue, and submitted its joke. Paperclip recorded exactly
one result comment attributed to the same agent/run. The live conversation's
evidence exceeded the original 128 KiB body limit; the bridge-only observation
limit was raised to 4 MiB, and future plugin snapshots exclude unrelated assistant
history. The same plugin epoch recovered after Relay restart without resending.
Its exact terminal assistant response settled the run automatically, and the
adapter moved the issue to In Review before returning success. No corrective
handoff or recovery blocker appeared. Human acceptance then completed DEF-4
automatically at `2026-10-05T12:01:22.740Z`. Readback confirmed Done, a recorded
`completion:84f53978-6f99-4132-88db-216d4de8200b` receipt and no recovery blockers.

This test needed a server-side size-limit fix but no manual queue request, worker
rerun or operator-attested settlement. The already-running plugin retains its
older evidence projection until the next user-initiated restart. DEF-1/2/3 used
the earlier operator-assisted queue path.
