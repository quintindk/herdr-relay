# Herdr Relay: current handover

Updated: 2026-10-04. Package `herdr-relay@0.1.0-dev.0`. SQLite schema 4.

## Start here

The local Linux implementation now covers native OpenCode and Hermes delivery,
owned runtime interruption/resume, Paperclip host recovery, bounded questions,
task delegation, candidate review, worktree finalisation, acceptance-driven
retirement, monitoring schedules, inbox receipts, herdr views and service installation.

The user approved dedicated owned runtimes as the automatic-control boundary.
Per-node Relay services now support SSH administration and remote adapter attachment.
The precise evidence and remaining deployment limitations are in
[implementation status](implementation-status.md) and [node topology](node-topology.md).
Shared human-controlled sessions have no atomic input reservation. Managed runtimes
on macOS and a physical second-node deployment have not been verified.

The user requested continued implementation with verified commits and pushes.
Do not delegate unless explicitly authorised by the user or applicable instructions.
The repository is public, MIT-licensed, and tracks `quintindk/herdr-relay` on `main`.
Inspect Git status before continuing. GitHub DNS failed near the end of this work,
so check for local commits ahead of `origin/main`. A one-command Git DNS override
using GitHub's address resolved through the Wi-Fi interface successfully pushed the
pending commits without changing machine DNS. Re-resolve before reusing an address.
Do not rewrite history.

## Required reading

1. [Specification v2](spec-v2.md) and [implementation status](implementation-status.md).
2. [Scenario verification](scenario-verification.md).
3. [Managed runtimes](managed-runtimes.md), [native OpenCode](native-opencode-v1.md),
   and [native Hermes](native-hermes-v1.md).
4. [Paperclip recovery](paperclip-recovery.md), [questions](questions-v1.md),
   [task commands](task-commands.md), and [candidate review](candidate-review.md).
5. [Provisioning](agent-provisioning.md), [lifetimes](lifetimes-and-rebinding.md),
   [worktrees](worktree-resources.md), [schedules](schedules.md),
   [installation/inbox](inbox-and-installation.md), and [placement](placement.md).

`build-v1.md`, the earlier evaluation documents and `spec-v1.md` are historical
milestone records. Their original limitations are superseded by later feature
documents. Do not copy the historical process-holder bridge into production code.

## Authorities and invariants

| Component | Owns |
| --- | --- |
| Paperclip | Tasks, ownership, dependencies, interactions, review and work-run history |
| Relay | Bindings, delivery receipts, integration mutations and runtime/resource lifecycle |
| Herdr | Terminal placement and restoration |
| Harness | Native conversations and model/tool execution |
| Git | Candidate bytes, commits, branches and worktrees |

- Agents are independent identities. No mandatory manager, team or project.
- One unsettled native turn per binding. Waiting questions release capacity only
  after native settlement, while the obligation remains in Paperclip.
- Persist intent before native delivery, interruption, backend mutation and Git effects.
- Native POSTs are never replayed after uncertain delivery. Absent messages are
  not proof that a request cannot still arrive.
- Result comments have no trusted backend idempotency guarantee. Uncertain POSTs
  are read back using exact body, author and original publication-run attribution.
- Task/interaction creates use backend idempotency keys plus local changed-payload
  checks. Assignments and answers reconcile by read-back rather than blind overwrite.
- A terminal native receipt is persisted and survives backend delay or replay eviction.
  Idle without a matching receipt is not completion.
- Submitted work, native completion, accepted candidate, Git commit, runtime stop
  and worktree removal are separate facts.
- Candidate acceptance is exact and current. A lost decision blocks new task
  dispatch until reconciled. Workers cannot accept their own candidates.
- Task-scoped workers remain reserved for corrections. Controller-authorised
  acceptance triggers owned-runtime retirement and eligible cleanup. Dirty or
  ignored files block cleanup without undoing acceptance.
- Shared servers are never automatically aborted or killed. Owned mode requires
  a dedicated private native endpoint and verified process identities.
