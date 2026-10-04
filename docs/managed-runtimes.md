# Managed OpenCode runtimes

Linux-only managed mode gives Relay an owned, dedicated OpenCode HTTP server.
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
operations. Automatic runtime relaunch, Hermes owned launch, herdr placement and
acceptance-triggered shutdown orchestration remain pending.

`scripts/managed-opencode-smoke.mjs` launches an isolated real-model fixture,
starts a foreground `sleep 120` tool, verifies active shutdown is refused, requests
cancellation, observes terminal settlement, confirms conversation preservation,
and retires the runtime. It removes its isolated credentials and state afterward.
