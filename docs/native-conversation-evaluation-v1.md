# Existing native conversation integration evaluation

Date: 2026-10-03

## Result

Both existing OpenCode and Hermes conversations successfully used both task
backends through a narrow CLI helper while retaining their earlier context.

Paperclip accepted comments attributed to real agent/run identities established
through a custom process-adapter bridge. OpenRig accepted queue claims and
completion through its HTTP API even though it cannot launch either harness in
the tested release.

This proves that using either work backend does not inherently require replacing
the conversation. It does not prove automatic discovery/adoption of arbitrary
interactive terminals or production-ready lifecycle integration.

## Test design

1. Start an isolated OpenCode server and Hermes backend, independently of the task
   products. Use the installed native harnesses and the configured Copilot model.
2. Create a conversation in each harness and give it a random context word.
   Ask for ACK without tool use or writing the word to files.
3. Subsequently create task-backend work and connect the existing conversation.
4. Ask the model to recall the earlier word, which is not repeated in the new
   prompt, and execute a scoped CLI helper to report it.
5. Read the task backend and compare the receipt, recalled word and attribution.
6. Keep the same stored conversation when testing the second backend.

Native versions: OpenCode `1.18.34`, Hermes
`0.21.5+2164.gfdec926` (upstream `fdec926e`). Both used `gpt-6-astra` via Copilot.
Task products remained Paperclip `2026.1001.0` and OpenRig `0.6.4`.

## Paperclip

The evaluation process adapter started a small process that held the legitimate
run context open while an external host driver notified the existing native
conversation. The run credential was placed in a restricted local binding file.
The prompt contained only a helper invocation and binding path, not credentials.

The native model executed the helper through its real terminal tool. The helper
posted a comment using the agent token and `X-Paperclip-Run-Id`.

| Check | OpenCode | Hermes |
| --- | --- | --- |
| Conversation existed before task registration | Passed | Passed |
| Earlier context recalled | Passed | Passed |
| Model executed CLI helper | Passed | Passed |
| Comment persisted | HTTP 201 | HTTP 201 |
| Comment author matches Paperclip agent | Passed | Passed |
| Comment run matches active Paperclip run | Passed | Passed |
| Native session ID unchanged during this task | Passed | Passed |

No Paperclip or harness source was patched. This is a custom bridge using the
supported process adapter, not the built-in OpenCode or Hermes adapter.

The bridge remains a proof-of-concept. The process holder alone does not supervise
the external native turn. Production work needs cancellation propagation, binding
verification, receipt deduplication, timeout reconciliation and lifecycle ownership.
The bridge did not complete the issue, implement review or retire the agent.

The comments endpoint did not preserve the supplied `clientRequestId` in this
test. Retrying that helper cannot be assumed idempotent. The successful single
submission is the established result.

## OpenRig

Native launch probes returned exit 1 with `unsupported runtime "opencode"` and
`unsupported runtime "hermes"`. A `stub` control rig launched successfully.

The queue accepted addresses `opencode@native-control` and
`hermes@native-control` inside that registered rig without actual managed seats
at those addresses. The existing native conversations then used the CLI helper
to claim and complete their queue items.

| Check | OpenCode | Hermes |
| --- | --- | --- |
| Earlier context recalled | Passed | Passed after explicit stored-session resume |
| Queue claim and completion persisted | Passed | Passed |
| Transition actor matches supplied queue address | Passed | Passed |
| Product manages native runtime | Unsupported | Unsupported |
| Independent runtime identity verification | Not established | Not established |

OpenRig's recorded `transport:v1` provenance derives from the supplied session
header. It is not proof that OpenRig authenticated the underlying native
conversation. The isolated test proxy supplied no additional identity binding.

This corrects an overly broad interpretation of the earlier runtime gap:
**OpenCode/Hermes adapters are needed for OpenRig-managed execution, but not merely
to use its durable queue API from those harnesses.** A bridge still needs to own
notification and validated identity for externally running conversations.

## Hermes runtime identity finding