- The trust boundary is one local Unix user, not isolation from hostile same-user processes.

## Code map

| Files | Responsibility |
| --- | --- |
| `store.mjs`, `protocol.mjs` | SQLite state, revisions, idempotency, receipts and validation |
| `service.mjs`, `service-lock.mjs`, `client.mjs`, `cli.mjs` | Local authenticated API, exclusive service ownership and commands |
| `adapter.mjs`, `paperclip.mjs`, `backend-recovery.mjs` | External adapter, publication and replacement-run recovery |
| `opencode.mjs`, `hermes.mjs`, `supervisor.mjs` | Native identity, delivery, observation and scoped worker contexts |
| `runtime-host.mjs`, `runtimes.mjs`, `resume.mjs` | Detached owned servers, process-group verification, interruption and continuation |
| `provisioning.mjs`, `lifecycle.mjs`, `resources.mjs` | Agent/worktree provisioning, acceptance retirement and Git finalisation |
| `work.mjs`, `operations.mjs`, `review.mjs`, `candidate.mjs` | Questions, task mutations, revision-bound review and file-state digests |
| `inbox.mjs`, `schedules.mjs` | Atomic source checkpoints, notifications and bounded backend wakes |
| `placement.mjs`, `views.mjs`, `installation.mjs` | Herdr identity reconciliation, interactive overview and Linux service lifecycle |
| `skills/relay-work/SKILL.md` | Shared agent participation protocol |
| `scripts/plugin-launch.sh`, `herdr-plugin.toml` | Herdr actions/pane and Node discovery |

All application code is Node 24 native ESM with built-in SQLite. No npm dependencies
or compilation. The external adapter exports `createServerAdapter`, type
`herdr_relay`. Plugin ID: `synthswarm.herdr-relay`.

## State and credentials

Default state: `$XDG_STATE_HOME/herdr-relay` or `~/.local/state/herdr-relay`.
`RELAY_STATE_DIR` / `--state-dir` override it.

- `relay.sqlite`: durable integration state, WAL and full synchronous writes.
- `service-lock.sqlite`: exclusive transaction used only for process ownership.
- `relay.sock`: local HTTP socket, `0600`.
- `admin-token`, adapter/worker context files: private local credentials.
- `runtimes/`: launch configuration, private native credentials, atomic process
  descriptor and native log. Process IDs are checked with Linux start identities.
- Optional `--backend-context FILE`: board/operator authority for provisioning,
  schedules, recovery and background acceptance-retirement reconciliation.

Backend run tokens stay in service memory and are reattached by the adapter.
Replacement-run recovery fences the old adapter's writes. Token rotation and
retention policy remain follow-up work. Native credentials never enter prompts.
Schema 1–3 data is retained when schema 4 tables are opened. Future schemas are refused.

## Verification actually performed

Latest normal suite: **69 tests passed**, plus `npm run check`. Run the suite again
after changes, rather than relying on this count as a permanent fact.

| Probe | Evidence |
| --- | --- |
| Real Paperclip external adapter | `scripts/paperclip-smoke.mjs` |
| Real Paperclip crash/restart and operator recovery | `scripts/paperclip-recovery-smoke.mjs` |
| Real backend questions, continuation, human tasks and review | `scripts/paperclip-question-smoke.mjs` |
| All three scenario families with real backend/Git, deterministic workers | `scripts/scenario-smoke.mjs` |
| Real OpenCode model with deterministic backend | `scripts/opencode-smoke.mjs` |
| Real Hermes model with deterministic backend | `scripts/hermes-smoke.mjs` |
| Owned native cancellation, shutdown and same-conversation resume | `scripts/managed-opencode-smoke.mjs`, `scripts/managed-hermes-smoke.mjs` |
| Combined real Paperclip + OpenCode/Hermes questions and continuation | `scripts/live-paperclip-opencode.mjs`, `scripts/live-paperclip-hermes.mjs` |
| Real model graph edit, independent candidate verification, commit, acceptance and retirement | `scripts/live-worktree-smoke.mjs` |
| Herdr pane and native placement | Actual temporary pane opened/inspected/closed, `scripts/placement-smoke.mjs` |
| Real systemd crash/restart | `scripts/service-supervision-smoke.mjs` |
| Unit generation | `scripts/installation-smoke.mjs` |
| Actual SSH node status and adapter attachment | `scripts/remote-smoke.mjs` |

