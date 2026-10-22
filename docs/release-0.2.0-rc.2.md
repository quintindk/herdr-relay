# Herdr Relay 0.2.0-rc.2

Date: 22 October 2026. Prepared candidate, not automatically published or tagged.

RC2 closes the installation/onboarding gaps found in RC1. It retains RC1's native
workflows and adds supported installed-release administration commands. Use the
[primary Evo/Surface guide](installation-and-onboarding.md), not checkout scripts
or the deleted remote-testing branch.

## Changes

- `native backend install/init/run/status/inventory/backup/ingress-check`.
- `native node bootstrap/join/revoke`, with immutable operation keys, backend
  instance checks and private repeat-safe configuration materialisation.
- Separate node daemon and human operator credentials. Surface's human can enrol,
  attach and handle their task/inbox decisions without receiving Evo's root token.
  Backend administration, credential issuance, task import and provisioning grants
  remain root-only. Human enrolment is scoped to the intended node and roots or
  explicitly authorised local-user scope.
- `native plugin install/uninstall`, including pre-session installation, safe JSONC
  editing, unrelated-comment/settings preservation, upgrade-path replacement and
  private configuration backups. First-run legacy terminal migration is not bypassed.
- Read-only `native doctor`, with WSL/platform, user-systemd, role/identity, native
  service and plugin checks. Doctor does not start services or certify ingress.
- `native tasks source/companies/export/plan/import` from the installed artifact.
  Paperclip remains read-only during export. Import is atomic, root-authorised,
  guarded by the backend service lock and idempotent for the same export.
- Clean production-only artifact verification exercises separate Evo/Surface homes,
  actual scoped HTTP authorisation, enrolment/attachment, plugin setup, source
  export, repeated import, online backup and systemd-unit dry-run generation.
- Artifacts are immutable by version/path: the verifier refuses different bytes
  under an existing filename. It stages `SHA256SUMS` and a verification report.

## Target environment

Evo: Linux backend and local node. Surface: node inside WSL2 with systemd. Require
Node.js 24+ and a Linux-native OpenCode installation. Verified OpenCode versions
are 2.1.0/2.1.2; Surface's upgrade target is 2.1.2. The source Paperclip instance
and initial/final exports are on Surface. Root credentials and task import stay
on Evo. The same release artifact is used on both machines.

Do not upgrade Surface's source harness until legacy runtime producers are frozen
and outstanding work is settled. Run OpenCode 2 once before installing the plugin
so global terminal preferences can migrate. Keep authentication/config/data backups.

## Publication and cutover gates

Clean-home and scoped real-TUI fixture checks do not prove physical Surface
installation or the contents of its real Paperclip export. The live cutover still
requires source inventory/freeze, a validated final export/plan, backups, explicit
approval to archive/reset Evo's development state and physical node acceptance.

The current deployed backend is not upgraded or cleared by preparing this release.
New node bundles require the backend's `scopedNodeBootstrap` capability. Doctor
reports an upgrade requirement rather than bypassing the credential boundary.

Public ingress and the fresh production dependency audit are separate gates with
sanitised evidence in the acceptance ledger. No backend reset, live task import,
Surface upgrade, npm publication or GitHub release occurs automatically.

Other RC1 limitations remain: incomplete full v3/recovery matrices, no physical
second-machine certification yet, trusted Unix-user boundary, and no automatic
failover while a WSL VM is stopped. This is an evaluation candidate, not complete
production release certification.
