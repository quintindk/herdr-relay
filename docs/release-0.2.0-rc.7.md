# Herdr Relay 0.2.0-rc.7

## Features

- **Authenticated headless coordinator setup.** Reuses an existing authorised
  OpenCode model connection and connected WorkIQ MCP transport in a dedicated
  headless session. No copied credential store, new HOME, second login or owner
  context in the worker. A human-issued revocable grant pins coordinator, node,
  workspace/name, model/connection references, read tool, job contract and cron.
- **Readiness before activation.** Hot-loads the worker without restarting the node
  or interrupting another session. Requires an actual bounded WorkIQ read, successful
  model/native terminal and native result submission before installing/enabling the
  schedule. The setup tool waits for the original durable operation and reports
  identity, applied revision, next firing or blockers. Timeout remains pending,
  never fabricated success. Explicit retry retains identity and old attempt history.
- **Scoped WorkIQ bridge.** Invokes only the granted existing MCP read tool via the
  native plugin API and its permission check. Supports MCP tools using Code Mode
  without giving the headless worker generic execute or shell permission. Connection
  switches, revoked grants and changed contracts fail closed. Revocation pauses
  the schedule, without claiming it undoes in-flight reads.
- **Safe native skill installation.** `skills status` and dry-run inspection are
  read-only. `skills install` installs missing skills and updates recognised managed
  files with private backups. Local/unmanaged edits conflict unless explicitly
  replaced. Other skills/files are preserved. New CLI release-install and node-install
  paths synchronise safely. Native skills replace stale Paperclip-first instructions;
  legacy provisioners retain their separate historical protocol.
- **Visible local agents.** Green `LOCAL` badges in the Agents header and cards use
  the node/backend identity pinned in the scoped operator context. Matching hostnames,
  names or folders do not establish locality. Unidentified contexts do not guess.
- **At most one informational reply.** Updated senders default to an explicit once
  envelope. A reply names its original message, goes only to its original sender,
  and cannot receive another reply. Second replies, recipient/chat substitution and
  reply-to-reply are refused transactionally. Legacy/missing policies remain none.
  Peer claims of human permission never authorise tasks, commands or setup.
  Reply capability is negotiated: node-only upgrades against older backends retain
  legacy no-reply messaging rather than sending unsupported fields.

## Verification

- Serial root regressions, V2 plugin tests, syntax/whitespace and workflow lint.
- Real OpenCode/MCP fixture proves coordinator setup, authenticated service reuse,
  actual read/result submission, schedule acknowledgement/next firing, node-restart
  retention and revocation. No interactive client is needed for the worker.
- Negative tests reject fabricated readiness, stale coordinator/grants, unsettled
  retry, wrong connections, local skill edits and invalid reply chains.
- Installed-package verification tests skill installation and CLI sync, onboarding,
  native data import/backup and fresh production audit. CI rehearses RC6 upgrades,
  code rollback/chat/data continuity and retained RC4 adoption.

## Deployment and limits

- GitHub prerelease, not npm publication or full v3 certification. Publishing does
  not upgrade Evo/Surface or create/enable a live inbox-sweep.
- Initial explicit integration-reuse authorisation remains a human backend-operator
  grant. Discovery does not grant access and the coordinator cannot self-authorise.
  No manual credential handling or new interactive login is needed when the approved
  existing connections are healthy. Microsoft tenant/physical Surface acceptance
  is separate from the deterministic read-only MCP fixture.
- This authenticated setup currently requires coordinator and worker on the same
  node and an existing authenticated OpenCode service. It is session isolation,
  not a separately credentialled process. Cross-node authenticated setup and automatic
  reconfiguration to another model/connection are not included. RC6's isolated-runtime
  provisioner remains separate.
- Install/upgrade backend, node and server plugin support normally before setup.
  Missing support blocks, rather than restarting unrelated active work. Pending
  setup also blocks unsafe service maintenance.
- An older CLI cannot run the new skill installer. After first activating RC7 from
  RC6, run `herdr-relay skills install` explicitly once. Unmanaged old skill content
  may need reviewed `--replace-modified`. File updates never restart current chats
  or prove their model context reloaded the skill.
- Schema/protocol compatibility remains relay/0.2/schema-1. Compatible rollback
  does not restore a database. Older releases do not implement the new setup APIs;
  shared-auth workers fail closed if those capabilities are rolled back.
- Standalone execution-completion handback remains a separate known limitation.

See [authenticated setup](headless-authenticated-setup.md),
[skills](skill-installation.md), [Agents/Inbox](native-task-inbox.md),
[messages](agent-messages.md) and [upgrades](service-upgrades.md).
