# Herdr Relay

Native tasks, agent collaboration and durable node services for **Herdr and
OpenCode**. Relay owns its task backend. No external task tracker is required.

**[0.2.7](https://github.com/quintindk/herdr-relay/releases/tag/v0.2.7)** adds bounded
peer collaboration, concise agent instructions and evidence-preserving attachment
recovery. Install only published, verified release assets. Existing installations
must be on **0.2.1-rc4 or later** to upgrade. See the
[0.2.7 release notes](docs/release-0.2.7.md).

## What it does

- Human-owned tasks with stable references, comments, dependencies and source links.
- Durable agents across receiving-chat changes and multiple machines.
- Explicit work dispatch, human steering, questions, escalation and reviewed results.
- Revocable interactive-provisioning and headless-automation grants.
- Scope-aware grant matching, capacity admission and evidence-preserving interactive repair.
- Node-owned cron schedules with persistent Inbox results and optional online-only
  requester messages. Reporting is separate from cron firing and business coverage.
- A native terminal board: **Tasks, Agents, Inbox, Grants and Schedule**.
- A themed OpenCode attachment sidebar and a focused Herdr `prefix+t` panel.
- Verified compatible upgrades, rollback and evidence-preserving recovery.

## Requirements

- Node.js **24+**, npm and Git.
- Linux, including WSL2. Managed services use user-systemd.
- An installed, authenticated OpenCode V2 service for OpenCode agents. Release
  checks cover **2.1.0, 2.1.2 and 2.2.5**.
- Herdr **0.9.3+** for interactive pane provisioning and the panel shortcut.
- Python **3.11+** for shortcut installation; Python is also used by PTY tests.

The CLI is a Node.js package distributed through immutable
[GitHub releases](https://github.com/quintindk/herdr-relay/releases), not a
standalone binary or an npm-published service. Service upgrades and OpenCode plugin
configuration remain separate from CLI activation. See [installation](docs/installation-and-onboarding.md)
for managed skills and local Herdr panel setup.

## Start here

- **New installation:** [Installation and onboarding](docs/installation-and-onboarding.md).
- **Already on RC4:** [Upgrade without re-enrolling](docs/service-upgrades.md).
- **Daily use:** `herdr-relay tui` and [terminal controls](docs/task-board.md).
- **Two-agent work:** [Bounded collaboration](docs/collaboration.md).
- **Commands:** `herdr-relay --help`, `herdr-relay native --help` and
  [CLI usage](docs/native-cli.md).
- **Release details:** [0.2.7 release notes](docs/release-0.2.7.md) and
  [the changelog](CHANGELOG.md).

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
| Blocked preparation and capacity recovery | [Interactive repair](docs/interactive-recovery.md) |
| Reusable authenticated automation | [Headless setup](docs/headless-authenticated-setup.md) |
| Explicit headless capabilities | [Task and artefact capabilities](docs/approved-headless-capabilities.md) |
| Destination-local headless configuration | [Headless provisioning](docs/native-headless-agents.md) |
| Scheduled result visibility | [Run result notifications](docs/run-result-notifications.md) |
| Native CLI access from an agent | [CLI bridge](docs/node-cli-bridge.md) |
| Coordinator/peer work, budgets and continuation | [Collaboration](docs/collaboration.md) |
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
