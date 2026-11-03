# Herdr Relay 0.2.4

Patch release for version-owned installer completion. Publication does not install
the release on any host or upgrade running services.

## Fixes

- **Candidate-owned setup:** a handover-capable installer stages and audits the
  requested release, activates its CLI, then runs the candidate's setup entrypoint
  in a separate Node process. Setup code no longer comes from the caller's older
  module cache. The installation lock stays held until the child finishes.
- **Verified scope:** the child checks the package fingerprint, its own version
  and the active public CLI before changing local configuration. The caller checks
  the response identity, fingerprint and completion before reporting success.
  Unknown protocols or missing entrypoints fail before activation.
- **Honest completion:** output identifies `installer.callerVersion`,
  `installer.version` and `installer.mode`. A lost or invalid acknowledgement is
  `unconfirmed`, not successful setup. Its executor version remains unconfirmed
  (`null`) and `installer.expectedVersion` identifies the requested target. The
  verified CLI remains activated and the
  same install command safely reconciles an idempotent retry.
- **Preserved preferences:** forward `--config-dir`, `--herdr-config` and
  `--no-herdr`, including relative paths. Retain conflicting keys, disabled plugins,
  unrelated preferences, existing panels and running chats. No backend, node or
  OpenCode service is restarted by release installation.
- **Real process regression checks:** verify candidate-only setup, actual released
  legacy CLIs, candidate-first bootstrap, retries and incomplete setup using packed
  packages and isolated HOME/XDG directories.

## Bootstrap boundary

Already-published 0.2.2 and 0.2.3 installers cannot gain this handover retroactively.
Updating a CLI symlink does not change the process already running. Version 0.2.2
does not run Herdr setup at all. Version 0.2.3 performs its known setup, but still
runs the caller's implementation rather than the target's setup code.

When first upgrading those clients, use the checksum-verified candidate CLI as
described in [installation](installation-and-onboarding.md#upgrading-a-pre-handover-cli).
That route executes the new installer once; it does not depend on blindly rerunning
an old installer. Once a handover-capable CLI is active, subsequent `release install`
operations delegate to the staged release automatically. Legacy target releases
without the protocol retain an explicitly reported compatibility path.

The minimum supported upgrade source remains **0.2.1-rc4**. Protocol stays
**relay/0.2**, backend schema **2** and node journal schema **1**. Backend/node
service upgrades and OpenCode plugin updates remain separate, explicit operations.
No migration, reset, credential copying or re-enrolment is required.

Release gates require clean source, matching version/tag metadata, installed
OpenCode **2.1.0, 2.1.2 and 2.2.5** checks, installer-process regression evidence and
a fresh zero-vulnerability production audit.
