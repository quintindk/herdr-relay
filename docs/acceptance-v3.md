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

## Real-model interactive scheduling, 2026-10-21

```bash
npm --prefix packages/opencode-relay run smoke:interactive-cron
```

The [interactive cron evidence](evidence/native-interactive-cron-model.json)
adds real-model evidence with two attached OpenCode 2.1.0 TUIs, a native backend
and a node daemon using reserved external interactive bindings. Exact-chat
busy deferral/completion, two folder cron firings across chat replacement,
absent/ambiguous binding deferral, immutable admitted identity, applied pause and
settled-work restart deduplication passed. Every occurrence completed native
read/submit tools and backend publication.

The exact-chat occurrence uses one-shot timing. The folder test uses actual
minute cron ticks, not an advanced test clock. Model/tool execution is real,
while keyboard/API input remains synthetic. This does not close the actual-human,
arbitrary live-chat adoption, physical-machine or full recovery gates.

Regression checkpoint: `node --test --test-concurrency=1 test/*.test.mjs` passed
1,465 tests, one skipped and zero failed. All 20 v2 tests, the existing two-TUI
smoke and syntax/whitespace checks passed. An earlier root invocation failed two
legacy discovery timing assertions. The explicit serial rerun passed both without
code or test changes in that path.

### Existing-session follow-up

The user-authorised test in the actual already-open OpenCode 2.1.2 conversation
also passed against the deployed native backend. One real minute cron occurrence
read/submitted through the session-scoped worker CLI, settled natively and published
as completed. Its pause reached applied revision 2. No replacement conversation,
native restart, plugin reload, model switch or permission change was needed.
See [existing-session evidence](evidence/native-current-session-cron.json).

The adapter at that checkpoint explicitly admitted 2.1.0 and 2.1.2, with an isolated 2.1.2
backend/tool/daemon/two-TUI smoke preceding enrolment. External
`workerTransport: "cli"` is an explicit operator choice, not a fallback around
denied shell access.
The full arbitrary-adoption, concurrent-input and natural-chat mutation gates
remain open.

Follow-up checkpoint: 1,466 root tests passed, one skipped, zero failed. All 21 v2
tests and syntax/whitespace checks passed. The isolated OpenCode 2.1.2 owned-runtime
and provisioning smoke also passed launch, interruption, verified stop and
same-session resume after an idle process crash.

### Operator CLI and schedule visibility

The initial live smoke's temporary operator setup/pause scripts were not complete
CLI parity. The maintained `native` entry point now exposes enrolment, node
installation/run, task/comment/status, execution request/cancel, schedule control,
occurrence reads, worker staging and the board. Advanced actions still have the
explicit command API. Cron run-now and full natural-chat/UI mutation parity remain
open. Enrolment is tested for repeat calls, lost credential replies and scope
changes. Worker submission remains staged until native settlement.

Native schedule rows no longer disappear behind a hard-coded empty array. Paused
jobs and completed taskless receipts are visible, with requested/applied state
kept separate. The deployed backend's real task-pane PTY read/quit passed. No
agent was restarted and the current-chat cron stayed paused. Runtime admission is
now 2.x rather than a patch allow-list, with native/API guards preserved. This
does not replace release-by-release compatibility evidence.

Checkpoint: 1,478 root tests passed, one skipped, zero failed. All 21 v2 tests,
syntax/whitespace/Python syntax checks and the OpenCode 2.1.2
backend/tool/daemon/two-TUI smoke passed. Read-only deployed-backend enrolment and
schedule readback preserved the existing binding and paused revision 2. Evidence:
[native CLI and schedule board](evidence/native-cli-board.json).

## Existing Wright chat: actual-human operator decisions, 2026-10-21

The newly enrolled existing Wright interactive conversation completed a real
blocking-question/answer/continuation/candidate-review workflow. The worker asked
for a human-selected label and reached local `settled_waiting` before Quintin
selected `cobalt` through the controlling conversation's interactive question
tool. The controller published that explicit answer through `native command`.
The worker continued in the same native conversation with a distinct run, submitted
the label and settled. Both task and execution remained `in_review` until Quintin
explicitly accepted the displayed exact candidate through a second interactive
question. Owner-authenticated `execution.review` then completed the execution and
task. Identical answer/review retries returned their original receipts. Read-only
local journal inspection showed the archived initial turn and one continuation.

These were genuine human selections, not synthetic keyboard input, but they were
**operator-relayed decisions**, not the source-bound v2 plugin/natural-chat path.
The backend answer has no native-chat source proof. This closes only that bounded
live workflow, not the full human-escalation/provenance gate. Initiating-agent
routing, closed-origin answering, plugin confirmation, failure injection and
resource retirement remain open. No process retirement was authorised. Evidence:
[Wright human workflow](evidence/native-wright-human-workflow.json).

## Direct human inbox installation and test preparation, 2026-10-21

The earlier Wright human workflow used the controller to relay both decisions.
It did not verify that the product delivered a human question to the user.

