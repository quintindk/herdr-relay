# Managed native runtimes

Linux-only managed mode gives Relay an owned, dedicated native server.
Existing shared servers remain available through reserved-conversation mode.

```bash
herdr-relay runtime launch --file runtime.json
```

```json
{"key":"graph-worker","directory":"/absolute/worktree","executable":"opencode"}
```

Relay persists launch intent, selects a local port, creates private HTTP credentials
and launches a detached owner helper. The helper records its PID/start time and the
native child PID/start time before announcing readiness. Repeated launch with the
same key returns the existing verified runtime. An uncertain launch is not replayed.
No numeric PID alone authorises signalling.

Set `harness: "hermes"` and `executable: "hermes"` to launch Hermes. It uses
`serve --isolated`, a private `gateway-token` file and a local WebSocket endpoint.
The host must already have the harness and model credentials set up. Hermes bindings
use `hermes.runtimeKey` and the exact live/stored identity and replay epoch.

Use the returned runtime port and private `auth.json` path to create or identify an
OpenCode conversation. Register the usual native binding with `opencode.runtimeKey`
set to the launch key. Relay validates that origin, credentials and directory match
the owned runtime and permits one binding per managed runtime. Do not expose those
credentials to another input controller. This remains a trusted Unix-user boundary.

For this owned mode only, cancellation can call the native abort endpoint after
the assigned prompt is observed and runtime identity is rechecked. Relay records
interrupt intent first, sends at most once, and still requires terminal observation
of the assigned message before settling. A lost abort response never implies the
turn stopped. Concurrent input conflicts prevent automatic interruption.

```bash
herdr-relay operation cancel RUN
herdr-relay work inspect RUN
herdr-relay runtime stop --file stop.json
```

`stop.json` contains `{"key":"graph-worker"}`. Stopping requires all bound work to
have settled. It signals the verified owner helper and waits for the child identity
to disappear. Repeated successful stop is a no-op. It preserves the stored native
conversation. There is no force-kill fallback or shared-server shutdown.

The owner survives Relay restart. Its descriptor is reconciled on subsequent
operations. Runtime relaunch normally uses the verified resume command below.
Active managed cron targets also have scoped automatic recovery, described below.
Herdr placement is reconciled separately through [placement commands](placement.md).
Task-scoped acceptance invokes the controller's retirement path. See
[lifetimes and rebinding](lifetimes-and-rebinding.md) for prerequisites.

`scripts/managed-opencode-smoke.mjs` launches an isolated real-model fixture,
starts a foreground `sleep 120` tool, verifies active shutdown is refused, requests
cancellation, observes terminal settlement, confirms conversation preservation,
and retires the runtime. It removes its isolated credentials and state afterward.

`scripts/managed-hermes-smoke.mjs` verifies owned Hermes cancellation and retirement
with a real model. Interrupted events can carry `persisted_turn.complete: false`.
Relay accepts them only as failed/cancelled exit evidence when the event names the
assigned user row, includes the final assistant row in its row set, and the session
is idle. Partial output never proves successful work.

## Explicit managed resume

`runtime resume --file resume.json` requires a configured backend operator context:

```json
{"key":"resume-worker-1","bindingId":"graph-worker","revision":1,"runtimeKey":"graph-worker-incarnation-2"}
```

The old owner, native child and process group must be verified gone. No unsettled
Relay work may remain. Relay launches one new owned runtime, restores the exact
stored conversation, verifies native idle state, advances binding revision and
updates the matching Paperclip adapter revision. Hermes auto-continuation of an
interrupted turn blocks this path. Identical retries reconcile the same operation.
Both managed native smoke scripts now verify this resume path with real servers.

## Scheduled runtime recovery

Relay reconciles active, provisioned managed OpenCode schedule targets on its
lifecycle tick and before occurrence admission. If the owner and native process
group are verified gone, it resumes the exact stored conversation under a durable
replacement key and advances the existing schedule target through verified resume
lineage. Repeated reboots validate the whole chain back to provisioning. Recovery
does not create a new schedule or replay missed or failed sweeps.

Paused/cancelled schedules, unsettled native work, changed ownership and live or
ambiguous process groups prevent recovery. Unknown launch outcomes retain the
same key. `routine inspect` and `routine list` expose `runtimeHealth` with the
recovery state, blocker and retry time. After three failed attempts Relay pauses
the existing routine, preserving its definition and evidence, instead of admitting
hourly failures indefinitely. Repair and explicit resume are then required.

Unsettled work replaces any previous ready health with `state: blocked`, reason
`conversation_busy` and the blocking run/task identities and native conflict reason.
This does not count as a failed runtime recovery attempt or automatically settle
the work. A published `concurrent_native_input` result requires the supported
human-authorised task recovery operation before runtime recovery can proceed.
For an exact board-owned `stranded_assigned_issue` hold, recovery additionally
requires the matching terminal backend run, published no-review result, unchanged
ownership, no pending interactions or dependencies and a verified stopped managed
process group. It resolves the existing hold as Done and preserves conflict
evidence, with read-only reconciliation after an uncertain response.

Native message completion remains separately verified. Runtime health does not
prove inbox source coverage or successful task completion.
