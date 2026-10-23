# Herdr Relay 0.2.0-rc.10

Unpublished candidate retained as a historical record. Its local tag is frozen,
not retargeted or published. RC11 supersedes this candidate with the installed TUI
repair and separate shell permission. The commands below describe the abandoned
RC10 proposal, not an available release.

## General MCP permission

Headless grants now express a capability, not a named connector:

```json
"permissions": { "mcp": true, "shell": false }
```

- MCP allowed includes every currently available MCP tool in the worker's OpenCode
  location, including writes and tools configured later. There are no per-MCP,
  server, tool or read-only fields in the grant.
- MCP denied exposes no MCP catalogue or calls. Native task/artifact capabilities
  remain separately granted. Native shell/file/Code Mode execution stays denied.
- MCP providers may themselves expose commands, file writes, deletion or messaging.
  The broad MCP permission includes those effects. It is not an OS sandbox or a
  promise that a provider is read-only.
- `relay_mcp_tools` inspects the current native catalogue. `relay_mcp_call` invokes
  an exact native MCP tool through the existing authenticated transport. Prefix
  lookalikes, core namespace collisions and aliases to native permissions fail closed.
- Each call checks the accepted run, grant, session, workspace, model connection,
  expiry, cancellation and contract. Authorisation is rechecked after asynchronous
  permission evaluation. No cached authority or copied credential store is used.
- Readiness inspects the capability and performs native task/artifact canaries.
  It never executes external MCP tools. Provider business readiness remains the
  external contract's responsibility. MCP calls are blocked after result staging,
  while the model may still finish its native turn normally.
- A provider reply is retained if subsequent observation recording fails. The
  external write is not automatically repeated to obtain evidence.

The connector-specific grant fields, bridge, discovery checks and readiness
assumptions are removed. There were no live headless grants at the RC9 cutover;
there is no grant migration or backward-compatibility execution path.

## Shutdown and upgrade

Backend shutdown now closes stalled HTTP connections after a bounded grace period
instead of waiting for systemd's forced termination. Committed state and receipts
remain durable. OpenCode and human chats are not restarted.

RC9 → RC10 is a compatible service upgrade: backend schema remains **2** and node
journals remain **1**. Do not repeat the task-reference migration:

```sh
herdr-relay release install --version 0.2.0-rc.10
herdr-relay upgrade --services both --version 0.2.0-rc.10 --key local-rc10
herdr-relay upgrade --services both --version 0.2.0-rc.10 --key local-rc10 --apply
```

Node-only hosts use `herdr-relay node upgrade` instead. RC8/schema-1 predecessors
still require the explicit RC9-style `--migrate-task-references` transition. Their
old-writer rollback refusal remains enforced. Never rejoin, reset or overwrite a
credential store to upgrade.

All participating backend/node/server-plugin components must support general MCP
permissions before creating a new grant. Existing model authentication and MCP
logins remain in the original OpenCode service. Skill conflicts preserve local
instructions unless the human explicitly approves replacement with a backup.

## Verification

- Unit tests cover permission allow/deny, writes, later-added tools, native-tool
  spoofing, permission aliases, workspace moves, revocation races, result staging,
  evidence failures and bounded backend shutdown.
- Isolated real OpenCode rehearsals execute read/write fixture tools from two MCP
  servers, with the second added after setup. MCP-denied rehearsals execute zero
  external calls. Readiness has zero external tool effects in both cases.
- Release CI requires fresh zero-finding production audit, installed-package
  checks, RC9 upgrade/rollback continuity, and retained RC8/RC4 migration rehearsals.

These are isolated fixtures, not a live tenant workflow or physical Surface
certification. See [general headless setup](headless-authenticated-setup.md) and
[approved native capabilities](approved-headless-capabilities.md).
