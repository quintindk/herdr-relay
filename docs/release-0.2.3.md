# Herdr Relay 0.2.3

Patch release for complete local Herdr panel setup, agent renaming and actionable provisioning errors.
Publication does not install the release on any host or upgrade running services.

## Fixes

- **Rename agents:** select an agent in Agents, or open its detail, and press `n`.
  Edit its Relay name, review it and confirm. Agent identity, receiving chat,
  workspace, permissions, work and schedules remain unchanged. Heartbeats do not
  invalidate the name preview. Conflicting edits require a fresh preview and
  uncertain publications reconcile their original key in Inbox. Upgraded nodes
  synchronise local enrolment labels from backend events or restart snapshots.
  Native chat titles and Herdr workspace labels are not renamed by this action.
- **Automatic Herdr panel setup:** `release install` links Herdr to the verified
  installed Relay release, including a stale link to the old TUI. It installs the
  native `prefix+t` binding and reloads running Herdr sessions.
- **Safe local preferences:** preserve unrelated shortcuts, explicitly disabled
  Relay plugins and existing panel processes. Shortcut conflicts fail preflight
  before registration or key changes. Missing Herdr is a reported skip. No stopped
  Herdr server, OpenCode service or Relay service is started or restarted.
- **Install options:** use `--no-herdr` to skip local panel setup on a backend-only
  host, or `--herdr-config TOML` to select a custom Herdr configuration.
- **Honest completion:** JSON output includes separate skill and Herdr results.
  Failed local setup returns `complete: false` and a non-zero exit while retaining
  CLI activation evidence. Resolve the error and rerun the install command.
- **Concurrent installs:** retain the installation lock through skill and Herdr
  setup so simultaneous release installs cannot leave the panel linked to a
  different release from the public CLI.
- **Actionable provisioning errors:** distinguish a changed project ID for the
  same OpenCode chat from a wider conversation identity mismatch. Project-only
  failures tell the initiating agent to ask for human-confirmed `/relay-attach`,
  then reuse the existing worktree and original preparation ID/key/payload.
  Error codes remain in the agent-visible message even if the tool host flattens
  structured errors. No identity pin is refreshed and no request is queued until
  the model/identity checks pass. Unknown private exceptions remain sanitised.

## Installation and upgrades

Run the **0.2.3 CLI** to obtain the automatic setup behaviour. An older installer
can activate 0.2.3 without running its new setup code. If upgrading through the
0.2.2 CLI, rerun `herdr-relay release install --version 0.2.3` after activation.
This finishes setup without re-enrolment or service restarts.

The minimum supported upgrade source remains **0.2.1-rc4**. Protocol stays
**relay/0.2**, backend schema **2** and node journal schema **1**. Existing
backend/node service upgrades and OpenCode plugin updates remain separate,
explicit operations. No migration, reset, credential copying or re-enrolment is
required. See [installation](installation-and-onboarding.md) and
[service upgrades](service-upgrades.md).

Release gates require clean source, matching version/tag metadata, supported
OpenCode **2.1.0 and 2.1.2** host checks, installed-package behaviour and a fresh
zero-vulnerability production audit. Functional tests do not waive the audit.
