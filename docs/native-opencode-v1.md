# Reserved OpenCode delivery

Date: 2026-10-04. Native contract: OpenCode `1.18.34`.

Relay can now deliver work to an existing, explicitly reserved OpenCode
conversation and settle it from a correlated terminal assistant response.
Hermes continues to use explicit CLI pull and operator settlement.

## Setup

Start an OpenCode HTTP server under the same Unix user as Relay. Use an existing
conversation whose working directory is accessible to that user. Reserve that
conversation for Relay work for the duration of each invocation. Do not send
human prompts, shell requests or other automated input during that reservation.

Read the session with `GET /session/SESSION_ID?directory=ABSOLUTE_DIRECTORY` and
copy its `id`, `directory`, `projectID` and `time.created` into the registration:

```json
{
  "id": "daily-driver",
  "companyId": "PAPERCLIP_COMPANY_ID",
  "agentId": "PAPERCLIP_AGENT_ID",
  "harness": "opencode",
  "instanceId": "local-opencode-server",
  "conversationId": "ses_EXISTING_SESSION",
  "delivery": "opencode",
  "opencode": {
    "url": "http://127.0.0.1:4096",
    "directory": "/absolute/workspace",
    "projectID": "EXACT_PROJECT_ID",
    "sessionCreatedAt": 1791000000000,
    "exclusive": true
  }
}
```

`instanceId` is an operator reference. Relay verifies the origin, directory,
project, conversation and creation time. OpenCode does not expose a process
incarnation identifier through this API, so this is a stored-conversation binding,
not proof of a particular operating-system process. Archived or reverted sessions
are refused. URLs must use `127.0.0.1` or `[::1]`, without embedded credentials.

Optional fields under `opencode`:

- `model`: an object containing `providerID` and `modelID`. Omit to retain the
  harness's native model selection.
- `authFile`: an absolute path to a private JSON file containing `username` and
  `password` for OpenCode HTTP Basic authentication. Username defaults to `opencode`.
  Keep this file outside the repository and restrict its permissions to `0600`.

Register through the existing operator CLI:

```bash
node src/cli.mjs agent register --file binding.json --context-out worker.json
```

Registration verifies native identity before persisting the binding. Existing pull
bindings cannot silently change delivery mode. Use a distinct logical agent and
conversation until verified rebinding is implemented.

Paperclip adapter configuration is unchanged. Once the adapter attaches its run
credentials, Relay checks the native session is idle, writes a binding-scoped
worker context under its restricted state directory, persists a native message ID
and prompt, and sends one `prompt_async` request. The prompt contains CLI commands
and the context path, never credentials. The worker reads the actual task through
Relay, acknowledges it and submits through the CLI.

## Observation and recovery

```bash
node src/cli.mjs work inspect RELAY_RUN_ID
```

This reads local integration state even while Paperclip is unavailable. Output
keeps worker acknowledgement, native observation, result publication and settlement
separate. `native.state` is one of:

| State | Meaning |
| --- | --- |
| `blocked` | No delivery intent yet. Native identity, availability or busy state prevents sending. |
| `uncertain` | Delivery intent is durable, but the request or matching message is not established. |
| `observed` | The exact prompt exists, but a terminal native response is not verified. |
| `conflict` | Concurrent input or a changed prompt prevents attribution. This state is sticky. |
| `finished` | A terminal response to the recorded message and an idle reserved session were observed. |

Settlement requires the recorded prompt, a matching assistant `parentID`, a
completed terminal response, no active tools, and an idle session. Intermediate
tool-call responses do not qualify. Successful settlement also requires a durable
worker submission. A finished turn without a result remains unresolved. Native
errors settle as failed unless cancellation was requested.

Relay resumes observation after restart, including when the adapter is absent.
It never replays a native POST once intent is recorded. A crash between the intent
write and POST can therefore leave work unresolved even though nothing was sent.
An absent message is not proof that an in-flight request cannot still arrive.
There is no override or automatic replay for this case.

