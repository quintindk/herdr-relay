# Herdr Relay 0.2.0-rc.1

Date: 22 October 2026.

This is the first **native-workflow release candidate for trusted local testing**,
not a declaration that every specification v3 release gate is complete. No npm
publication or GitHub release is implied by producing the local artifact.

Verification checkpoint: 1,534 root tests passed, one skipped, and all 57 v2 tests
passed. The local Herdr/native-model preparation, reuse, replacement and separate
dispatch test passed. Clean production-only artifact installation, CLI startup,
server/TUI imports and backend startup passed. A fresh artifact audit remains
unverified because npm registry DNS is unavailable.

A subsequent stable-agent schedule projection regression was fixed before
publication. All 52 focused board checks and an actual deployed-backend TUI
read/render/quit probe pass. The unpublished candidate was rebuilt with the fix.

## Included native scope

- Standalone Tasks/Collaboration backend, native board and owner CLI.
- Durable node/agent identities, human `/relay-enrol` and `/relay-attach`, including
  creation of an empty native session from OpenCode's landing screen.
- Persistent agent schedules across replacement chats, exact-chat options and
  conservative offline scheduling/publication.
- Scoped execution, questions, continuation and exact human candidate review.
- Interactive provisioning on an explicitly granted destination node. The same
  backend-to-node request path runs on this machine and on another configured node.
- New discussion enrolments, existing interactive-instance reuse, explicit
  replacement and separately authorised bounded task dispatch.
- Native model selection is explicitly pinned and checked for new sessions.
  Existing conversations retain their human-selected model.
- TUI-originated Herdr native-session reporting. Launch titles and desired
  arguments are not accepted as readiness proof.

See [durable receivers](native-receivers.md), [native CLI](native-cli.md) and
[interactive provisioning](native-interactive-provisioning.md).

## Install the candidate locally

Requirements: Linux, Node.js 24+, Git, authenticated OpenCode 2.x and Herdr 0.9.3
for interactive provisioning. The verified OpenCode versions are 2.1.0 and 2.1.2.
Admission of other 2.x versions is not compatibility certification.

```bash
mkdir relay-rc-test
cd relay-rc-test
npm install /absolute/path/herdr-relay-0.2.0-rc.1.tgz
./node_modules/.bin/herdr-relay native --help
```

Runtime SDK and TUI dependencies are installed from the root package. Native
operation no longer depends on a development-only nested `npm ci`.

For a fresh local backend installation:

```bash
node node_modules/herdr-relay/scripts/install-native-backend.mjs
```

The installer uses the standard local backend state directory and Linux user
service. Do not run it over another deployment without inspecting its state and
service paths. Owner credentials remain private in the state directory.

Install the native OpenCode integration with an explicit owner context and human
session as described in the CLI guide. Use `/relay-enrol` in the intended human
chat. Interactive provisioning remains disabled until the destination operator
configures its policy and a human grants a specific initiating agent authority.

This RC has no migration for old session-derived development enrolments. Existing
Paperclip task import is a separate feature, not automatic cutover.

## Candidate verification

```bash
npm run check
node --test --test-concurrency=1 test/*.test.mjs
npm run test:v2
node scripts/verify-package.mjs --output /absolute/artifact/directory
```

The package verifier creates a tarball, checks included runtime files, installs it
in an empty consumer using production dependencies only, runs its CLI, imports its
server/TUI plugins and starts its native backend. By default it also requires a
successful production vulnerability audit with zero findings.

`--skip-audit` is available for explicitly offline artifact checks. Its output
marks `auditVerified: false` and `vulnerabilities: null`. It must not be reported
as a passed fresh audit or used to conceal registry unavailability.

During this increment the pinned Solid dependency was updated to 1.9.17 after
npm reported transitive Seroval advisories. Both dependency installations then
reported zero vulnerabilities. A later fresh audit encountered registry DNS
failure, which remains a separate verification limitation.

## Known release limitations

- Physical second-machine installation/provisioning is not certified yet.
- The public Cloudflare Access enforcement gate remains open. Use the local
  authenticated origin for this RC; do not treat this as public-ingress approval.
- Complete crash-during-write, orphan recovery, credential rollback/cutover and
  combined Git/daemon failure matrices remain incomplete.
- Hermes/Herdr lifecycle parity and external-provider execution/write parity are
  not certified by this OpenCode native increment.
- Interactive provisioning currently opens OpenCode root conversations in plain
  folders. It does not create Git repositories/worktrees or accept arbitrary
  executable arguments from requesting models.
- Destination provisioning requires backend connectivity to recheck grants.
  Cancellation/revocation never pretends that already-created resources vanished.
- Ready receipts are dated observations, not permanent availability promises.
- The installation is a trusted Unix-user boundary, not isolation from hostile
  same-user processes. Provisioning policy/grants are off by default.

The [acceptance ledger](acceptance-v3.md) distinguishes automated fixtures,
real-model runs, actual-human interactions and outstanding release gates.
