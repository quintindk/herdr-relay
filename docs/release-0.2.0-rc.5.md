# Herdr Relay 0.2.0-rc.5

Prepared candidate: maintainable backend/node upgrades and legacy SSH retirement.

- One public executable: `herdr-relay`. The SSH wrapper/remote adapter and
  `adapter-stdio` transport are removed. Stale configurations fail closed rather
  than reading old credential files or falling back to local delivery.
- Public `backend`, `node`, `plugin`, `doctor` and migration command groups, plus
  version/status reporting. Existing `native` commands remain compatible.
- Verified side-by-side release staging and a fresh zero-finding production audit
  precede any stop. Upgrades default to plan-only and need explicit `--apply`.
- Backend-only, node-only and combined upgrades preserve the database, journal,
  identity, credentials, agent enrolments and schedules. No join/reset is required.
- Maintenance guards, post-stop race checks, integrity-checked backups, actual
  release/PID/identity checks, durable operation records, resume and compatible
  code/configuration rollback. Database snapshots are never silently restored.
- OpenCode chats remain running. Plugin package paths can reload and invalidate
  pending confirmations, which must be reopened, not replayed.
- Native-tool agent briefings no longer inject private nodejs/worker CLI commands.
- Isolated real-process RC4 upgrade/rollback/message-continuity verification is
  part of CI, in addition to unit/HTTP and installed-package checks.

Start with [service upgrades](service-upgrades.md). For RC4's first transition,
install this maintenance CLI from the verified artifact before invoking its upgrade
commands. A global CLI installation alone does not update pinned services/plugins.

Only relay/0.2 schema-1 compatibility and the explicit RC4 adoption baseline are
supported. This is not a generic schema migration facility. No Surface installation,
state reset, task import, nodejs/OpenCode upgrade or unrelated cloud change occurs
implicitly. Automatic standalone execution-completion handback remains a separate
known gap. Peer messages still carry information, not work authority.
