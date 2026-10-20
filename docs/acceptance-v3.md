# Specification v3 acceptance ledger

Date: 2026-10-20. **Incomplete. Not a 0.2.0 release declaration.**

| Spec gate | Evidence | Status |
| --- | --- | --- |
| 1. Standalone | Real v2/native backend task-question-result-review smoke | Passed with deterministic model |
| 2. Two physical machines | Two node daemons/native services on this host | Physical test pending manual install |
| 3. Agent answer | Backend notice delivers to initiating native agent and invokes answer tool | Process smoke passed |
| 4. Human escalation | Same question forwarded by initiating tool and answered in real TUI | Synthetic keyboard smoke passed, actual-human gate open |
| 5. Origin unavailable | Human user inbox is independent of original worker chat | Implementation/tests exist, closed-origin scenario pending |
| 6. Conflicting answers | Concurrent HTTP answers commit one answer/continuation, revision/idempotency guards | Concurrent API test passed |
| 7. Replay/restart | Persistent backend/node lost-send recovery and real daemon restart during question wait | Bounded tests passed, crash-during-write matrix remains |
| 8. Offline job | Real daemon/native tools with backend stopped and one result on restart | Deterministic runtime smoke passed |
| 9. Offline pause | Requested/applied revision, local installation and source-fenced transfer | Fixture coverage, live pause pending |
| 10. Changed scope | Cancellation, stale revision/run, foreign input, identity and review-grant checks | Partial, full matrix pending |
| 11. Lifecycle | Dedicated launch/interruption/resume, daemon acceptance retirement and real Git guards | Passed bounded smokes, combined Git/daemon failure matrix pending |
| 12. Clean deployment | Separate empty state, local service, preserved instance and online backup | Local passed, public Access gate unresolved |
| 13. Providers | Common reads, pinned node read boundary, GitHub comments/qualified relationships and uncertainty tests | Partial, external execution/write lifecycle and real writes pending |
| 14. V2 plugin parity | Core worker/agent tools, proposal-only human tools and typed RPC | Partial tool parity |
| 15. Shared service | Two real clients before/after reload; stale confirmations refused after reload, transport reconnect and session switch round trip | Bounded real-TUI smokes passed, actual-human evidence remains |
| 16. V2 native | Exact messages/sessions, uncertainty tests, owned interrupt/stop/resume | Partial, crash/replay matrix pending |
| 17. Cutover | Isolated binary/config throughout | Primary installation deliberately not cut over |

## Current priority: native operation

Native Relay implements both Tasks and Collaboration. Its provider surface covers
task creation/editing, comments, parent/dependency relationships, references and
activity. Core execution, questions, review and offline automation have bounded
runtime evidence. This is not yet complete v3 certification.

External providers are deferred by user direction. Remaining work is prioritised
around native correctness, interface/scheduling parity, recovery and deployment.
The original external-provider acceptance gate remains unfulfilled rather than
being counted as passed.

Additional verified runtime scenarios include scheduled clarification task
materialisation/continuation, bounded repeat checks retaining one task and window
expiry, real-TUI candidate review, proposal-based chat answer confirmation and
idle owned-process crash/resume. These remain deterministic-model/synthetic-input
evidence rather than the outstanding real-model, actual-human or physical gates.

## Commands used

```bash
npm run check
npm run test:v2
node --test --test-concurrency=1 test/*.test.mjs
npm run smoke:v2
npm --prefix packages/opencode-relay run smoke -- --owned --provision
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --offline --daemon
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --daemon --mesh
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --daemon --mesh --escalate --human-inbox
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --chat-answer
```

Latest full root checkpoint: 1,442 passed, one skipped because pinned Paperclip
validator source is absent, zero failures. This includes folder scheduling,
persistent lost-send recovery and admission/cancellation guards.
The v2 package has 20 passing tests. See [implementation ledger](implementation-v3.md)
and retained [`evidence/`](evidence/) for bounded claims.

## External dependencies

