# Herdr Relay: agent handover

Handover date: 2026-10-04. Package: `herdr-relay@0.1.0-dev.0`.

## Start here

**Continue with exact native interruption, adapter-host recovery and Hermes
delivery.** Reserved OpenCode delivery now persists a native message ID, delivers
once, and settles against a matching terminal response plus worker submission.
Explicit CLI pull remains supported. Read [the native delivery contract](native-opencode-v1.md)
before changing supervision. OpenCode session-wide abort is deliberately not used.

- Working directory: `/home/quintin/play/herdr-relay`.
- Product name: **Herdr Relay**. The user approved `herdr-relay` and explicitly
  wants it to remain a herdr plugin.
- The directory now uses the Relay name. Historical evaluation evidence retains
  paths from the earlier Retinue directory.
- Git is initialised on `main`. The requested GitHub destination is
  `quintindk/herdr-relay`. Inspect current Git and remote state before continuing.
- The repository is public under the MIT licence. The user authorised incremental
  commits and pushes after verification.
- Node 24, native ESM JavaScript, built-in SQLite, no npm dependencies or compile step.
- Read local/inherited instructions before working. Do not delegate to subagents
  unless the user or applicable instructions explicitly request delegation.

Read these documents in order:

1. [Specification v2](spec-v2.md): current architectural contract.
2. [First working slice](build-v1.md): commands, implementation scope and limitations.
3. [Scenario baseline](evaluation-baseline-v1.md): intended end-to-end behaviour.
4. [Native conversation evaluation](native-conversation-evaluation-v1.md): previous
   real-model continuity experiments and their limits.
5. [Product evaluation](evaluation-results-v1.md): why Paperclip was selected.

[Specification v1](spec-v1.md) is historical. Its standalone task engine and
one-active-assignment restriction are superseded.

## Product decisions to preserve

> The requirement is lightweight interaction backed by durable state. Structure
> should appear when work needs it, rather than being something you must configure
> before asking an agent for help.

The user rejects mandatory teams, job roles and permanent reporting hierarchies.
Agents primarily have context, repository bindings and optional capabilities.

| Component | Authority |
| --- | --- |
| Paperclip | Tasks, assignments, dependencies, review/acceptance and work-run history |
| Relay | Agent registration, native bindings, delivery receipts, runtime lifecycle and recovery |
| Herdr | Machines, workspaces, panes and terminal processes |
| Harness | Conversations, tools and model execution |
| Git | Branches, worktrees, changes and commits |

- One Paperclip agent identity per logical agent. Many identities share the Relay
  adapter implementation. Relay is integration software, not a reasoning manager.
- Paperclip retains bounded execution-run bookkeeping. Relay owns actual runtime
  lifecycle. Finishing a Paperclip run must not terminate a persistent conversation.
- No second task database in Relay. Its SQLite store holds integration state.
- CLI and a shared skill are the planned initial agent interface. Harness plugins
  are not a prerequisite. The shared skill has not been implemented yet.
- Multiple open obligations are allowed, with one executing turn per conversation.
  Waiting should release execution capacity. Submitted disposable workers remain
  reserved for corrections until acceptance.
- Submission, native settlement, acceptance, retirement and Git cleanup are distinct.
- Exact candidate acceptance is the eventual retirement trigger for task-scoped
  workers. Commit/merge/push and resource cleanup need their own authority.
- Gateway design is deferred. The user previously asked to finish the spec before
  creating a root README. There is still no root README.

### Scenarios driving the design

1. Daily driver starts a day-long inbox/Teams monitor. Relevant events lead to
   human work, agent work or delegation to an independent project agent.
2. Demo agent asks an independent landing-zone agent for an Azure subnet, answers
   clarification and consumes its result. No lifecycle authority is transferred.
3. Worktree worker updates a graph and submits an exact candidate. Daily driver
   checks, requests corrections, commits under the human's instruction, accepts
   and then retires the worker and cleans up eligible resources.

## Code map

