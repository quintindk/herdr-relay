# Backend and node upgrades

The public CLI is `herdr-relay`. A **node** is a Relay participant; nodejs is its
runtime. Managed maintenance targets Linux user-systemd, including WSL2.

Upgrades preserve the backend instance, node/agent identities, credentials,
enrolments, tasks, schedules, journals, pending work and original publication keys.
Do not bootstrap/join again or delete state to perform an upgrade.

The minimum supported source is **0.2.1-rc4**. Older development releases and
cross-schema migrations are unsupported. Unsupported state is refused, not reset.

## 1. Inspect and activate the intended CLI

```sh
herdr-relay --version
herdr-relay node status
herdr-relay backend status
herdr-relay doctor
```

CLI and service versions are separate. Backend status on a node-only machine is
not remote backend administration. Doctor checks this node's backend connection.

Activate the exact **published** target version first. The examples below target
stable version **0.2.9**. Its release assets and verification report must be
published before installation or a live upgrade:

```sh
herdr-relay release install --version 0.2.9
```

Run the public CLI from the terminal, not an older plugin's package-pinned bridge.
Activation audits/stages the package and updates the CLI/managed skills, not
existing services or OpenCode plugin configuration. The 0.2.3 installer also
relinks the local Herdr panel, installs its shortcut and reloads running Herdr
sessions. Use `--no-herdr` to skip this or `--herdr-config TOML` for a custom
configuration. The published 0.2.2 installer still needs the manual
[Herdr panel setup](installation-and-onboarding.md#7-optional-herdr-panel).
From a handover-capable 0.2.4 CLI, setup runs in the verified candidate process and
reports `installer.version`. Already-published old clients cannot gain that code
retroactively. Use the [candidate-first bootstrap](installation-and-onboarding.md#upgrading-a-pre-handover-cli)
when starting from one of those clients and needing version-owned completion.
The published 0.2.3 caller's known setup remains compatible with a one-pass current-release
activation, but its output cannot provide the new executor receipt.
If the 0.2.2 CLI has already activated 0.2.3 without panel setup, invoking that
newly activated 0.2.3 installer again remains the legacy repair.
Refresh skill context through the harness; do not restart OpenCode to reload
skills or configuration.

## 2. Plan, then apply with the same key

On a host running both backend and node:

```sh
herdr-relay upgrade --services both --version 0.2.9 --key stable-029-backend-host
herdr-relay upgrade --services both --version 0.2.9 --key stable-029-backend-host --apply
```

On a node-only host:

```sh
herdr-relay upgrade --services node --version 0.2.9 --key stable-029-node-host
herdr-relay upgrade --services node --version 0.2.9 --key stable-029-node-host --apply
```

Backend-only maintenance uses `--services backend`. The role-specific `node upgrade`
and `backend upgrade` commands are also supported. Use exact versions, not `latest`.
Planning may download/install/audit a private cached release but does not switch
live services or configuration.

Maintenance uses `maintenancePolicy: compatible_code_switch`. Active native turns,
conflicts, pending publications and backend executions remain recorded work state.
They do not block schema-compatible maintenance or require cancellation. Candidate
and database schemas must match.

RC4 through 0.2.9 retain protocol `relay/0.2`, backend schema 2 and node schema 1.
Removing retired source code does not migrate or rewrite imported task provenance.

For 0.2.9 requester result-delivery fixes, upgrade both the backend and requester
node. This enables backend-clock presence validation and correlated delivery
outcomes without changing the sweep worker or replaying historical results. See
[delivery diagnostics](run-result-notifications.md#inspect-delivery-outcomes).

Upgrading enables the supported connection-rebind and workspace-relocation
operations. It does not apply either recovery automatically. Preview and confirm
those changes separately after the required Relay components are upgraded.

Interactive grant matching and [linked preparation repair](interactive-recovery.md)
require the 0.2.5 backend, destination node and Relay plugin. CLI activation does
not install those capabilities into running services. New preparations fence an
older driver before filesystem/native effects and wait for the node upgrade.
Legacy local records and failed preparations are inspected, not deleted or
silently replayed. Capacity reservations and repair history use the existing
revisioned records without a database migration.
The release declares interactive provisioning compatibility protocol **1**.
Switching back to code without that protocol is refused while capacity-aware
preparations, held reservations or repair approvals remain outstanding. Settle or
explicitly cancel and inspect those specific records first. Settled history and
unrelated active executions do not block an otherwise compatible code switch.

Upgrade the backend and participating nodes to **0.2.7 or later** before enabling
[bounded collaboration](collaboration.md). Collaboration compatibility protocol
**1** fences a switch to older code while a collaborative job remains active.
Settled collaboration history and unrelated work do not create that fence.

The inactive-agent controls introduced in **0.2.8** retain deleted identities and
local binding fences under agent deletion compatibility protocol **1**. Upgrade
the backend, TUI and owning node before using them. Once those records exist,
switching either service to older code without that protocol is refused. This
retains history rather than deleting it to permit a downgrade.

## 3. Deferred plugin reload

Pending UI decisions, or unavailable decision inspection, defer only the plugin
reload during a compatible upgrade. A service operation can be committed while
`pluginReloadDeferred` is set. Resolve the original form/permission normally, then:

```sh
herdr-relay upgrade resume OPERATION_ID --apply
```

This finishes the saved reload without restarting services. Do not rerun with a
new key, answer decisions automatically or restart OpenCode. A clean preview is
not a reservation: a later decision may defer reload during apply.

Owned workers retain their process and immutable launch request. Their plugin-only
change waits for idle and no pending decisions. A deferred update is not a fully
applied UI update. Later manual configuration/CLI changes fence stale operations.

## Maintenance safety

The updater acquires an OS-backed lock, validates managed units and identity/schema
pins, stages the verified release and requires a fresh zero-finding production
audit. Unavailable audit/registry access is not a successful audit.

It records intended changes and original bytes, sets maintenance guards, stops
selected nodes before selected backends and repeats identity checks.
SQLite backups use the online backup API and
are integrity-checked; a live WAL database is not copied as an ordinary file.

Compatible switching preserves live owned native processes. Before stopping an old
supervisor it applies the process-only systemd stop policy, rather than killing
workers with the supervisor cgroup. The same execution, process and invocation
identities continue without prompt replay. Dead runtimes with unresolved history
remain unavailable instead of being silently relaunched.

Only selected service entrypoints and plugin package paths change. Ports, runtime
executables, state paths, unrelated preferences, comments and credentials remain
preserved. Backends start before nodes, and only if previously running. Health is
verified before maintenance is cleared. No general OpenCode process is restarted.

There may be a brief Relay API interruption. This is not a zero-disruption or an
exactly-once external-effect guarantee. There is no unsafe force flag bypassing
identity, integrity, provenance or schema requirements.

## Status, resume and rollback

```sh
herdr-relay upgrade status
herdr-relay upgrade status OPERATION_ID
herdr-relay upgrade resume OPERATION_ID --apply
herdr-relay upgrade rollback OPERATION_ID
herdr-relay upgrade rollback OPERATION_ID --apply
```

Retain the operation ID printed by apply. Reusing the exact key/request returns the
saved operation; changing its payload conflicts. Resume reconciles the saved plan,
not a new release. If failure selected rollback, resume finishes that recorded
rollback rather than silently accepting the failed candidate.

Rollback switches compatible code/configuration, **not the database**. Post-upgrade
edits and results remain current. Old backups require separate explicit recovery.
Keep previous releases while services, plugins, CLI links or rollback operations
reference them. Schema-incompatible rollback is refused.

An `upgrade_recovery_required` result retains its backups and maintenance evidence.
It does not prove a native process stopped or a database was restored. Inspect the
saved operation rather than clearing journals. See [recovery](maintenance-recovery.md).
