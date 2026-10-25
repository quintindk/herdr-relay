# Herdr Relay integration for OpenCode

This package provides Relay's OpenCode server and terminal integrations. Its
production package name is `@herdr/relay-opencode`.

| File | Responsibility |
|---|---|
| `server.mjs` | Native task, messaging, execution and granted capability tools |
| `relay-tui.tsx` | Source terminal entrypoint, compiled before packaging |
| `tui.mjs` | Generated production ESM entrypoint |
| `tui-setup.mjs` | Testable terminal setup, commands and lifecycle cleanup |
| `attachment-sidebar.tsx` | Reactive selected-chat attachment status renderer |
| `rpc.mjs` | Read-only runtime/status RPC and filtered notifications |
| `cli-bridge.mjs` | Human interactive access to the installed native CLI |
| `headless-grant-tools.mjs` | Own-node coordinator grant creation/revocation without an owner context |
| `native.mjs` | Exact identity, paginated snapshots, single-send and observation |
| `owned-runtime.mjs` | Isolated test/owned-runtime launch and verified stop |
| `human-inbox.mjs` | Keyboard-confirmed human decisions, separate from model tools |
| `enrolment-commands.mjs` | Human enrolment/attachment and chat continuity |
| `test/` | Permission, identity, lifecycle and decision regressions |

The plugin IDs are `herdr.relay.server` and `herdr.relay.tui`. The read-only runtime
RPC is `herdr.relay.runtime`. `/relay-status` inspects the selected chat's runtime;
`/relay-diagnostic-confirm` is a disposable diagnostic, not task approval.

`relay_cli_help` exposes the installed native CLI reference. `relay_cli` calls that
same executable for tasks, execution requests, schedules, node administration,
skills and maintenance. Human interactive task hand-offs need no active parent
execution. See [full CLI bridge coverage](../../docs/node-cli-bridge.md). The bridge
does not change CLI authority or expose backend-root credentials to a node.

## Rendering and packaging

The production entrypoint statically imports precompiled Solid ESM. OpenTUI skips
its Solid JSX transform under `node_modules`, so shipping raw TSX works from a
checkout but fails after installation. `npm run build:tui` builds the entrypoint
and sidebar. `npm run check` rejects stale generated files, and `npm pack` rebuilds.

OpenTUI peers are declared for the host-provided renderer. Server-only Node.js
consumers do not require a second OpenTUI/native renderer installation. A plain
Node.js import of `tui-setup.mjs` is a logic/import check, not evidence that the actual
terminal renderer can load or react. Installed production-package TUI checks are
required before release, separately from checkout tests.

Before changing plugin IDs, upgrade preflight rejects pending, uncertain or
unrecognised durable TUI outbox state across all local OpenCode channels. Settle
that state through the installed plugin first. Empty earlier outboxes are retained
unchanged for rollback rather than deleted or automatically replayed.

## Verification

```sh
npm ci --prefix packages/opencode-relay
npm run test:v2
npm run smoke:v2
npm --prefix packages/opencode-relay run smoke -- --decision
```

Fixtures create their own HOME/XDG directories, deterministic model and authenticated
loopback service. They never copy a human credential store or modify the active
service. Real OpenCode 2.1.0 and 2.1.2 are tested separately where available. PTY
tests require Python 3 and Unix terminal support.

## Authority boundaries

- RPC routing labels, user-role messages and provider output do not grant human
  authority. Human decisions bind exact source, target, revision and proposal.
- Confirmed uncertain commands reconcile their original durable key; they are not
  recreated after a disconnect or plugin reload.
- Worker tools require their exact session/binding/run. A directory or display-name
  match is not execution authority.
- Native model permissions and revocable headless grants are independent of MCP
  provider authentication. No backend owner context is passed to a worker.
- Readiness/fixture success is not proof of a real tenant business workflow or
  physical Surface qualification.

The [initial verification record](../../docs/opencode-v2-verification.md) is retained
as historical evidence, not a claim that the old baseline certified current releases.