Sanitised outputs are in `docs/evidence/`. These probes consume model usage when
marked native. They use isolated homes and copied credentials, which must be
removed after stopping their owned processes. Production inbox/Azure access was
not exercised. Azure IDs and source messages in scenarios are explicit fixtures.

## Important discoveries

- OpenCode `prompt_async` can join busy work. Its abort endpoint is session-wide.
  Only dedicated owned mode authorises automated interruption. Shared mode detects
  visible conflicting input but cannot prevent a concurrent human request.
- OpenCode commits message metadata before text parts. Missing parts are pending
  evidence, not an immediate payload conflict.
- Hermes runtime IDs differ from stored session IDs. Replay epochs identify gateway
  incarnations. Some terminal events omit `persisted_turn`, requiring the documented
  reserved-segment fallback. Interrupted partial output proves failure, never success.
- Paperclip marks orphaned external runs `failed/process_lost` after a 60-second
  controller lease. It requires execution reconciliation before a replacement run.
  Relay's operator recovery preserves the original native invocation and attribution.
- OpenCode creates ignored `.opencode` dependency files. Worktree retirement blocks
  on these. The live fixture explicitly removed its own disposable dependencies
  before retrying. Do not add blanket ignored-file deletion.
- systemd uses `KillMode=process` so coordinator restart does not kill managed native
  runtimes. Runtime stop separately verifies the entire owned process group is gone.
- Herdr server PATH can omit NVM Node. The plugin launcher resolves `RELAY_NODE`,
  PATH or local NVM. `HERDR_CONFIG_PATH` does not isolate the plugin registry.

## Pinned integration sources

- Paperclip package `2026.1001.0`, inspected source
  `/tmp/opencode/retinue-paperclip`, commit `8f8a0ab7effbd6a0584107d8038736c134ee5047`.
- OpenCode `1.18.34`, `/tmp/opencode/relay-opencode`, commit
  `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
- Hermes `0.21.5+2164.gfdec926`, `/home/quintin/.hermes/hermes-agent`, commit
  `fdec926ef54391edcf6caad5f7f6761fdcccdaa2`.
- Herdr `0.9.3`, protocol 22. Recheck current client/server before control operations.

## Retained environment

Evaluation image: `retinue-evaluation:2026-10-03`. Containers are retained for
evidence but were stopped after probes. `herdr-relay-recovery-v2` contains the
real-backend scenario state and an installed OpenCode binary. Its mount points at
the current `herdr-relay` checkout. The older `herdr-relay-build-smoke` mount still
points at the former `herdr-retinue` path and must not be reused blindly.

Temporary herdr plugin links/panes and systemd test units were removed. Native
fixture processes and copied credentials were cleaned up. Inspect live process
identity before any further cleanup. Never stop the user's regular Hermes or
OpenCode processes based on executable name alone.

## Next work

1. Deploy the approved owned-runtime node model to an actual second machine and
   verify its SSH identity, backend connectivity and local runtime permissions.
2. Enable hosted CI by placing `docs/ci-check.yml` in `.github/workflows/check.yml`
   with workflow-scoped GitHub credentials. The current token cannot create workflows.
3. Treat shared-session input, provider compaction and native crash before a
   terminal receipt as explicit uncertainty boundaries. Do not invent safe replay.
4. Production inbox/Teams and Azure resource integrations need their own source
   authority and provider-side idempotency. Current scenarios deliberately use fixtures.

The owned-runtime scope and per-node SSH topology were approved by the user. The
README now documents the implemented workflow. Final local checks passed, test
containers and temporary services were stopped, and all commits were pushed.