Adapter dispatch has a separate retry boundary. A lost Relay `/runs` response is
retried with the same backend run key and unchanged payload. Definitive 4xx
rejections fail promptly. Cancellation received during that recovery is persisted
before attaching the backend token that enables new native delivery.

An adapter process restarted with the same Paperclip run, binding and task can
reattach credentials and recover the existing invocation. Tests kill an actual
adapter process, restart Relay and complete through a replacement adapter, with
one native prompt and one attributed comment. This does not establish Paperclip's
own host-restart policy or guarantee it will re-invoke the adapter with that run ID.

Schema 2 adds optional native fields to stored run JSON. Schema-1 pull records and
credentials are retained. Future schema versions are rejected before schema writes.

## Cancellation and concurrency limits

`operation cancel` persists cancellation and stops further work. Acknowledged work
may still record an existing report, including after cancelled native settlement,
without clearing cancellation, reopening the run or marking the task complete. Before
native intent, cancellation settles immediately. After intent, Relay waits for a
matching terminal response and native idle state. It does **not** call OpenCode's
session-wide abort endpoint. Native interruption must currently be performed by
the operator who controls that reserved conversation.

For an already-requested cancellation that cannot reconcile normally, the operator
may use `operation settle RUN --outcome cancelled --evidence EVIDENCE` after checking
the exact original turn has ended. This is explicitly recorded as operator-attested
cancellation, retains any attribution conflict and never certifies success or
review acceptance. Workers cannot call the settlement route. Never attest from
an idle pane alone or clear the cancellation to make submission succeed.

The OpenCode API lacks atomic idle-and-send and invocation-scoped interruption.
`exclusive: true` is an operator reservation, not a native lock. Observed concurrent
user input, including compaction continuation, causes an attribution conflict.
It cannot prevent input racing the HTTP request, or detect all transient changes
that disappear between polls. This mode must not be used to dispatch into a
concurrently controlled human conversation. General TUI adoption remains pending.

Native settlement observes the harness turn, not the completion of detached work
that an agent may have launched outside it. Do not treat it as resource cleanup or
acceptance. The connector neither kills the server nor deletes the conversation.

## Verification

- `npm test`: HTTP fault fixtures cover successful native settlement, private CLI
  context, lost responses, Relay restart, absent delivery, busy/replaced sessions,
  conflicting input, cancellation, missing results, intermediate tools and schema
  upgrades. Fixtures do not run a model.
- `node scripts/opencode-smoke.mjs`: opt-in live-model test against an isolated
  OpenCode `1.18.34` server. It creates a conversation with prior context, invokes
  the actual Relay adapter/service/CLI, and checks context recall, one attributed
  comment, correlated settlement and conversation preservation. Its Paperclip API
  is deterministic. It is separate from the earlier real-Paperclip smoke test.

The live smoke uses the local OpenCode auth file, copied into a temporary isolated
home with restricted permissions. It terminates its own server and removes the
temporary home after completion. Set `OPENCODE_SMOKE_AUTH`, `OPENCODE_SMOKE_MODEL`
or `OPENCODE_SMOKE_TMP` to override its defaults. It consumes model usage.

Successful live evidence is in [native OpenCode smoke](evidence/native-opencode-smoke.json).

## Pinned upstream contract

Inspected release commit: `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.

- [HTTP handlers](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts):
  `promptAsync` launches a background prompt and returns 204. `abort` takes only a
  session ID.
- [Prompt implementation](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/prompt.ts):
  caller-supplied message IDs, assistant parent linkage, tool-loop termination and
  prompt insertion before joining the session runner.
- [Session runner](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/session/run-state.ts):
  cancellation acts on a session runner and its background jobs.
- [Runner state](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/opencode/src/effect/runner.ts):
  `ensureRunning` joins an existing run instead of rejecting concurrent prompt input.

Later increments implement [owned-runtime interruption](managed-runtimes.md),
[Paperclip recovery](paperclip-recovery.md), [Hermes delivery](native-hermes-v1.md),
[rebinding](lifetimes-and-rebinding.md) and [bounded questions](questions-v1.md).
Shared-session atomic reservation remains an upstream interface limitation.
