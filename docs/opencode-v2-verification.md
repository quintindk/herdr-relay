# OpenCode v2 initial verification

Date: 20 October 2026

Historical status at the date below: initial real-runtime verification passed.
The full bridge migration was pending at that point. See current release notes
for the implemented integration; the historical measurements below are retained.
Target: [specification v3, OpenCode v2](spec-v3.md#13-opencode-v2-target-and-migration).

## Baseline

| Component | Verified version |
| --- | --- |
| Node.js | 24.18.0 |
| Isolated OpenCode CLI | 2.1.0 |
| `@opencode/plugin` | 2.1.0 |
| `@opencode/client` | 2.1.0 |
| Active OpenCode binary, unchanged | 1.18.35 |

The earlier [assessment](opencode-v2-migration-assessment.md) used 2.0.27 and a
different installed environment. Its version inventory is historical. The new
package pins 2.1.0 in its own lockfile without replacing v1 dependencies.

## Implemented

- Separate loadable server and TUI entrypoints in `packages/opencode-relay`.
- Strict diagnostic RPC input/output/event schemas and malformed-input rejection.
- Read-only status tool, invoked by a deterministic model through the real runtime.
- Two real TUI clients attached to different sessions on the same service, using
  pane-local commands and session/client/location-filtered notifications.
- Versioned native identity validation, paginated snapshots, exact-ID prompt send
  and contiguous-turn terminal observation.
- Twelve regression tests for decision/source binding, stale identity, looping pagination,
  wrong-client/session/location routing, in-flight pane changes and cleanup.

## Reproduction and evidence

```bash
npm ci --prefix packages/opencode-relay
npm run test:v2
npm run smoke:v2
npm --prefix packages/opencode-relay run smoke -- --decision
```

The real-runtime smoke uses isolated HOME/XDG directories, a private authenticated
loopback server, disposable sessions and a local deterministic model. No real
provider credentials or active configuration are used. Sanitised result:
[OpenCode v2 initial evidence](evidence/opencode-v2-initial.json).

Verification after the initial implementation:

- `npm run check`: passed, including the new package's JavaScript files.
- `npm run test:v2`: twelve tests passed after adding the decision prototype.
- `npm run smoke:v2`: real service, tool call and two TUI clients passed.
- `smoke -- --decision`: two real clients displayed the supported native confirmation
  dialog and recorded diagnostic decisions from synthetic PTY input. No human
  authority is claimed. Details: [decision probe evidence](evidence/opencode-v2-initial-decision.json).
- `node --test --test-concurrency=1 test/*.test.mjs`: 1,369 passed, one skipped
  because the pinned Paperclip validator source is not installed, zero failures.
- `git diff --check`: passed.

## Findings affecting the implementation

1. `serve` generates private authentication. The smoke uses the generated password
   for Basic authentication and `OPENCODE_PASSWORD` for disposable TUI clients.
   Passwords are redacted from retained diagnostics and absent from evidence.
2. Plugin RPC events are live-only. Reconnection must reconcile durable Relay state.
3. Tools default to code-mode exposure in this baseline. The diagnostic tool uses
   `options: { codemode: false }` so the fixture can exercise a direct call. Decide
   the production tool exposure contract during the full port.
4. V2 message cursors cannot be combined with `order`. Apply ordering/page size on
   the first read and follow subsequent opaque cursors without recreating scope.
5. Terminal proof is an `idle` transcript message with an outcome, not v1
   `assistant.parentID` or merely global session idle. The adapter refuses foreign
   input between its owned prompt and terminal evidence.
6. Disabling all built-in plugins also removes the default build agent. The smoke
   keeps the isolated runtime's built-ins rather than treating `plugins: ['-*']`
   as a replacement for v1 `--pure`.

Sources: [plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1/),
[RPC](https://opencode.ai/v2/docs/build/plugins/rpc/),
[CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli/),
[configuration schema](https://opencode.ai/config.json), and the installed 2.1.0
SDK declarations validated against the disposable real service.

## Remaining gates

The client-local decision prototype binds exact action/target/revision and current
source content before/after the dialog, fences explicit context invalidation and
refuses concurrent dialogs. Its receipts are `unverified_client_local`. The probe
does not yet bind production invocation provenance, persist decision intent or
authorise a backend mutation. Route-away-and-back invalidation also needs reactive
client integration rather than just checking the selected session on return.

- Implement exact human-source confirmation through supported server/TUI contracts.
  Client-supplied routing labels in this initial verification confer no authority.
- Exercise negative cross-client/pane-switch/reload/reconnect cases in real TUIs.
- Prove owned runtime isolation, scoped interruption and restart reconciliation.
- Validate real models and the actual Herdr integration.
- Port existing Relay tools, supervision and provisioning onto the versioned adapter.
- Build the native Tasks/Collaboration contracts and backend with the agreed clean
  state and Cloudflare/Portcullis-style ingress.

This evidence is not approval for primary OpenCode cutover, complete 0.2.0 support
or production backend exposure.
