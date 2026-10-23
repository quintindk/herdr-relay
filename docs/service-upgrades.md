# Safe backend and node upgrades

RC5 introduces one public CLI, `herdr-relay`. A **node** is a Relay participant.
**nodejs** is its runtime. The SSH remote CLI/adapter transport is retired.
RC6 corrects identity checks for generated `worker-index.json`: JSON key ordering
is ignored, but changed mappings still block maintenance. Credentials and all other
configuration files remain byte-checked. Fingerprint versioning preserves the
original checks for retained RC5 operations rather than reinterpreting old receipts.
Automatic service maintenance targets Linux user-systemd, including WSL2. Other
process managers are not silently adopted.

Upgrades preserve the existing backend instance, node/agent IDs, credentials,
journals, enrolments, schedules and task data. Do not bootstrap/join again for a
compatible upgrade. No command here resets state, upgrades nodejs, stops OpenCode,
kills human chats or restores a database automatically.

## Check the installed versions

RC9 → RC10 is a compatible schema-2 upgrade and does not repeat task-reference
migration. Use `--version 0.2.0-rc.10` with the usual plan/apply sequence. The general
MCP grant format requires RC10 backend, node and Relay plugins before setup.

```bash
herdr-relay --version
herdr-relay node status
herdr-relay backend status
```

These report CLI and service versions separately. Evo has both roles. Surface
normally has only a node service; its backend status is not a remote administration
command. Use `herdr-relay doctor` to check the node's connection to its backend.

## First transition from RC4

RC4 has no upgrade command. Download RC5's package/checksums/report from its GitHub
prerelease and verify them before replacing the bootstrap CLI:

```bash
sha256sum -c SHA256SUMS
npm install --global --omit=dev --ignore-scripts ./herdr-relay-0.2.0-rc.5.tgz
herdr-relay --version
herdr-relay release install --version 0.2.0-rc.5
```

Use a user-owned npm installation inside the intended Linux/WSL account, without
sudo. npm supplies the bootstrap maintenance CLI. `release install` verifies/audits
the release, stores it side-by-side and activates the normal CLI from that version
store. Neither step changes existing services/plugins. Those keep their pinned RC4
release paths until the explicit upgrade below. A development
checkout/npm link is not a published release installation.

For fresh nodes/backends, activate the versioned release **before** running the
ordinary `node install` or `backend install`, so their initial service/plugin paths
are pinned too. Later upgrades use the built-in upgrader rather than repeatedly
replacing a globally installed package that a running service might reference.

## Plan, then apply

On a node-only host:

```bash
herdr-relay node upgrade --version 0.2.0-rc.5 --key surface-rc5
herdr-relay node upgrade --version 0.2.0-rc.5 --key surface-rc5 --apply
```

On Evo, upgrade both roles together:

```bash
herdr-relay upgrade --services both --version 0.2.0-rc.5 --key evo-rc5
herdr-relay upgrade --services both --version 0.2.0-rc.5 --key evo-rc5 --apply
```

Backend-only maintenance is `herdr-relay backend upgrade --version VERSION` and
the same command with `--apply`. It does not restart the node. Node-only maintenance
does not restart/administer the backend and does not require its root credential.

Without `--apply`, the release may be downloaded, installed and audited in the
private version cache, but no live service/configuration/CLI pointer is switched.
The output reports the exact roles, previous/target versions, restart decisions,
plugin reload and operation key. Use exact versions, never an implicit `latest`.

For an existing verified offline artifact, substitute:

```bash
herdr-relay node upgrade --artifact /private/herdr-relay-VERSION.tgz \
  --sha256 EXACT_TRUSTED_SHA256 --key node-upgrade-VERSION --apply
```

The checksum must come from a trusted channel. It is an integrity check, not a
signing-key assertion. A successful fresh production audit is still required.
Registry/audit failure leaves the old services running. The installer ignores
dependency lifecycle scripts and refuses different bytes in an existing version.

## Upgrade sequence and disruption boundaries

1. Acquire an OS-backed per-user upgrade lock. Refuse conflicting/incomplete operations.
2. Validate managed systemd units, existing identity pins and schema compatibility.
3. Refuse active/uncertain native turns, unresolved native notices/publications and
   active backend execution/preparation/message delivery. Pending queued work and
   settled human-review/question waits are retained rather than recreated.
   Before a plugin reload, inspect known bound/registered OpenCode services for
   pending server-side forms/permissions. Existing decisions block the switch;
   inspection failure is not treated as an empty inbox. No decision is answered/cancelled.
4. Stage the verified immutable release and require a zero-finding production audit.
5. Save the operation, original unit/configuration bytes and intended replacements.
6. Set maintenance guards. Stop selected node services before selected backends,
   then repeat identity/quiescence checks to catch races with old RC4 code.
7. Back up databases using SQLite's backup API and verify integrity. Back up private
   identity files. Never copy a live SQLite file as if it were an online backup.
8. Switch only service entrypoint/plugin package paths. Preserve ports, runtime
   executable, state paths, plugin options, comments, unrelated settings and credentials.
9. Start selected backends before nodes, only if they were previously running.
   New code remains in maintenance until its actual release/PID/identity is verified.
10. Activate the normal CLI command, clear maintenance and verify service health.

