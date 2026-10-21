# OpenCode v2 compatibility spike

This isolated package implements the first v2 runtime probe for
[specification v3](../../docs/spec-v3.md). It is not the production Relay bridge.
It does not change global OpenCode configuration or integrate into the v1 service.

Reproducible fixture CLI/plugin/client dependencies: **2.1.0**. Runtime admission
accepts **2.x**, with live evidence on 2.1.0 and 2.1.2. Node.js 24+ is required. The TUI smoke also
requires Python 3 with Unix PTY support. Each package has its own lockfile.

```bash
npm ci --prefix packages/opencode-relay
npm run test:v2
npm run smoke:v2
npm --prefix packages/opencode-relay run smoke -- --decision
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --offline
npm --prefix packages/opencode-relay run smoke -- --owned
```

The smoke launches a disposable authenticated loopback OpenCode server and a local
OpenAI-compatible deterministic model. It creates its own HOME/XDG directories,
sessions and two PTY-backed TUI clients. No provider credentials are copied. Owned
process groups and temporary state are removed on completion. A terminal driver
retries the diagnostic slash command while the disposable UI becomes ready.

## Files

| File | Responsibility |
| --- | --- |
| `server.mjs` | Read-only `relay_spike_status` tool and diagnostic RPC |
| `tui.mjs` | Pane-local diagnostic command and filtered notification subscription |
| `rpc.mjs` | Strict portable method/event schemas |
| `native.mjs` | Exact identity, paginated snapshots, single-send and v2 transcript observation |
| `owned-runtime.mjs` | Dedicated Linux v2 launch, identity checks, interruption and verified stop |
| `decision.mjs` | Client-local decision proposal/source binding and stale-context rejection |
| `human-inbox.mjs` | Optional keyboard-only owner question/review inbox, separate from model tools |
| `smoke.mjs` | Real service/tool/RPC/native/TUI verification with deterministic model |
| `pty-client.py` | Disposable terminal input/output driver |
| `test/` | Foreign input, stale pane, cleanup and malformed pagination regressions |

## Important boundaries

- RPC client/session identifiers are diagnostic routing labels, not authenticated
  pane identity or evidence of human approval. The spike exposes no task mutations.
- RPC events are live-only. They cannot replace Relay's durable inbox/outbox.
- The native adapter is not wired into existing v1 provisioning or supervision.
  Its caller must persist intent and enforce admission. No atomic idle-and-send or
  exactly-once guarantee is claimed.
- The fixture drives a real tool call, but it is not real-model compatibility
  evidence. Provider credentials and the active OpenCode installation are untouched.
- Two real clients exercise their own notifications. Negative wrong-client,
  wrong-location and pane-switch checks currently use fixtures, not a complete
  real-TUI authorisation test.
- Managed ownership/interruption, current-human-message proof, confirmation RPC,
  reload/reconnect authority and real provider validation remain release gates.

The `--decision` probe drives the supported TUI confirmation dialog in two real
clients using synthetic disposable input. It proves UI mechanics, not that a human
approved anything. Its receipts are labelled `unverified_client_local`, are not
sent as backend authorisation and are not persisted as production decisions.
Route-away-and-back invalidation still needs a reactive client identity binding.

The optional `ownerContextFile` TUI setting enables `/relay-questions` and
`/relay-reviews` from local keyboard/palette actions. Confirmed commands are stored
before publication and reconciled with their original key. It does not expose an
owner-capable model/RPC endpoint. Fixture integration passes, but natural-chat
source attribution and live cross-client authority checks remain pending.

The optional server `humanProposals: true` setting adds proposal-only `relay_answer`
and `relay_review` tools. `/relay-decisions` in the TUI displays proposals bound to
the current user message, checks the target revision and asks for the exact local
decision before publishing. Relay-owned prompt metadata and worker-enrolled
conversations are refused as human proposal sources. User role alone still is not
proof of a person, so the separate keyboard confirmation remains required. Full
natural-chat live certification is pending.

The optional server `workerContextFile` enables exact-session worker read/ask/submit
tools and scoped agent queries/answers. Native tool-driven question/result and
offline job publication are exercised by the extended backend smoke. This does not
certify real-model or physical cross-machine operation.

For the headless-only probe, run `npm --prefix packages/opencode-relay run smoke`.
`RELAY_V2_BINARY` can select an isolated 2.x binary. Major-version admission does
not bypass the identity, API and native settlement checks. The evidence is in
[the v2 spike report](../../docs/opencode-v2-spike.md).