After the first client's connection ended, a later prompt to the saved live ID
returned `session not found`. Explicit `session.resume` using the original stored
session ID produced a different live ID and restored the previous conversation.
The model then recalled its original word and completed the OpenRig request.

Observed mapping:

```text
Stored conversation: 20261003_124053_7e1b11
Initial runtime ID:  2c8dd9d5
Resumed runtime ID:  f053d30a
```

A further attachment also needed explicit resume. This supports our distinction
between stable agent identity, stored conversation identity and live runtime
binding. The exact reaping policy was not determined in this test, and no claim
is made that the underlying cause was compression.

## Boundaries not tested

- Attaching to an arbitrary existing OpenCode TUI that has no accessible server.
- Connecting to an existing Hermes classic REPL. The test used the actual
  `hermes serve` WebSocket backend and its stored conversations.
- Herdr pane binding, concurrent human input, busy-turn delivery or interruption.
- Harness restart during submission, stale credentials or duplicate notification.
- Automatic retirement, worktree finalisation or a complete delegation workflow.
- Production remote access or multi-user isolation.
- Seed-only memory isolation for every subsequent backend: the OpenRig test
  conversations already contained the earlier Paperclip exchange. Context
  continuity is demonstrated, not a benchmark of long-term model memory.

## Environment and implementation notes

- Native servers ran on host loopback ports 17401 and 17402, with isolated homes
  under `/tmp/opencode/retinue-native/`.
- The evaluation copied existing auth files into those restricted homes without
  printing them. Copies and the test gateway token were deleted after stopping.
- Hermes dependency management is home-scoped. Initial isolated launches tried
  dependency preparation and failed to locate a valid committed environment.
  The successful fixture used a clean isolated home, disabled lazy installation,
  and referenced the existing installed dependency generation. This was fixture
  preparation, not a product-integration failure.
- Two HTTP proxies inside the evaluation containers provided access over the
  local Docker bridge. No host ports were published. This arrangement is an
  evaluation fixture, not a recommended authentication design.
- Both evaluation containers and recorded native server process groups were
  stopped. The live user conversations were not used as test recipients.

## Reproduction entry points

This is a machine-specific research fixture, not an installer. Paths in
`native-host.py` refer to the inspected local installation. It copies credentials,
so use it only with an explicitly intended account and run `native-stop.py` after
the experiment. Start the task containers using the earlier runbook first.

```bash
python3 evaluation/native-host.py
# Wait for both servers, then seed existing conversations.
node evaluation/native-probe.mjs seed

# Container-only proxies, if not already running.
docker exec -d retinue-eval-paperclip node /evaluation/container-proxy.mjs 17410 3100
docker exec -d retinue-eval-openrig node /evaluation/container-proxy.mjs 17411 17300

node evaluation/native-probe.mjs bridge
docker exec retinue-eval-openrig rig create native-control --runtime stub --json
node evaluation/native-probe.mjs openrig

python3 evaluation/native-stop.py
docker stop retinue-eval-paperclip retinue-eval-openrig
```

The recorded run needed a Hermes-only retry after its live binding expired, and
an OpenCode-only pass to preserve evidence separately. The collector reflects
those actual runs rather than a generic one-command test suite.

## Recommendation

Keep Paperclip as the leading task-backend candidate. We have now demonstrated
that existing native conversations can participate with real Paperclip run
attribution, without replacing those conversations or changing product source.

Use Retinue to own the missing integration: stable external-agent registration,
per-assignment run binding, harness notification, receipts and herdr lifecycle.
OpenRig remains viable as a queue backend, but using it that way leaves both native
runtime management and stronger caller identity to our integration, while retaining
its human/backlog limitations from the earlier evaluation.

The next engineering step is to turn the Paperclip process-holder demonstration
into a bounded external-runtime adapter. That adapter must stop and reconcile the
same native turn it starts before it can be trusted with cancellation or recovery.

Evidence: [native conversation results](evidence/native-conversation-results.json).
The collector asserted recalled context, Paperclip author/run attribution,
OpenRig queue completion/actor attribution and the native-launch refusals.
