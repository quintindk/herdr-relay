# Herdr Relay 0.2.0-rc.12

Development candidate. Publication and installation are separate operations.
RC11's published tag and artifacts remain unchanged.

## Restore interactive task access through CLI parity

- `relay_cli` exposes the installed native CLI through one argument-array bridge.
  It calls the same executable and command handlers as a normal terminal. It does
  not implement a second set of task, scheduling or node administration semantics.
- `relay_cli_help` reads the installed native, maintenance and headless command
  reference. The executable router and bridge share native entrypoint definitions.
  Future operations beneath those entrypoints are not silently omitted.
- Human interactive chats can create tasks and request execution by an existing
  peer without an active parent execution. Existing worker child-delegation tools
  remain separate. No headless grant is required for this interactive route.
- Node-local operator and exact-session worker contexts are resolved internally.
  Model callers receive neither tokens nor permission to select arbitrary owner
  credentials. Existing CLI/backend scopes, revisions and idempotency keys apply.
- Headless jobs retain their explicitly granted tools. A peer notification or
  scheduled invocation is not silently treated as a new human operator request.
- The status tool no longer returns the misleading `mode: read_only` field.
  Its response states that status inspection does not determine chat capabilities.
- CLI failures/timeouts preserve uncertainty and retain payloads for original-key
  reconciliation. No automatic effect retry is added. Terminal-only commands keep
  their CLI terminal requirements, with documented JSON modes used for machine calls.

## Verification

Regressions cover command-family parity, future operations, context substitution,
human-source changes and isolation from headless/notification authority. The real
OpenCode model/tool rehearsal creates a task and requests peer execution through
the actual plugin and CLI, without a parent execution. Request creation is not a
claim that the target worker executed or that automatic result handback occurred.

See [node CLI bridge](node-cli-bridge.md) for the complete surface and call examples.
