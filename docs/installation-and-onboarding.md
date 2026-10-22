# Evo backend, Evo node and Surface node onboarding

Target: `0.2.0-rc.5`. Evo runs the backend and a node. Surface runs a node inside
**WSL2 with systemd**. The source Paperclip instance is on **Surface**.

This guide uses installed-release commands only. It does not require cloning a
branch, running nested development `npm ci`, copying node_modules or manually
assembling credential JSON. No step silently clears a database or imports tasks.

**Already enrolled?** Do not repeat the fresh-backend/reset steps for an upgrade.
Use [service upgrades](service-upgrades.md) to preserve identities, data and enrolments.

## 0. Release and cutover gates

Before a live reset:

- Verify the artifact and checksums, clean production installation and test reports.
- Complete the fresh production dependency audit. An unavailable audit is not zero findings.
- Export/plan Surface's Paperclip data and resolve real source obligations.
- Back up Evo's current backend, node state and configuration. Keep source backups.
- Verify Cloudflare Access enforcement before Surface joins over the public endpoint.
- Confirm the exact old state/service paths to archive. Never delete a journal to
  bypass an instance mismatch. Keep the backend-root credential on Evo.

The current candidate can be evaluated without a live reset. Tests using separate
Evo/Surface home directories are not physical Surface acceptance.

## 1. Select the same immutable release on both machines