| File | Purpose |
| --- | --- |
| `src/store.mjs` | SQLite bindings, credentials, runs, events, idempotency and native-state transitions |
| `src/service.mjs` | Authenticated Unix-socket HTTP API, publication serialisation, in-memory backend tokens |
| `src/client.mjs` | Unix-socket client, context loading, default state directory |
| `src/cli.mjs` | Service command, registration, work reads/receipts, operator cancellation/settlement |
| `src/adapter.mjs` | Paperclip external adapter factory, execution loop and environment diagnostics |
| `src/paperclip.mjs` | Backend API calls and comment publication/reconciliation |
| `src/protocol.mjs` | Validation, errors, canonical payload hashing and receipt marker |
| `src/opencode.mjs` | Local native HTTP client, identity checks and message-correlated observation |
| `src/supervisor.mjs` | Durable delivery intent, scoped worker context and restart reconciliation |
| `herdr-plugin.toml` | Herdr plugin manifest, currently one service-status action |
| `test/relay.test.mjs` | Ten persistence, protocol, CLI, service and adapter tests |
| `test/native.test.mjs` | Ten native HTTP fault, attribution and schema compatibility tests |
| `scripts/check.mjs` | Syntax checks across source, scripts and tests |
| `scripts/paperclip-smoke.mjs` | Real Paperclip external-package installation and run-attribution smoke test |
| `scripts/opencode-smoke.mjs` | Isolated real-model OpenCode test with deterministic Paperclip API |
| `docs/evidence/relay-build-smoke.json` | Sanitised successful real-backend evidence |
| `evaluation/` | Earlier investigative product/native fixtures, separate from the new implementation |

The package exports `createServerAdapter` through `src/adapter.mjs`. Its adapter
type is `herdr_relay`, CLI name is `herdr-relay`, and herdr plugin ID is
`synthswarm.herdr-relay`. The npm package is private and has not been published.
Name availability has not been checked.

## Current protocol and state

Default state lives under `$XDG_STATE_HOME/herdr-relay`, falling back to
`~/.local/state/herdr-relay`. `RELAY_STATE_DIR` or `--state-dir` overrides it.

- `relay.sqlite`: WAL, full synchronous writes, integration records and events.
- `relay.sock`: local HTTP-over-Unix-socket transport, mode `0600`.
- `admin-token`: operator credential, mode `0600`.
- Parent state directory: mode `0700`.

This is a trusted local Unix-user boundary. Binding-scoped credentials prevent
accidental cross-agent calls through the API, not hostile same-user filesystem
access. Worker contexts contain Relay credentials, never Paperclip run tokens.
Binding credentials are retained in the restricted database to support recovery
of identical registration requests.

### Dispatch through completion

1. Paperclip invokes the adapter with a run token, agent identity and task ID.
2. Adapter persists a dispatch through `POST /runs` and attaches its run token in
   service memory. It reattaches while polling, including after Relay restarts.
3. Worker lists and reads its run. Task content is fetched live from Paperclip.
4. Worker acknowledges before doing work, then submits a stable key, summary and
   candidate string through the CLI.
5. Adapter requests publication. Relay writes a marked, correctly attributed
   Paperclip comment. Submission remains separate from native completion.
6. Pull mode requires operator-attested settlement. Native OpenCode mode requires
   a matching terminal assistant response and idle reserved conversation. Only
   after required publication and settlement does the adapter return its result.

There is no automatic task status change, review transition or acceptance yet.
Candidate strings are recorded, not independently computed or verified.

### Important invariants

- Registration rejects a changed configuration or agent/conversation alias.
- Binding revision is currently fixed at 1. Dispatch validates it. Rebinding and
  verified continuation are not implemented.
- Dispatch identity is `(companyId, Paperclip runId)`. Identical retry returns the
  original Relay run. Changed request payload conflicts.
- A SQLite partial unique index prevents two unsettled runs on one binding.
- Submission requires acknowledged work. Identical retry returns the result.
  Changed result content conflicts.
- Submission does not release the conversation. Native settlement does.
- Cancelling unacknowledged pull work settles it immediately. Cancelling claimed
  work only records the request, blocks late submission and awaits settlement.
- Native delivery intent also prevents immediate cancellation settlement before
  acknowledgement. Once intent is stored, there is no automatic prompt replay.
- Worker credentials cannot settle, cancel, register peers or access other bindings.
- Paperclip origin is pinned to a state directory to prevent backend substitution.

