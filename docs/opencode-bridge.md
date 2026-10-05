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
