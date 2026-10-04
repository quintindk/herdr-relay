# Reserved Hermes delivery

Verified 2026-10-04 with Hermes `0.21.5+2164.gfdec926`, source commit
`fdec926ef54391edcf6caad5f7f6761fdcccdaa2`.

Hermes bindings use `delivery: "hermes"` and a `hermes` configuration object:

```json
{
  "url": "ws://127.0.0.1:17402/api/ws",
  "directory": "/absolute/workspace",
  "authFile": "/private/hermes-gateway-token",
  "runtimeId": "EXACT_LIVE_SESSION_ID",
  "epoch": "EXACT_REPLAY_EPOCH",
  "exclusive": true
}
```

The binding's `conversationId` is the **stored** session ID. Obtain the live ID
and stored ID from `session.create` or an explicit `session.resume`. Read the
epoch through `session.events.since`. `session.activate` exposes stored identity
as `stored_session_id`, `info.stored_session_id` or `session_key`, depending on
hydration state. An optional `profile` is sent on each RPC. Relay refuses runtime,
epoch, directory or stored-identity changes. It never silently resumes a different
runtime. Credentials stay in the local token file and are never placed in prompts.

Like OpenCode mode, this requires an operator-reserved conversation. Relay checks
idle state before sending, persists intent first and never blindly retries the
prompt. Hermes receives `queued: true` to avoid its normal busy-input steering
behaviour if a race occurs. A queued response is not an immediate delivery receipt.

Completion requires the exact persisted user prompt, no new unrelated user row,
a matching native `message.complete` event, a durable final assistant row and idle
native state. Newer event payloads can provide an explicit `persisted_turn` row
mapping. The verified installed gateway omitted it, so Relay also supports the
reserved-segment contract: an event after the pre-delivery sequence watermark,
with one matching durable final assistant row after the exact user row. This is
conditional on exclusive input, not an invocation-scoped native lock.

If the native replay evidence is evicted or the gateway restarts before Relay
observes completion, work can remain unresolved. Idle alone never settles it.
Relay restart can recover while the same gateway epoch retains terminal evidence.
Shared-gateway automatic interruption is not implemented. Hermes's general
`session.interrupt` is session-wide. Its task guard applies to internal hosted-room
tasks rather than arbitrary external prompt submissions. Dedicated
[managed runtimes](managed-runtimes.md) support verified interruption and resume.

## Verification

`test/hermes.test.mjs` exercises identity requirements, exact row attribution,
missing terminal evidence and reserved-segment fallback. The opt-in script
`scripts/hermes-smoke.mjs` targets an already isolated Hermes gateway, seeds a
fresh conversation, runs the actual Relay adapter/service/CLI, and verifies prior
context recall, one comment and preserved native conversation with a real model.
Its Paperclip API is deterministic.

The default smoke gateway is the isolated fixture launched by
`python3 evaluation/native-host.py hermes`. The script accepts
`HERMES_SMOKE_WORKSPACE`, `HERMES_SMOKE_URL` and `HERMES_SMOKE_TOKEN_FILE`.
Only use a disposable gateway. Shut down that fixture and remove copied credentials
after the test.

Inspected native sources:

- `tui_gateway/contracts/sessions.py`: runtime/stored identity, interruption and replay.
- `tui_gateway/contracts/prompt_voice.py`: prompt receipts and busy semantics.
- `tui_gateway/contracts/events.py`: terminal events and persisted row mappings.
- `tui_gateway/event_replay.py`: process epoch and bounded in-memory replay.

Live evidence: [Hermes smoke](evidence/native-hermes-smoke.json).
