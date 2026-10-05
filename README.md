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
- Exact candidate digests, independent review evidence and Paperclip acceptance.
- Owned worktree provisioning, idempotent commit finalisation and guarded cleanup.
- Acceptance-driven retirement and recovery after Relay or Paperclip restart.
- Bounded monitoring schedules and atomic source checkpoints.
- Herdr work/inbox pane, placement reconciliation and Linux systemd installation.
- Per-node SSH administration and remote adapter attachment.

The automatic-control boundary is a dedicated Relay-owned runtime. Shared
human-controlled conversations are opt-in and conservative. See
[node topology](docs/node-topology.md) and [verified coverage](docs/implementation-status.md).

## Requirements

- Linux for managed runtimes and automatic service installation.
- Node.js 24+, Git and a Paperclip instance.
- OpenCode or Hermes installed and authenticated on the native worker node.
- Herdr 0.9.3+ for plugin actions and panes.

No npm dependencies or compilation step are required. The package is a development
build and is not published to npm.

## Start

```bash
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

## Documentation

- [Current handover](docs/handover.md) and [specification](docs/spec-v2.md).
- [Optional local model gateway](docs/model-gateway.md).
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