### Backend uncertainty

Before posting a result comment, Relay persists publication state `uncertain`.
The comment embeds the Relay run ID and result digest. A later read reconciles
only a matching body, agent ID and Paperclip run ID.

**An absent matching comment does not permit another POST.** The first request
could still commit. Such a run remains unresolved. There is no operator override
or durable idempotent backend mutation mechanism for this case yet.

Do not weaken this into blind retries. The original prototype's `clientRequestId`
was not retained by Paperclip's comment endpoint.

## What has actually been verified

The last completed checks were:

```bash
npm run check
npm test
npm pack --dry-run
```

- All twenty tests passed. Syntax and package checks passed.
- Tests cover database reopen, service restart while an adapter continues running,
  changed-payload rejection, duplicate registration, stale/overlapping dispatch,
  worker credential scope, CLI registration, publication uncertainty, and waiting
  for settlement after submission/cancellation.
- Real Paperclip `2026.1001.0` loaded the external package through its install API.
- Two separate agents, labelled OpenCode and Hermes, each submitted one attributed
  comment through the new adapter/service protocol.
- Both backend runs remained active before settlement, then succeeded.
- Herdr `0.9.3` accepted the manifest through a disabled temporary plugin link.

**The new-build smoke test used deterministic protocol calls, not native model
turns.** Labels in the evidence do not establish working harness connectors.

Earlier experiments did execute real OpenCode and Hermes model turns in existing
conversations and write correctly attributed Paperclip comments. Those used a
process-holder bridge and machine-specific helpers. They established continuity
and connectivity, not cancellation, delivery safety or a production supervisor.

The new native OpenCode smoke also passed against OpenCode `1.18.34` with
`github-copilot/gpt-6-astra`. It exercised the actual Relay adapter, service,
supervisor and CLI with a real model, prior conversation context, one attributed
result and automatic correlated settlement. Its Paperclip API is deterministic.
See [native evidence](evidence/native-opencode-smoke.json).

## Immediate next work

### 1. Strengthen native delivery and add Hermes

Reserved server-backed OpenCode delivery is implemented. Hermes remains pull-only.
Inspect native APIs and earlier fixtures before choosing the Hermes contract.

- Verify exact native instance and conversation before dispatch.
- Bind credentials through runtime context without placing secrets in prompts.
- Persist dispatch intent before native effects.
- Identify the particular native invocation so completion/interruption can be
  attributed to it, rather than inferring success from general conversation idle.
- Require a submitted result for success and native observation for settlement.
- Preserve conversation state after the Paperclip run ends.
- Handle an already-busy conversation without mixing in unrelated human work.

### 2. Prove cancellation and recovery

- Cancel the assigned invocation and verify it stopped before returning.
- Keep uncertainty visible if the connection drops around delivery or interruption.
- Test Relay restart and adapter-host restart separately. Only the first is tested.
- Never convert timeout or bridge exit into proof of native termination.
- Keep new native work blocked while prior execution is uncertain.

### 3. Add agent participation and backend work semantics

- Shared skill using actual implemented CLI commands.
- Runtime-context provisioning and verified rebinding/continuation.
- Questions, waiting and later continuation in bounded runs.
- Paperclip review-stage and candidate-revision mapping.
- Then provisioning, acceptance-driven retirement, cleanup and herdr views.

Use the ten acceptance criteria in spec v2 as the milestone checklist. The current
slice satisfies parts of them, not the complete milestone.

## Areas needing attention during implementation

These are limits visible in the current code, not promises that they are solved:

- Adapter `timeoutSec` requests cancellation but can wait indefinitely for claimed
  work to settle or for result publication to reconcile.
- Initial dispatch happens before the adapter polling/reconciliation loop. A lost
  initial response needs deliberate recovery using the stable backend run key.
- OpenCode delivery verifies stored conversation identity and correlates native
  message IDs. There is no native process incarnation ID or atomic reservation.
- Schema 2 retains schema-1 pull records and rejects future versions. Native state
  is stored as optional run JSON fields. Add explicit migrations for later changes.
- Socket startup probes for an existing listener and removes stale sockets. Test
  competing process startups before treating supervision as production-ready.