- Public hostname reaching the backend is `relay.synthswarm.com`. Access-plus-actor
  authentication works, but actor-only also reaches it. Correct the Cloudflare
  Access application/policy and rerun `scripts/verify-backend-ingress.mjs`.
- The user will install the second machine manually. See
  [second-node installation](second-node-installation.md). No SSH is required.
- Real-model, actual-human and physical-machine checks are distinct from fixtures.
  Do not close those gates based on process emulation or synthetic keyboard input.
- The user now requires a Paperclip task migration path before laptop v2 setup.
  [Task migration](paperclip-task-migration.md) supplies read-only export/plan and
  owner-authenticated atomic import. Live import and full installation cutover
  remain unverified. Pending obligations/schedules are not silently migrated.

## Outstanding implementation, not external blockers

- Finish every applicable v2 public tool and natural-chat mutation parity, plus
  UI and notification parity. Exact/folder schedule targets now have runtime proof.
- Certify the bounded standing-monitor loop/expiry and reminder UI against real
  runtime/disconnection scenarios. Scheduled clarification daemon smoke now passes.
- Certify Hermes/Herdr discovery and native lifecycle integrations live.
- Complete safe orphan/adoption/review-revocation recovery and daemon retirement.
- Complete credential/configuration cutover/rollback rehearsal before primary v2.

Scheduled cancellation now has focused race coverage: cancellation while waiting,
cancellation after the continuation receipt but before delivery, and cancellation
during the new turn. The new turn clears prior terminal/interruption evidence and
requires its own terminal observation. A dedicated owned interrupt is attempted
once, without treating its response as settlement. The scheduled-clarification
daemon/runtime smoke passes after these changes with the deterministic model.

Native schedule admission now supports an explicit `targetConversationId` checked
against the advertised agent. Retargeting and cross-node transfer of exact-chat
schedules are refused. Pending work respects pause and `expiresAt`, while admitted
work retains its settlement obligations. Replacement bindings and competing
unsettled turns/notices block delivery. The scheduled-clarification real-runtime
smoke exercises exact-chat targeting. Folder targeting additionally passes a
real daemon/native-tool scheduled-question workflow with explicit directory scope.
Latest focused verification: 56 backend/node tests and 16 v2 tests passed, alongside
syntax/whitespace checks. These checks supplement the full-suite checkpoint above.

## Folder, recovery and isolation follow-up

```bash
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --daemon --scheduled-ask --folder --restart-node --human-inbox
npm --prefix packages/opencode-relay run smoke -- --tui --reconnect
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --daemon --human-inbox --reload-confirmation
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --daemon --human-inbox --transport-confirmation
npm --prefix packages/opencode-relay run smoke -- --backend --worker-tools --daemon --human-inbox --switch-confirmation
```

- Folder selection refuses ambiguous candidates and pins admitted work. Fixtures
  prove only future occurrences can select a replacement enrolled binding.
- Backend and node database reopen preserve uncertain native delivery. A missing
  native receipt never permits resend. Proved terminal evidence survives temporary
  loss of native history, and a new continuation clears old terminal evidence.
- A real node process restarts while waiting, preserves the original invocation
  and resumes once after the answer.
- Two actual TUIs use distinct client IDs and session-filtered notifications.
  After server-plugin reload, newly connected clients receive fresh IDs and retain
  session isolation. A separate HTTP proxy drops live connections during an open
  confirmation and verifies reconnection invalidates that decision.
- A real TUI confirmation held open across server-plugin reload is refused. Its
  durable backend question stays open. A separate test-controller answer completes
  that smoke afterwards and is not counted as human approval.
- A disposable smoke-only TUI plugin changes the actual selected session away and
  back while confirmation is open. The old confirmation is refused and its question
  stays open. Fixture negatives additionally cover disposal and direct session switch.

These smokes use deterministic models and synthetic PTY input. No real-model,
actual-human, physical second-machine or complete recovery certification is implied.

Deferred external work remains provider selection across collaboration/execution
reads and writes, identity mapping and review projection.

These are work remaining in the accepted scope. They have not been silently
reclassified as optional merely because the first native workflow now runs.