No general OpenCode service/TUI is restarted. Updating its Relay plugin configuration
can reload OpenCode locations. Pending forms/permissions are checked before the
switch, but a late race or client-only Relay confirmation can still be invalidated
and must be reopened. The updater does not approve, replay or weaken a decision. It does not
claim zero disruption or conceal a required configuration reload.

If an RC4 turn races the stop before any switch, the old supervisor is restarted
with that same journal, not discarded. If a candidate fails health checks, compatible
old code/configuration is restored without replacing the current database. If safe
recovery is blocked, the operation reports `upgrade_recovery_required`, retains its
backups/maintenance record and requires explicit reconciliation. There is no force
flag that bypasses uncertain work or identity pins.
If work has already begun after activation and then a health/recovery check fails,
rollback will not interrupt or erase that work to force a downgrade. Let it settle,
inspect the recorded recovery action and resume. A recovery-required record does
not mean a running model turn was stopped or that a database was restored.

## Status, resume and rollback

```bash
herdr-relay upgrade status
herdr-relay upgrade status OPERATION_ID
herdr-relay upgrade resume OPERATION_ID --apply
herdr-relay upgrade rollback OPERATION_ID
herdr-relay upgrade rollback OPERATION_ID --apply
```

Keep the operation ID printed by apply. Repeating its original immutable key returns
the existing operation instead of restarting services again. A different request
under that key conflicts. Resume reconciles the original planned files; it does not
select a new release or recreate state. Only one unfinished operation is permitted.
If failure already selected rollback but recovery was interrupted/blocked, status
shows `recoveryAction: rollback`; resume finishes that recorded rollback rather than
silently deciding to keep the failed candidate.

Rollback is a compatible **code/configuration rollback**, not database time travel.
Post-upgrade task edits/results remain in the current database. Old backups are for
separate explicit recovery, not silently restored after external effects occurred.
Later manual configuration/CLI changes fence rollback instead of being overwritten.
The previous release directory must remain available. Never remove a release while
services, plugin entries, CLI links or retained rollback operations reference it.

RC9 supports explicit relay/0.2 backend schema 1 or 2 and node schema 1 contracts.
RC4 remains the sole metadata-free adoption baseline. Ordinary upgrades still
require the candidate and database schema to match. Unknown schemas fail before a switch.

### RC9 task-reference transition

Use the verified RC9 CLI and explicitly add `--migrate-task-references` when
upgrading a schema-1 backend:

```sh
herdr-relay upgrade --services both --version 0.2.0-rc.9 --key local-rc9 --migrate-task-references
herdr-relay upgrade --services both --version 0.2.0-rc.9 --key local-rc9 --migrate-task-references --apply
```

The plan is read-only against live state. Apply stops the selected services under
maintenance, repeats safety checks, verifies private backups and acquires the
backend state lock before atomically backfilling task references and committing
schema 2. Service arguments, credentials, identities and task IDs remain unchanged.
The operation retains the migration receipt and its backup/hash. Resume reconciles
a committed migration even after a lost local result, without allocating again.

**After schema 2 commits, RC8/schema-1 backend rollback is refused.** If health or
activation fails, the exact candidate and maintenance record are retained for
`upgrade resume OPERATION_ID --apply`. Recovery is roll-forward, not an automatic
database restore. Before migration commits, normal compatible rollback remains
available. Node-only upgrades do not migrate the backend and retain compatible
code/configuration rollback.

## Public CLI versus service runtime paths

Ordinary use is `herdr-relay ...`, without pasted nodejs/private script paths. The
updater maintains the recognised CLI symlink to its verified version store. Existing
unrelated wrappers are refused, not overwritten. `npm ls -g` may describe the bootstrap
package, while `herdr-relay --version` reports the activated managed CLI.

Systemd deliberately retains an absolute nodejs executable and release entrypoint
because it does not use an interactive shell's NVM setup. Nodejs upgrades are a
separate operator action. Tool-enabled agent briefings use native Relay tool names;
explicit CLI transport uses the public `herdr-relay native work` command.

Private maintenance records/backups default to `~/.local/state/herdr-relay-upgrades`.
Private verified releases default to `~/.local/share/herdr-relay/releases`. Internal
`nodeId`, `node.json` and existing unit names are unchanged so an upgrade preserves
identity and compatibility rather than performing an unnecessary rename migration.

## Acceptance

Unit/HTTP tests cover busy refusal, compatibility, checksums/audits, maintenance gates,
idempotency, configuration conflicts, rollback and persisted partial-switch recovery.
`node scripts/verify-upgrade.mjs` additionally uses the installed candidate, actual
RC4/candidate backend/node processes and existing isolated OpenCode chats. It verifies
upgrade, delivery before/after, unchanged credentials/IDs, post-upgrade data retention,
node-only maintenance and automatic failed-health rollback. It never controls the
user's services. This is single-host evidence, not physical Surface certification.

Implementation references: [nodejs SQLite backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsourcedb-path-options),
[systemd service start/stop semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html),
and [OpenCode V2 reload API](https://opencode.ai/v2/docs/api)
([official OpenAPI](https://opencode.ai/v2/openapi.json)). OpenCode documents that
configuration reload cancels pending forms/permissions while running sessions continue
with refreshed services at the next step boundary. This is why the guard and explicit
reload warning exist rather than promising an invisible update.
