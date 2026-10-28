# Herdr Relay

Native tasks, agent collaboration and durable node services for **Herdr and
OpenCode**. Relay owns its task backend. No external task tracker is required.

**0.2.1 is being prepared for release.** The latest published version is
[0.2.1-rc4](https://github.com/quintindk/herdr-relay/releases/tag/v0.2.1-rc4).
Preparing this repository does not publish or deploy the stable release.

## What it does

- Human-owned tasks with stable references, comments, dependencies and source links.
- Durable agents across receiving-chat changes and multiple machines.
- Explicit work dispatch, human steering, questions, escalation and reviewed results.
- Revocable interactive-provisioning and headless-automation grants.
- Node-owned cron schedules with persistent Inbox results and optional online-only
  requester messages. Reporting is separate from cron firing and business coverage.
- A native terminal board: **Tasks, Agents, Inbox, Grants and Schedule**.
- A themed OpenCode attachment sidebar and a focused Herdr `prefix+t` panel.
- Verified compatible upgrades, rollback and evidence-preserving recovery.

## Requirements

- Node.js **24+**, npm and Git.
- Linux, including WSL2. Managed services use user-systemd.
- An installed, authenticated OpenCode V2 service for OpenCode agents. Release
  checks cover **2.1.0 and 2.1.2**. The RC4 sidebar also passed on 2.2.0; that is
  not a substitute for the complete supported-host release matrix.
- Herdr **0.9.3+** for interactive pane provisioning and the panel shortcut.
- Python **3.11+** for shortcut installation; Python is also used by PTY tests.

The CLI is a Node.js package distributed through immutable
[GitHub releases](https://github.com/quintindk/herdr-relay/releases), not a
standalone binary or an npm-published service. CLI activation, service upgrades,
plugin configuration and skill installation are separate operations.

## Start here

- **New installation:** [Installation and onboarding](docs/installation-and-onboarding.md).
- **Already on RC4:** [Upgrade without re-enrolling](docs/service-upgrades.md).
- **Daily use:** `herdr-relay tui` and [terminal controls](docs/task-board.md).
- **Commands:** `herdr-relay --help`, `herdr-relay native --help` and
  [CLI usage](docs/native-cli.md).
- **What is changing:** [0.2.1 release preparation](docs/release-0.2.1.md).

Do not reset a backend, delete a journal or repeat bootstrap to perform an upgrade.
Published versions and their assets are immutable.

## Documentation

| Area | Guide |
| --- | --- |
| Architecture and state ownership | [Architecture](docs/architecture.md) |
| Authority, credentials and failure boundaries | [Security](docs/security.md) |
| Durable agents and receiving chats | [Receiving chats](docs/native-receivers.md) |
| Tasks, Inbox and result decisions | [Task Inbox](docs/native-task-inbox.md) |
| Task references and imported aliases | [Task identity](docs/native-task-references.md) |
| Interactive peer preparation and dispatch | [Interactive provisioning](docs/native-interactive-provisioning.md) |
| Reusable authenticated automation | [Headless setup](docs/headless-authenticated-setup.md) |
| Explicit headless capabilities | [Task and artefact capabilities](docs/approved-headless-capabilities.md) |
| Destination-local headless configuration | [Headless provisioning](docs/native-headless-agents.md) |
| Scheduled result visibility | [Run result notifications](docs/run-result-notifications.md) |
| Native CLI access from an agent | [CLI bridge](docs/node-cli-bridge.md) |
| Recovery without manufactured completion | [Maintenance and recovery](docs/maintenance-recovery.md) |
| Managed agent instructions | [Skill installation](docs/skill-installation.md) |
| OpenCode plugin implementation | [Plugin package](packages/opencode-relay/README.md) |
| Tests, isolated fixtures and source checks | [Development](docs/development.md) |
| Release gates and immutable publication | [Releasing](docs/releasing.md) |

The repository describes the supported native product, not an integration roadmap.
Old specifications, development ledgers, captured run reports and evaluation
workspaces are retained in Git history and published tags, not in the current
source/package. See [the changelog](CHANGELOG.md).

## Develop

```sh
npm ci
npm ci --prefix packages/opencode-relay
npm run check
npm test
npm run test:v2
```

Checks include source imports, documentation links, native CLI boundaries and
generated TUI freshness. Model/PTY integration checks use disposable HOME/XDG
directories and explicit fixtures. They do not certify complete mailbox/Teams
coverage or the delivery of real external business effects.

## Licence

[MIT](LICENSE).
