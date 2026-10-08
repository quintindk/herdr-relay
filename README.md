# Herdr Relay

Connect Paperclip work to persistent OpenCode and Hermes agents in herdr.

Relay is a herdr plugin, local coordination service, CLI and external Paperclip
adapter. Paperclip owns tasks and review. Relay owns native bindings, delivery
receipts and verified runtime/resource lifecycle. Agents do not need a manager,
team hierarchy or project to participate.

## Implemented

- Separate native agent identities, existing conversations and revisioned resume.
- Dedicated owned runtimes with verified interruption, shutdown and continuation.
- Durable dispatch, progress, submission, questions and bounded continuation.
- Peer task delegation, human-owned tasks, dependencies and receipt-only inbox events.
- Read-only company backlog previews and explicit human-authorised standing folder
  enrolment, separate from task assignment and exact-chat delegation history.
- Exact candidate digests, independent review evidence and Paperclip acceptance.
- Experimental explicit human grants for coordinator review of opted-in direct
  children. The root parent's final review remains human.
- Owned worktree provisioning, idempotent commit finalisation and guarded cleanup.
- Acceptance-driven retirement and recovery after Relay or Paperclip restart.
- Bounded monitoring schedules and atomic source checkpoints.
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

Use `relay_tasks` for the company backlog, including human-owned/imported tasks and
description previews. `relay_delegations` is restricted to work delegated from the
exact origin chat, not general startup lookup. Configured busy callers can read
tasks, ready peers, delegations and notification history without enabling incoming
assignments. Discovery waits up to 12 seconds on invocation and never grants access.
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

## Documentation

- [Deferred scheduling plan](docs/scheduling-plan.md): Horology-style tools over
  native Paperclip routines, with safe busy-agent and reminder semantics.
- [Task hierarchy pane](docs/task-board.md): browse tasks by agent or human owner
  through Relay, with folding, search and live refresh.
- [Herdr Relay skill](skills/herdr-relay/SKILL.md) replaces the former envoy skill.
  Install it as `~/.config/opencode/skills/herdr-relay/SKILL.md`, then restart
  OpenCode when idle without interrupting active workers. It teaches backlog reads,
  explicit enrolment, Relay chat tools, origin-bound human review and safe
  recovery. [Relay work](skills/relay-work/SKILL.md) remains the worker CLI protocol.
- [Current handover](docs/handover.md) and [specification](docs/spec-v2.md).
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
