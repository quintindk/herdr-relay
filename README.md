# Herdr Relay

**0.2.0-rc.6: reusable native headless agents and a more usable task board.**
Start with the [Evo/Surface installation and onboarding guide](docs/installation-and-onboarding.md)
and [RC6 scope/readiness](docs/release-0.2.0-rc.6.md).

Download the package, checksums and verification report from
[GitHub Releases](https://github.com/quintindk/herdr-relay/releases).
The package requires Node.js 24+ inside Linux/WSL2. It is not a standalone executable.

RC6 adds [native headless provisioning](docs/native-headless-agents.md), wider task
titles and scrollable questions/review text. It also corrects the generated-cache
identity check without relaxing credential checks.

RC5 added [safe backend/node upgrades](docs/service-upgrades.md)
and retires the legacy SSH wrapper/remote adapter. There is one public CLI,
`herdr-relay`. Normal upgrades preserve enrolments and data rather than repeating onboarding.
RC4's [agent messages/status updates](docs/agent-messages.md) remain supported.
The native backend does not require Paperclip. Legacy Paperclip operation remains
available and is documented separately below. This is not complete specification
v3 certification or a production/public-ingress release.

Connect Paperclip work to persistent OpenCode and Hermes agents in herdr.

Relay is a herdr plugin, local coordination service, CLI and external Paperclip
adapter. Paperclip owns tasks and review. Relay owns native bindings, delivery
receipts and verified runtime/resource lifecycle. Agents do not need a manager,
team hierarchy or project to participate.

## Version 0.2.0 direction

The [v3 specification for 0.2.0](docs/spec-v3.md) defines the next implementation
contract: a native Tasks and Collaboration backend, equal multi-machine Relay
nodes, backend-mediated delegation, first-class questions and human escalation,
and local offline scheduling. Paperclip becomes optional through provider
contracts, with GitHub Issues as the next independent provider. OpenCode v2 is
the target, including separate server/TUI plugins and managed runtime migration.
See the [migration assessment](docs/opencode-v2-migration-assessment.md).
This is planned architecture. The implementation and requirements below describe
the current build.

The isolated [OpenCode v2 spike](docs/opencode-v2-spike.md) now verifies a real
2.1.0 service, read-only tool, typed RPC, native settlement and two TUI clients.
See [the spike package](packages/opencode-relay/README.md) for reproducible checks
and remaining migration gates.

The [v3 implementation ledger](docs/implementation-v3.md) tracks the native
backend, node journal/execution, offline scheduling and provider work. A separate
development backend is installed locally. The complete 0.2.0 contract remains
under implementation.
The [acceptance ledger](docs/acceptance-v3.md) lists passed, partial and outstanding
release gates, including the manual second-machine installation.
The [Paperclip task migration guide](docs/paperclip-task-migration.md) describes
read-only export/planning and explicit native import before laptop v2 cutover.
The [native CLI](docs/native-cli.md) provides explicit `native` enrolment,
task/comment/execution/schedule and worker commands, separate from the legacy
commands below. Native task panes include schedules and published occurrences.
Native [durable agents and receiving chats](docs/native-receivers.md) separate
standing enrolment from `/relay-attach`. Persistent crons target the stable agent,
while admitted work retains its original native conversation. The explicit Herdr
launcher and new-chat TUI path support replacement without recreating schedules.
Native [interactive provisioning](docs/native-interactive-provisioning.md) adds
backend-addressed Herdr workspace creation, existing-instance reuse, replacement
attachment and separately authorised task dispatch. Same-node testing uses that
same request path, not a local shortcut.

## Implemented

- Separate native agent identities, existing conversations and revisioned resume.
- Dedicated owned runtimes with verified interruption, shutdown and continuation.
- Durable dispatch, progress, submission, questions and bounded continuation.
- Peer task delegation, human-owned tasks, dependencies and receipt-only inbox events.
- Daily task queries, full task/comment reads, bounded all-actor activity reports,
  guarded human changes and durable external identity links. No tracker scheduling,
  ingestion, due dates or planning metadata.
- Read-only company backlog previews and explicit human-authorised standing folder
  enrolment, separate from task assignment and exact-chat delegation history.
- Exact candidate digests, independent review evidence and Paperclip acceptance.
- Experimental explicit human grants for coordinator review of opted-in direct
  children. The root parent's final review remains human.
- Owned worktree provisioning, idempotent commit finalisation and guarded cleanup.
- Acceptance-driven retirement and recovery after Relay or Paperclip restart.
- Bounded monitoring schedules and atomic source checkpoints.
- Native cron routines with persistent folder ownership, stable routing agents,
  and per-occurrence conversation pinning across new chats.
- Herdr work/inbox pane, placement reconciliation and Linux systemd installation.
- Per-node SSH administration and remote adapter attachment.

Interactive harnesses launch normally through Herdr. An explicitly configured
Relay listener registers their detected conversations in Paperclip without
launching replacement runtimes. These entries are observation-only until verified
task delivery is attached. Dedicated Relay-owned runtimes remain an explicit
headless option for exclusive automatic control. See
[node topology](docs/node-topology.md) and [verified coverage](docs/implementation-status.md).

## Requirements

- Linux for managed runtimes and automatic service installation.
- Node.js 24+, Git and a Paperclip instance.
- OpenCode or Hermes installed and authenticated on the native worker node.
- Herdr 0.9.3+ for plugin actions and panes.

The Relay coordinator needs no compilation step. Run `npm ci` to install the
pinned OpenCode plugin SDK used by the optional in-process bridge tools. The
package is a development build and is not published to npm.

## Start

```bash
npm ci
npm run check
npm test
node src/cli.mjs service --paperclip-url http://127.0.0.1:3100
```

Run the service in a separate terminal, or install the user service:

```bash
node src/cli.mjs install --paperclip-url http://127.0.0.1:3100
node src/cli.mjs status
```

Install this checkout as an external Paperclip adapter using its supported
`POST /api/adapters/install` endpoint with `packageName` set to the absolute checkout
path and `isLocalPath: true`. Configure each Paperclip agent with adapter type
`herdr_relay`, its Relay binding ID/revision and private operator context path.

For integrated provisioning, schedules and recovery, start Relay with
`--backend-context /private/operator-backend.json`. See
[agent provisioning](docs/agent-provisioning.md) and
[installation](docs/inbox-and-installation.md).

Link the herdr plugin:

```bash
herdr plugin link /absolute/path/herdr-relay
```

## Chat Startup

Use `relay_task_list` for filtered, paginated company tasks, including human-owned
and terminal tasks. Follow `nextCursor` with unchanged scope until `complete`, and
retain `fetchedAt` and warnings. Use `relay_task_inspect` for full text,
`relay_task_comments` for full comment bodies and `relay_task_activity` for explicit
`[from,to)` audit reports. `relay_tasks` remains a legacy preview, not a complete
report. `relay_delegations` is restricted to work delegated from the
exact origin chat, not general startup lookup. Configured busy callers can read
tasks, ready peers, delegations and notification history without enabling incoming
assignments. Discovery waits up to 30 seconds on invocation and never grants access.
Retry a transient startup read once after a brief pause, then report the limitation
and continue independent startup checks. Do not substitute reviews for the backlog.

Explicit human-authorised enrolment uses `relay_enrolment_candidates` then
`relay_enrol_agent` with `key`, exact `directory`, optional discovered `observedId`
and `reserved: true`. Without a bridge credential, use an enrolled coordinator or
the user-authorised operator CLI: `herdr-relay agent enrolment-candidates`, then
`herdr-relay agent enrol --directory /exact/folder --key KEY --reserved`. Never
self-elevate after a failed read. No Relay service restart is required. Missing
tools need the OpenCode plugin reloaded at idle, without interrupting active work.

The persisted reservation follows fresh chats, not old review rights. Linked
worktrees and worker directories require `relay_worker_prepare` adoption. Worker
reservations take priority on every reconciliation. **Enrolment revoke is not
implemented:** disarming cannot permanently withdraw an active standing grant.
Operator repair is required. See the [bridge contract](docs/opencode-bridge.md).
These additions have local automated coverage, not live workflow certification.

Interactive worker preparation defaults to exact repository allowlists. Trusted
single-user installations may opt into `workerProvisioning.mode: "localUser"` to
create cross-repository worktrees or plain Herdr workspaces at explicit local
directories, bounded by the service account and an active-worker limit. See
[interactive workers](docs/interactive-workers.md).

## Documentation

- [Cron routines](docs/cron-routines.md): explicit Paperclip-backed recurring tasks
  with paused creation, timezone previews and pinned native targets.
- [Daily task tracker](docs/daily-task-tracker.md): query limits and completeness,
  human capture/edit/comment/complete/reopen/cancel, external references, revision
  checks and uncertain writes. Fixture coverage is not live workflow certification.
- [Version 0.2.0 scheduling direction](docs/spec-v3.md#10-local-scheduling):
  node-owned clocks, offline execution and durable occurrence reconciliation.
- [Task hierarchy pane](docs/task-board.md): browse tasks by agent or human owner
  through Relay, with folding, search and live refresh.
- [Herdr Relay skill](skills/herdr-relay/SKILL.md) replaces the former envoy skill.
  The RC7 development [skill installer](docs/skill-installation.md) manages both
  shipped native skills with safe updates, local-edit conflicts and private backups.
  It does not restart chats. [Relay work](skills/relay-work/SKILL.md) teaches the
  scoped native execution protocol. Historical Paperclip instructions remain in
  separate legacy documentation, not in the installed native skills.
- [Specification v3 for version 0.2.0](docs/spec-v3.md),
  [current handover](docs/handover.md) and
  [archived designs and evaluations](docs/archive/README.md).
- [Optional local model gateway](docs/model-gateway.md).
- [Local Paperclip service](docs/paperclip-service.md).
- [Herdr-first agent registration](docs/herdr-agent-registration.md).
- [Opt-in OpenCode delivery bridge](docs/opencode-bridge.md).
- [Interactive workers](docs/interactive-workers.md): scoped create/adopt tools,
  asynchronous readiness, child-task waits and origin-bound human review.
  Fixture-verified implementation, not live certification of worker provisioning.
- [Coordinator review](docs/coordinator-review.md): explicit root-origin human
  grant/revoke, immutable child opt-in and exact parent-run reviewer proof.
  Offline-tested, with live tests deferred by the user. A recorded candidate-ready
  comment is not wake admission, and rejection needs explicit follow-up. No fully
  verified final workflow or complete autonomous recovery is claimed.
- [Native OpenCode](docs/native-opencode-v1.md), [native Hermes](docs/native-hermes-v1.md)
  and [managed runtimes](docs/managed-runtimes.md).
- [Task commands](docs/task-commands.md), [questions](docs/questions-v1.md),
  [candidate review](docs/candidate-review.md) and [worktrees](docs/worktree-resources.md).
- [Recovery](docs/paperclip-recovery.md), [lifetimes](docs/lifetimes-and-rebinding.md),
  [credentials](docs/credentials.md) and [remote nodes](docs/node-topology.md).
- [Scenario verification](docs/scenario-verification.md) and sanitised evidence in
  [`docs/evidence`](docs/evidence).

## Verification

The automated suite exercises persistence, restart, uncertainty, credentials,
candidate review, lifecycle, SSH attachment and Git resource recovery. Opt-in smoke
scripts additionally verify real Paperclip, real OpenCode/Hermes model turns,
systemd restart and SSH transport. Native tests consume model usage.

The GitHub Actions template is [`docs/ci-check.yml`](docs/ci-check.yml). Copy it to
`.github/workflows/check.yml` using GitHub credentials with workflow permissions
to enable hosted checks. It is not currently active.

Production email/Teams access and real Azure provisioning are external connector
responsibilities. Scenario tests use explicitly synthetic source events and Azure
resource IDs. Physical second-node deployment and macOS managed lifecycle are not
claimed as verified.

## Licence

[MIT](LICENSE).