Distribution: a [GitHub **prerelease**](https://github.com/quintindk/herdr-relay/releases)
with these immutable assets:

- `herdr-relay-0.2.0-rc.5.tgz`
- `SHA256SUMS`
- `herdr-relay-0.2.0-rc.5.tgz.verification.json`
- Release notes and this guide.

An explicitly pushed version tag publishes only after GitHub Actions tests,
installed-package checks and audit pass. Download the three assets into one
directory. This is a Node.js package with executable CLI entrypoints, not a
standalone native binary. Verify checksums from the trusted release channel.
Checksums detect changed bytes; they are not a signing-key attestation.

```bash
umask 077
# In the directory containing the release assets:
sha256sum -c SHA256SUMS
node --version
npm --version
```

Require Node.js **24+**, Linux binaries inside WSL and Git. Do not use Windows
`node.exe` for the WSL installation. Bootstrap the normal CLI in a user-owned npm
installation, then activate the verified version store before installing services:

```bash
npm install --global --omit=dev --ignore-scripts /absolute/download/herdr-relay-0.2.0-rc.5.tgz
herdr-relay --version
herdr-relay release install --version 0.2.0-rc.5
RELAY=herdr-relay
"$RELAY" native --help
```

`release install` audits/stages the versioned package and activates the recognised
CLI symlink without restarting a service. Subsequent commands are ordinary
`herdr-relay` commands. Services/plugins pin that release's absolute path internally.
Retain referenced old releases for rollback. Do not remove a release while a service,
plugin, CLI or retained upgrade operation references it. CLI activation is not data reset.

## 2. Surface: export before upgrading or replacing the source runtime

Installing the Relay CLI does not require OpenCode 2 or alter Paperclip. Make a
persistent private source directory, not a temporary export or a Git checkout:

```bash
PRIVATE="$HOME/.local/state/herdr-relay-cutover"
mkdir -p "$PRIVATE"
chmod 700 "$PRIVATE"
"$RELAY" native tasks source --url http://127.0.0.1:3100 \
  --local-trusted --output "$PRIVATE/paperclip-source.json"
"$RELAY" native tasks companies --source "$PRIVATE/paperclip-source.json"
"$RELAY" native tasks export --source "$PRIVATE/paperclip-source.json" \
  --company ACTUAL_COMPANY_ID --output "$PRIVATE/paperclip-initial.json"
"$RELAY" native tasks plan --file "$PRIVATE/paperclip-initial.json" \
  --output "$PRIVATE/paperclip-initial-plan.json"
```

For an authenticated source, replace `--local-trusted` with
`--token-file /private/operator-token.txt`. Secret values never go in command arguments.
`localTrusted` is literal-loopback HTTP only. Company listing is discovery, not
proof that an export is exhaustive. The export performs its own scope/completeness checks.

Take a recoverable backup of the actual source Paperclip database and relevant old
Relay state. Pause legacy runtime-producing routines and new admissions; settle
live work, checkouts, questions, publications and reviews through their original
installation. Do this **before** changing Surface's OpenCode binary. A task status
alone does not prove that a process stopped. Do not edit exports to conceal blockers.

After the source is frozen, create **new** final export/plan files:

```bash
"$RELAY" native tasks export --source "$PRIVATE/paperclip-source.json" \
  --company ACTUAL_COMPANY_ID --output "$PRIVATE/paperclip-final.json"
"$RELAY" native tasks plan --file "$PRIVATE/paperclip-final.json" \
  --output "$PRIVATE/paperclip-final-plan.json"
```

Keep Paperclip intact and frozen. Transfer the final export and plan privately to
Evo. Do not transfer the Paperclip source token or Evo's root owner credential.
Record the plan's digest/counts. Export files are not ongoing synchronisation.

## 3. Evo: backup, explicit archive boundary, then backend installation

On the existing deployment, use its valid current root context:

```bash
ROOT_OWNER="$HOME/.local/state/herdr-relay-backend/owner.json"
"$RELAY" native backend inventory --context "$ROOT_OWNER"
"$RELAY" native backend backup --output /private/new-backup-path.sqlite
"$RELAY" native backend install --dry-run
```

**Stop here for explicit cutover approval.** Inventory old schedules, native work
and `reimportRisk`. A Surface Paperclip export does not preserve Evo-only tasks,
native comments or later native edits. Reconcile or explicitly disposition those
before clearing anything; a backup is not the same as importing them into the new
store. Even an empty edit-candidate list is not a complete relationship/activity audit.

Also inventory outstanding provisioning and local runtime obligations. Stop the known Relay
node/backend services only after obligations are handled. Human OpenCode chats
must not be killed as a shortcut. Archive the precise backend/node state directories
and relevant config/service files with their permissions. Never archive or remove
Surface's Paperclip source as part of Evo's native reset.

Once that boundary is approved and the standard target state paths are clear:

```bash
"$RELAY" native backend install
"$RELAY" native backend status --context "$ROOT_OWNER"
"$RELAY" native backend inventory --context "$ROOT_OWNER"
```

Expect a fresh backend instance, new root credential and initially empty collections.
If old data remains, stop: installation intentionally reuses existing state rather
than deleting it. A new backend invalidates old node credentials/journal identities.
Do not restore old node files into the new installation.

The origin binds to loopback port 3210 by default. Backend state is separate from
node state. The default Linux user service is `herdr-relay-backend.service`.

## 4. Evo: verify remote ingress and issue both node bundles

Configure the existing tunnel to the loopback origin. Before remote join:

```bash
"$RELAY" native backend ingress-check --url https://relay.synthswarm.com \
  --context "$ROOT_OWNER" --access "$HOME/.config/portcullis/access.env"
```

All four checks must pass: unauthenticated and actor-only calls are blocked at
Access; Access-only reaches Relay but is denied there; Access plus actor succeeds.
Origin authentication denial is not proof that Cloudflare enforced Access.
An ingress failure is a gate, not permission to disable checks.

```bash
PRIVATE="$HOME/.local/state/herdr-relay-cutover"
mkdir -p "$PRIVATE"
chmod 700 "$PRIVATE"
"$RELAY" native node bootstrap --context "$ROOT_OWNER" --key evo-clean-v1 \
  --name Evo --url http://127.0.0.1:3210 --local-user \
  --output "$PRIVATE/Evo.bundle.json"
"$RELAY" native node bootstrap --context "$ROOT_OWNER" --key surface-clean-v1 \
  --name Surface --url https://relay.synthswarm.com --local-user \
  --access "$HOME/.config/portcullis/access.env" --output "$PRIVATE/Surface.bundle.json"
```

`--local-user` deliberately permits human enrolment in any accessible local folder
on that node. Use one or more `--root /absolute/node/folder` arguments instead for
narrower scope; Surface paths are Surface's Linux paths, not Evo's. Node IDs are
opaque, generated once and independent of these display names.

Each private bundle contains **two distinct credentials**:

- Daemon credential: its node's automation authority, not backend administration.
- Human operator credential: that node's enrolments/attachments and the same human's
  task/inbox decisions. It cannot create nodes, issue credentials, import task data
  or create provisioning grants. It is not Evo's backend-root token.

Bundles also carry the backend instance and chosen transport/Access credentials.
Keep them mode 0600. Repeating the same bootstrap request/key reconciles the same
credentials; changed requests are refused. `node revoke --bundle FILE --key KEY
--context "$ROOT_OWNER"` revokes both roles. Revoked bundles cannot be reused to
restore access. A reset requires fresh bundles/identities, not journal deletion.

## 5. Evo: join its own node

```bash
"$RELAY" native node join --bundle "$PRIVATE/Evo.bundle.json"
"$RELAY" native node install --config "$HOME/.local/state/herdr-relay-native/node.json"
"$RELAY" native plugin install --replace-context
```

Use `--replace-context` only at this explicit cutover to replace an old Relay TUI
context. Configuration backups are private; unrelated settings/plugins are retained.
Existing recognised Relay release paths are replaced, not duplicated. Explicitly
disabled Relay directives and ambiguous JSON/JSONC files require reconciliation.

Plugin installation can occur before any OpenCode chat exists. `/relay-enrol` from
Home creates an empty session and asks for confirmation. Enrol the intended Evo
workspaces. It does not silently adopt all existing chats or recreate old jobs.

## 6. Surface: WSL2, OpenCode upgrade and plugin onboarding

Operate inside the intended WSL distribution and Linux user account:

```bash
ps -p 1 -o comm=
systemctl --user show-environment >/dev/null
node --version
command -v node
opencode --version
command -v opencode
```

PID 1 should be systemd and the user manager must work. Keep runtime/state files
in the Linux home filesystem, not `/mnt/c`. A stopped WSL VM cannot run local cron
ticks; Relay does not automatically fail over its schedules to Evo.

After the source is frozen and old work settled, privately back up OpenCode config,
data/state and provider authentication. Inventory the current installation method
and old plugins. The verified target is **OpenCode 2.1.2**, not an untested `latest`.

- For an existing installer supporting it, `opencode upgrade 2.1.2` is verified CLI
  syntax. Select the actual installation method if necessary.
- For package-managed V1, follow the official migration guide: remove only that
  managed V1 package before installing V2. The npm V2 package is `@opencode/cli`;
  in a user-owned npm/NVM installation, install `@opencode/cli@2.1.2` without sudo.
- Do not guess a service name, delete the OpenCode database or overwrite unrelated
  configuration. V1 plugins/server integrations are API-breaking and need review.
- Start V2 once **before** Relay plugin installation so existing global terminal
  preferences can migrate to `cli.json`. Verify authentication, models, skills,
  agents, MCP servers and the actual stored model. Optional server-config conversion
  is not a prerequisite. Do not point V1 at converted V2-only configuration.

References: [official V2 migration](https://opencode.ai/v2/docs/migrate-v1),
[CLI configuration](https://opencode.ai/v2/docs/cli/config),
[server configuration](https://opencode.ai/v2/docs/config).

Transfer **only Surface's private bundle** through your existing private transfer
mechanism. Copy it into a private Linux-home directory before use, with mode 0600:

```bash
PRIVATE="$HOME/.local/state/herdr-relay-cutover"
mkdir -p "$PRIVATE"
chmod 700 "$PRIVATE"
# Example after a private transfer; do not paste its contents into chat:
install -m 600 /absolute/private-transfer/Surface.bundle.json "$PRIVATE/Surface.bundle.json"
"$RELAY" native node join --bundle "$PRIVATE/Surface.bundle.json"
"$RELAY" native node install --config "$HOME/.local/state/herdr-relay-native/node.json"
"$RELAY" native plugin install
"$RELAY" native doctor
```

Expect node name Surface, a distinct node ID, the same backend instance as Evo,
private local daemon/operator files, active node service and both plugins. Doctor
does not start/upgrade OpenCode, change permissions or certify ingress/cutover.
Use `/relay-enrol` in Surface's intended workspaces and `/relay-attach` in manually
opened replacement chats. Ordinary enrolment is not a provisioning grant.

For services surviving user logout, inspect lingering with `loginctl show-user
"$USER" -p Linger`. Enabling it is an explicit human/OS administration choice,
not something Relay does automatically. It cannot keep a shut-down WSL VM alive.

## 7. Evo: import Surface's final task export

Privately place the final export and plan on Evo, verify their digest/counts and
retain the source spelling/company identity. Back up the new backend too. Pause
new node admissions while the backend is stopped for the atomic import:

```bash
"$RELAY" native tasks plan --file /private/paperclip-final.json
"$RELAY" native backend backup --output /private/pre-import-backup.sqlite
systemctl --user stop herdr-relay-backend.service
"$RELAY" native tasks import --file /private/paperclip-final.json \
  --context "$ROOT_OWNER" --state-dir "$HOME/.local/state/herdr-relay-backend" \
  --confirm-digest EXACT_DIGEST_FROM_PLAN --source-frozen --legacy-relay-settled
systemctl --user start herdr-relay-backend.service
"$RELAY" native backend status --context "$ROOT_OWNER"
```

The flags attest completed source checks; they do not freeze Surface remotely.
The importer refuses a running backend lock and requires Evo's root credential.
Surface's operator or daemon credentials cannot import. Import creates tasks,
comments, source mappings and history, not executions, schedules or agents.
`in_progress` becomes owner-held `todo`; completed/cancelled states stay unchanged.
Original assignees/project IDs remain source metadata, not runtime authority.

An identical retry returns its original receipt without duplicating tasks or
overwriting native edits. A changed export for the same source scope conflicts.
Do not execute work until counts, representative full text/comments and both graphs
have been reconciled. Keep Paperclip frozen and recoverable during verification.

## 8. Acceptance and rollback

Record both node/agent IDs and actual versions. Before calling onboarding complete:

- Both nodes heartbeat to the same instance through their chosen transport.
- Each human can enrol/attach without root-token copying; new chats retain jobs.
- A bounded task, question/escalation and exact human review cross nodes.
- A granted interactive agent opens visibly on the requested node; work is separate.
- Disconnect/reconnect and restart preserve identity and publish one result only.
- Imported counts, comments, priorities and parent/dependency links match the plan.

Physical Surface checks and the real source export cannot be replaced by simulated
homes or fixtures. If rollback is needed before new native work/edits, stop both
paths and choose one authoritative store before restoring exact archived services,
state and credentials. Once native work has occurred, do not restore an old database
and resume jobs as if those external effects never happened; reconcile them first.

`native plugin uninstall` removes only recognised Relay directives, preserving
subsequent unrelated edits. It does not revoke credentials, remove tasks or stop
services. Credential revocation and package/service rollback remain explicit.
