# Herdr Relay 0.2.0-rc.11

GitHub prerelease only. No npm publication. Publication does not issue a grant,
create a worker or enable a schedule. RC10 was not published and its local tag
has not been rewritten.

## Installed OpenCode TUI repair

- Ship precompiled Solid ESM, not raw JSX/TSX from `node_modules`. OpenTUI's Solid
  transform deliberately excludes installed dependencies. RC9's dynamic sidebar
  import failed on OpenCode 2.1.2 despite passing checkout/import tests.
- Keep renderer and Solid imports on the host runtime. Do not install a second
  native renderer into the Node.js CLI just to make an import test pass.
- Production entrypoint `tui.mjs` is generated from `relay-tui.tsx`. Builds are
  deterministic, syntax checks reject stale output and packing rebuilds it.
- Real installed-package terminal checks cover OpenCode 2.1.0 and 2.1.2 locally.
  Release CI requires both hosts, mounted sidebar, scoped attachment status,
  status command RPC/notification and no plugin-load errors.
- Optional sidebar setup failure retains enrolment and decision commands.

## Production naming and durable state

- Package: `@herdr/relay-opencode`.
- Plugin IDs: `herdr.relay.server` and `herdr.relay.tui`.
- Runtime RPC: `herdr.relay.runtime`. Runtime tool: `relay_status`.
- Commands: `/relay-status` and `/relay-diagnostic-confirm`.
- Upgrade recognises older bundled packages through the owning product identity.
  Exact positive/negative plugin-ID preferences follow the rename. Unrelated
  OpenCode settings and plugins remain unchanged.
- Upgrade preflight blocks pending, uncertain, malformed or unrecognised durable
  TUI outbox state across local channels before switching namespaces. Reconcile
  through the installed plugin first. Empty old files remain unchanged for rollback.
  No command is discarded, recreated under a new key or automatically replayed.
- An explicitly enabled server-side proposal store under an earlier plugin ID
  blocks the rename until its state is explicitly migrated or reconciled. The
  upgrade does not guess that a proposal store is empty.
- Historical verification measurements and published release artifacts are retained.

## General headless permissions

```json
"permissions": { "mcp": true, "shell": true }
```

- MCP is one boolean covering currently available and later-configured tools,
  including writes. Grants do not name MCP servers, integrations, tools or verbs.
- Shell is independently granted and defaults to false. `relay_shell_call` uses
  the native shell input schema and exact worker session. Shell allowed means full
  OS-user access, including file writes outside approved artifact paths. It is not
  an OS sandbox. Native task/artifact grants remain separate.
- `relay_headless_permissions` inspects policy without effects. Readiness performs
  this inspection plus applicable native task/artifact canaries and native result
  submission. It never executes MCP effects or shell commands.
- Calls require the current accepted run, worker/session/workspace, grant, model
  connection and unchanged contract. Authority is checked again after asynchronous
  permission evaluation. Readiness and already-staged outcomes cannot execute effects.
- Revocation blocks new dispatch and pauses the schedule. It cannot undo completed
  effects or stop processes already started. Credentials are not copied or borrowed.
- Business rules and forwarding through available MCP tools belong to the external
  contract. No connector-specific compatibility bridge is installed.
- Backend shutdown now has a bounded HTTP connection grace period.

## Upgrade

RC9 to RC11 preserves backend schema **2** and node journal schema **1**. No task
reference migration is required:

```sh
herdr-relay release install --version 0.2.0-rc.11
herdr-relay upgrade --services both --version 0.2.0-rc.11 --key local-rc11
herdr-relay upgrade --services both --version 0.2.0-rc.11 --key local-rc11 --apply
```

Node-only hosts use `herdr-relay node upgrade`. RC8/schema-1 predecessors require
explicit `--migrate-task-references`, with incompatible old-writer rollback refused.
Never reset or rejoin a node, replace credentials or re-import tasks for this upgrade.
OpenCode need not restart. Resolve skill conflicts only with human approval and
the managed backup mechanism.

All participating backend/node/server-plugin components must support the revised
permissions before a grant is issued. Grant creation alone does not start a job.

## Verification boundaries

Release gates cover regressions, real installed terminal rendering, MCP allow/deny,
later-added tools, harmless shell allow/deny effects, effect-free readiness, scoped
capability canaries, fresh production audit and RC9/RC8/RC4 upgrade rehearsals.
These fixtures do not certify a real tenant business workflow or physical Surface.