The maintained `native inbox install` command now configures the real OpenCode
server/TUI plugin, with private configuration backups and repeat-call/conflict
checks. Session-scoped, read-only polling notifies the human about pending
questions/reviews. It never opens a modal, invokes a model or records a decision.
The existing `/relay-questions` and `/relay-reviews` flows publish directly from
the human's local TUI after keyboard confirmation, retaining dialog provenance
and their durable mutation outbox. Bootstrap owner contexts now receive the same
local URL default as the CLI.

The live existing TUIs loaded the plugin without a service restart and the
configured human session reported inbox readiness. The OpenCode 2.1.2 automated
daemon/worker-tool smoke verified question/review notifications and both keyboard
decision flows. Input remains synthetic in that smoke. Root regression passed
1,482 tests with one skipped and zero failed. All 30 v2 tests and syntax checks
passed. The live Wright direct-human test has been started, but an actual human
answer and review are not yet claimed. Evidence:
[human inbox installation](evidence/native-human-inbox-install.json).

### Actual-human direct inbox follow-up

Quintin answered Wright's question directly through `/relay-questions`, choosing
`rumplestiltskin`. The backend records human authorship, the actual human session,
a keyboard-dialog ID and answer digest. The controller did not publish the answer.
Wright continued once in its original conversation, verified the human/dialog
source and submitted the exact answer. Both task and execution remained in review
until Quintin accepted the candidate directly through `/relay-reviews` with reason
`Please go ahead`. Review has its own session/dialog/digest provenance and matching
result digest. Execution is `completed` at revision 7 and task `done` at revision 4.
The controller did not publish the review or manually change task status.

Local journal readback contains one settled initial question turn and one successful
continuation. TUI evidence records question/review notifications and both direct
keyboard decisions from the same client. This passes the bounded actual-human
direct inbox answer/review path. It does not close natural-chat message provenance,
initiating-agent escalation, closed-origin recovery, crash/replay or physical-node
gates. Evidence: [actual-human inbox workflow](evidence/native-human-inbox-live.json).

## Task-board human workflow follow-up

Native Tasks/Agents/Inbox/Schedule views now expose task-linked human questions, exact
reviews and reminders without requiring OpenCode slash commands. Task detail and
Inbox share a decision flow, while responsibility and executing agent remain
separate. A durable local journal preserves confirmed decisions and original-key
reconciliation across uncertain replies/restart. Stale revisions and cancelled
review scope are refused, not silently refreshed into a new approval.

API, persistent-journal and keyboard tests cover ordinary/taskless/monitor review,
question forwarding, actual request-changes semantics, offline status, stale
selection and malformed/lost receipts. A disposable real PTY answers a fixture
question and accepts its exact candidate through the maintained CLI. This is
synthetic-input evidence, not actual-human board acceptance. The deployed backend
was inspected read-only in a separate PTY and retained its paused cron/receipt.
No live work or existing pane was replaced. Evidence:
[native task-board Inbox](evidence/native-task-inbox.json).

Verification checkpoint: 1,501 root tests passed, one skipped, zero failed. All
30 v2 tests, syntax/whitespace and Python syntax checks passed. The separate
native-board actual-human decision test was subsequently verified below.

The CLI/Agents/node-machine follow-up passes 1,506 root tests, one skipped, zero
failed, plus all 30 v2 tests and syntax/whitespace checks. The isolated OpenCode
2.1.2 daemon/TUI smoke also verifies the node's optional hostname/platform
advertisement. The CLI opens Tasks, Agents, Inbox, Schedule without a context
argument for the local native board only. Older deployed services were not
restarted and continue showing machine metadata as not advertised. This does not
claim rollout or actual-human board acceptance.

## Actual-human native board acceptance and interaction follow-up

After the authorised machine-label rollout, Quintin answered the live Wright
question entirely in the native board, choosing `make it so`. The recorded source
is a `terminal:` session and `dialog:human-board:` identifier. Wright verified
that provenance, resumed its original conversation once and submitted the exact
answer. Quintin accepted that candidate in the board with reason `okay`. The
review references the same result digest and a distinct board dialog. Backend
readback shows execution `completed` at revision 7 and task `done` at revision 4.
Both human operations are `recorded` in the durable board journal. Neither was
published by the controller or an OpenCode slash-command dialog.

This passes the bounded actual-human board answer/review path and completes the
two requested immediate follow-ups: live machine metadata rollout and live board
decisions. It does not certify crash recovery, closed-origin answering or
initiating-agent escalation. Evidence: [native board live](evidence/native-board-live.json).

Human feedback identified unnecessary interaction steps. The streamlined UI now
opens questions directly into the answer editor, keeps review choice/reason and
result in one view, retains a final exact confirmation and returns to Inbox with
a persistent acknowledgement. Existing revision/authority guards, durable
publication and original-key retry are unchanged. The new interaction has
automated keyboard/PTY coverage, not a second actual-human acceptance run.

Streamlined-flow checkpoint: 1,511 root tests passed, one skipped, zero failed.
All 30 v2 tests and syntax/whitespace checks passed.