- Run tokens remain in service memory for attached runs until service exit.
  Token retirement, rotation and expiry handling need an explicit contract.
- Backend issue checkout, work ownership transitions and heartbeat continuation
  policies are not implemented by this adapter.
- State pinning distinguishes backend origins, not separate backend databases
  behind the same origin.
- Service supervision, Windows transport, cross-machine routing and release
  packaging remain undecided.

## Source references and integration discoveries

Pinned Paperclip source:

- `/tmp/opencode/retinue-paperclip`
- Release `v2026.1001.0`, commit `8f8a0ab7effbd6a0584107d8038736c134ee5047`.
- `packages/adapter-utils/src/types.ts`: execution/cancellation contracts.
- `server/src/adapters/plugin-loader.ts`: external package loading.
- `server/src/routes/adapters.ts`: actual installation API.
- `server/src/services/heartbeat.ts`: run credentials and invocation lifecycle.
- `packages/adapters/hermes/src/gateway/server/execute.ts`: existing external
  service adapter precedent. Its gateway protocol differs from native Hermes
  `/api/ws`. Do not conflate them.

Two discoveries from the real build test:

1. Install with `POST /api/adapters/install` and
   `{"packageName":"/absolute/package/path","isLocalPath":true}`. The pinned
   external-adapter guide's `POST /api/adapters` example returned 404.
2. The adapter must declare `supportsLocalAgentJwt: true` to receive
   `ctx.authToken`. Without it the real run failed with missing authentication.

Earlier native references:

- `evaluation/native-probe.mjs`: OpenCode HTTP and Hermes WebSocket protocol usage.
- `evaluation/native-host.py`: isolated harness launch, machine-specific paths.
- `evaluation/native-lease.mjs`: old process run-holder, not a supervisor to copy.
- `evaluation/native-receipt.mjs`: old CLI result helper.
- `/home/quintin/.hermes/hermes-agent/tui_gateway/contracts/sessions.py`.
- `/home/quintin/.hermes/hermes-agent/tui_gateway/contracts/prompt_voice.py`.
- `/home/quintin/.hermes/hermes-agent/tests/e2e/core/terminal/_gateway_client.py`.

Previously inspected versions: herdr `0.9.3` / API protocol 22, OpenCode `1.18.34`,
Hermes `0.21.5+2164.gfdec926`. Recheck before relying on exact installed behaviour.

## Retained environment and cleanup state

- Docker image: `retinue-evaluation:2026-10-03`.
- New-build container: `herdr-relay-build-smoke`, stopped after verification.
  It retains Paperclip state at `/home/node/relay-paperclip-state` and a read-only
  bind mount of this repository at `/relay`.
- Earlier containers `retinue-eval-paperclip` and `retinue-eval-openrig` were also
  stopped after their evaluations. Recheck state before use.
- Starting a container alone does not start Paperclip. Its main command is
  `sleep infinity`. Resume the retained build instance with:

```bash
docker start herdr-relay-build-smoke
docker exec -d -e PAPERCLIP_RUNNER_ENABLED=false herdr-relay-build-smoke \
  paperclipai run --data-dir /home/node/relay-paperclip-state
# Wait for /api/health, then:
docker exec herdr-relay-build-smoke node /relay/scripts/paperclip-smoke.mjs
docker stop herdr-relay-build-smoke
```

- Smoke reruns create fresh company/agent/task records. Existing failed probes
  from installation-route and JWT debugging remain in the evaluation database.
- No new Relay service was left running on the host by the build tests.
- Herdr's temporary `synthswarm.herdr-relay` link was removed and absence verified.
  **`HERDR_CONFIG_PATH` did not isolate the plugin registry.** Do not use it as a
  sandbox for plugin mutations.
- Earlier native process groups were stopped and copied native credentials removed
  after the prior evaluations. `/tmp/opencode/retinue-native` retains historical
  fixture files. Inspect before reusing rather than assuming valid credentials or
  live conversations.

## Recommended first action

Run `npm run check && npm test`, then continue from the native delivery limitations.
OpenCode `1.18.34` prompt delivery joins busy execution and its abort is session-wide.
Do not add automatic abort based on a status check. Keep evidence explicit about
real model execution versus deterministic fixtures.
