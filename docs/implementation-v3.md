# Specification v3 implementation ledger

Updated: 2026-10-20. Target: [specification v3](spec-v3.md).

This ledger distinguishes implemented modules from deployed and verified workflows.
The specification is not complete. Existing 0.1.x operation remains independent.

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| OpenCode v2 | Pinned 2.1.0, tools/RPC/TUIs, reload-fenced proposal confirmation and owned launch/stop/resume | Full parity, actual-human provenance, transport-loss/pane-switch matrix and Herdr integration |
| Native backend | SQLite atomic mutations/events/receipts, revisions, node credentials, loopback API | Broader scope/contract tests, lifecycle and review integration |
| Tasks | Native CRUD/comments/relations, references, bounded activity, exact-session reads and Ink adapter | UI live certification and full provider parity |
| Questions | Staging, escalation, continuation, agent inbox routes and real-TUI keyboard answer | Real-human evidence, orphan recovery and natural-chat source integration |
| Node | Journal/outbox, v2/Hermes adapters, daemon offline restart and observation-only Herdr discovery | Live Herdr/Hermes acceptance and broader recovery |
| Scheduling | Exact/folder jobs, scheduled clarification, offline/monitor runtime smokes; reminder UI and fenced transfer | Reminder/disconnection runtime matrix and full lifecycle |
| Providers | Pinned node Tasks read boundary, native/Paperclip/GitHub adapters, qualified GitHub relations and no-resend journal | External execution/delegation/review integration, full parity and live provider proof |
| Deployment | Local user service and public route reach authenticated backend | Cloudflare Access policy enforcement and remote-node proof |

## Deployment evidence

- Service: `herdr-relay-backend.service`, enabled and active.
- Origin: `http://127.0.0.1:3210`.
- Separate private state: `~/.local/state/herdr-relay-backend`.
- Authenticated info and empty task traversal verified. Installer ran twice.
- Existing active OpenCode and Cloudflare services were not restarted.
- Public target: `https://relay.synthswarm.com`.
- Existing connector: `cloudflared-wright.service`, active, remotely managed.
- Portcullis uses `CF-Access-Client-Id` / `CF-Access-Client-Secret` service tokens.
- User configured public routing to `http://localhost:3210`. The supplied spelling
  `replay.synthwarm.com` does not resolve. `relay.synthswarm.com` resolves and returns
  native protocol `relay/0.2` with the owner credential.
- `scripts/verify-backend-ingress.mjs` verifies four credential combinations without
  logging secrets. Relay refuses unauthenticated and Access-only calls with 401.
  Access-plus-actor succeeds, but actor-only also succeeds. The Access application
  is not yet proven to enforce the shared service-token gate for this hostname.
- Control requests to existing `fc.synthswarm.com` return 403 without Access headers
  and reach that origin with the shared headers, confirming the credential pair.
- No local Cloudflare origin certificate or management token was found. Updating
  the remotely managed Access policy remains an external configuration step.
- The second machine has no SSH access. The user will install it manually using
  [the second-node guide](second-node-installation.md). Continue local development
  independently and retain the physical acceptance gate until that node is available.

## Real-runtime native workflow

The combined `--backend --worker-tools --offline --daemon --mesh --escalate
--human-inbox` smoke also passes: two node processes, agent escalation, real TUI
answering, worker continuation/review and a scheduled job while the backend is
stopped, followed by single publication. Evidence:
[combined workflow](evidence/native-combined-workflow.json).

`npm --prefix packages/opencode-relay run smoke -- --backend` runs the real
OpenCode 2.1.0 service and native backend, using a deterministic local model and
controller-driven worker connector. It verifies task, execution, staged question,
answer, same-conversation continuation, result, review and task completion.
It is not evidence of a real model invoking worker tools, two physical machines
or an actual human approving the question/review.

The extended `--backend --worker-tools --offline` smoke now drives the actual v2
worker ask/submit tools, stops the shared backend for a local scheduled job, then
restarts and verifies one published occurrence. This remains a deterministic model,
not real-provider or physical two-node evidence. Result:
[native backend workflow evidence](evidence/native-backend-workflow.json).

Adding `--daemon` runs the real separate node process with explicit reserved v2
binding and worker tools, rather than calling node ticks from the controller.
The entire question/continuation/review path and backend-offline installed job
passed in this mode. Compaction is explicitly disabled for the small fixture model.

The native backend's scheduled occurrence publication stores the immutable
installation revision, including when an offline result arrives after an edit.
Tests verify local execution without backend calls and deferred single publication.

## Next gates

1. Complete native correctness and tool/UI parity. Exact/folder scheduling now has bounded runtime proof.
2. Extend v2 UI parity and actual-human evidence. Reload, transport reconnect and session-switch probes pass.
3. Verify broader offline schedules, reminders and combined Git/daemon recovery.
4. Certify live Hermes/Herdr integration and orphan/revoked-review recovery.
5. Complete real-model, actual-human and rollback/cutover evidence. External provider work is deferred by user direction.
6. Confirm Cloudflare Access enforcement and complete the manually installed second-node proof.

Further modules added after the first workflow smoke include scoped child delegation
and child-wait eligibility, an explicit Hermes node adapter, optional exact-session
v2 worker tools, a keyboard-only human inbox with persisted decisions, and external
provider publication journals. These need their own live integration evidence.
No owner-capable model tools are exposed by the human inbox.

`--backend --worker-tools --human-inbox` passed with the actual TUI inbox selecting,
answering and confirming the waiting question. Synthetic PTY input drives this
probe. It does not claim real-human approval or natural-chat source attribution.
Evidence: [human inbox](evidence/opencode-v2-human-inbox.json).

`--backend --worker-tools --review-tui` passed the actual candidate-review inbox,
including exact candidate selection, reason and confirmation before completion.
Input remains synthetic. Evidence:
[review inbox](evidence/opencode-v2-review-inbox.json).

`--backend --worker-tools --chat-answer` additionally passed: a separate native
user message drives the proposal-only answer tool, and the actual TUI binds it to
the current message and confirms the exact question/answer before owner publication.
The worker then resumes. Input/model are synthetic. No real-human approval or
independent hostile same-user isolation is claimed. Evidence:
[chat answer](evidence/opencode-v2-chat-answer.json).

The backend also supports an explicit human grant for independent parent-agent
review of opted-in children. Current parent run, candidate revision and active grant
are checked, stale runs are refused, and the root's final review remains human.
Fixture evidence exists. Live multi-agent review and revocation recovery remain.

`--backend --worker-tools --daemon --mesh` passed with two separate node daemons
and two native services on this host. A worker question travelled through backend
events to the initiating agent, which invoked the agent-answer tool. The answer
retained agent attribution and resumed the worker. There was no direct Relay peer
connection. This is process-separation evidence, not two physical machines.
See [two-node process evidence](evidence/native-two-node-processes.json).

Adding `--escalate --human-inbox` verifies the initiating agent forwards that same
question, then a real TUI human-inbox flow answers it and resumes the worker.
The input is synthetic keyboard automation, not a human decision. Evidence:
[escalation process smoke](evidence/native-escalation-processes.json).

`smoke -- --owned` additionally verifies a dedicated authenticated v2 runtime,
process-group identity, exact successful prompt, terminal interruption of a held
fixture request and idempotent verified shutdown. The managed launcher journals
before spawn and fences uncertain starts. Explicit owned bindings now use a separate
provisioning path. `smoke -- --provision` verifies repeat calls reuse the exact
session, then an explicit resume after verified stop preserves its identity and
records the next process generation. Unsettled host-loss recovery remains pending.
Evidence: [owned runtime](evidence/opencode-v2-owned-runtime.json).

The provisioning smoke also kills its idle owned process group with SIGKILL and
explicitly resumes it to generation 3 with the original session identity. This is
not recovery of unsettled native work or a physical reboot. Evidence:
[provision/resume](evidence/opencode-v2-provision-resume.json).

Node wiring now exposes conservative owned recovery only when historical native
work/notices are settled, with a three-attempt local health block. Explicit
`retireOnCompletion` and worktree finalisation/cleanup flags reuse the existing Git
identity/candidate/dirty-file guards through a native journal adapter. Real Git
tests pass for idempotent commit and dirty-cleanup refusal. Combined Git/daemon
failure recovery remains unverified. Incomplete retirement
on daemon restart is refused for inspection rather than relaunched.

`--backend --worker-tools --daemon --owned-node --retire` now passes the complete
node-owned runtime path through question, answer, continuation, native result,
exact acceptance and admission-fenced process retirement. Worktree cleanup is
separately covered by real Git tests, not this smoke. Evidence:
[native owned retirement](evidence/native-owned-retirement.json).

The native Ink adapter reuses the existing task pane for native task reads/details,
status changes and candidate review. Explicit execution assignment remains separate.
It has API integration coverage and clean-store JSON readback, not live TTY approval
certification. Existing 0.1.x Herdr plugin actions still use their original backend.

Verification checkpoints:

- Full root suite after initial modules: 1,386 passed, one skipped, zero failures.
- Latest full root suite after folder/recovery/isolation work: 1,442 passed, one skipped, zero failures.
- Subsequent targeted suites cover references/activity, daemon restart, notices,
  provider uncertainty, native board projection and rejected-review bypass guards.
- OpenCode v2 package now has 20 passing regression tests, including unprivileged
  source-bound human proposals. `--proposals` verifies registration and typed RPC
  on the real runtime. The natural-chat proposal/confirmation path passed with
  synthetic native/PTY input. Actual-human verification remains. The model never
  holds the owner credential. Runtime/TUI
  and offline backend smokes use deterministic models only.
- Syntax and whitespace checks pass. Public ingress checks retain the Access-policy
  issue above rather than treating a reachable URL as a complete deployment.

Shared snapshots provide an atomic event checkpoint and omit credential material.
Node snapshot recovery merges newer projections without erasing native intent or
history. Native events currently retain all history. Agent read tools may expose
a bounded local cache on transport failure, explicitly marked stale/incomplete
with fetch timestamps. Authentication failures never downgrade to cache access.

Conversation adoption is explicit and human-owned. Outstanding executions or
addressed questions prevent adoption. Requests retain the original advertised
conversation, and local invocations/notices pin the actual native conversation
once admitted. Reusing a binding label for a different session cannot reroute
historical delivery or continuation.

Schedule transfer now requires a source fence acknowledgement before explicit
human activation on the destination. Tests refuse activation while the source is
unreachable/unacknowledged. A newly connected target installs only the transferred
definition. There is no lease-based automatic takeover.

Scheduled clarification primitives now materialise a task only when a job asks,
retain the occurrence/binding, wait for an answer and publish its eventual result.
Fixture coverage passes. Reminder occurrences create durable human notifications
without selecting an agent and can be viewed/acknowledged in `/relay-reminders`.
Bounded standing-monitor primitives preserve pending slots and refuse admission
after expiry. Their admission/result loop now has the runtime evidence below.

`--backend --worker-tools --daemon --scheduled-ask` now verifies scheduled
clarification against the actual daemon/native tools: task materialisation,
waiting, answer, pinned continuation and completed occurrence/task all pass with
the deterministic model. Evidence:
[scheduled clarification](evidence/native-scheduled-clarification.json).

Backend execution requests now optionally carry a bounded monitoring window.
Admission/continuation refuse an expired window and the node records a cancellation
request at its end without claiming native termination. The repeat-loop evidence
and its disconnection limits are recorded below.

Standing-check result publication is now wired through worker staging into
`execution.monitor_result`, retaining one task/execution chain and creating a
delayed next check rather than completing the task. Human-review checks wait in
a separate monitor-review state. Fixture tests cover repeat identity and expiry.

Subsequent `--backend --worker-tools --daemon --monitor` smoke passes repeated
native checks against one standing task and cancels the execution at its window
end. This uses the real node process/native tools with a deterministic model.
Disconnected in-flight expiry is still fixture-only. Evidence:
[standing monitor](evidence/native-standing-monitor.json).

Offline monitor expiry now records its pending end request locally and requests
interruption only when the binding exposes verified owned interruption. It retains
native uncertainty and never treats the request as termination. Focused tests
verify one interruption attempt and durable publication intent while disconnected.

The current local deployment has no active native tasks, executions or schedules.
The development backend was restarted once after confirming the empty state to
load the newer routes. The instance identity and owner credential were preserved.
An online SQLite backup and integrity check passed without stopping the service.

No release or full spec completion is claimed until the corresponding acceptance
criteria have evidence. See [native backend](backend-native.md) and
[OpenCode v2 evidence](opencode-v2-spike.md) for commands and limitations.

Artifact references now enforce the owning node, exact run, result digest,
candidate and execution revision. Validation rejects local/non-HTTPS URLs,
embedded credentials, oversized URLs and malformed content digests. API tests
verify retry receipts, rollback, snapshot/readback and attachment after acceptance
without changing the review decision.

Node task reads now use an explicit provider boundary with a durable scope pin.
Changing provider/repository/company requires migration, and external read failures
cannot return unrelated native cache entries. V2 tools and worker CLI expose task
inspection, comments and supported relations. GitHub now implements its advertised
comment/child/dependency reads with repository-qualified external references and
bounded traversal. The daemon still rejects external providers because admission,
delegation, scheduled task creation and review-driven status writes remain native.

Native scheduling follow-up fixes cancellation of materialised scheduled work.
Waiting work can settle cancellation from its recorded terminal receipt, while a
running continuation requires its own terminal evidence and only an explicitly
owned binding may request interruption. New continuations clear prior observation
and interruption evidence, then re-read current execution identity/cancellation
before sending. Focused cancellation/race tests and the real v2 scheduled-question
daemon smoke pass. External-provider work is now deferred in favour of completing
the native path.

Exact-chat schedules now accept `targetConversationId`, validate it against the
agent advertisement and preserve it as immutable schedule scope. Transfers to
another conversation require a new authorised schedule. Local admission refuses
replacement conversations/bindings, pauses pending work and expires unadmitted
occurrences at the installed deadline. Continuations also respect unsettled native
turns/notices even when the harness reports idle. The actual v2 scheduled-question
daemon smoke passes with this exact target. Verification: 56 backend/node tests,
16 v2 tests and syntax/whitespace checks passed at that checkpoint. Folder scheduling
subsequently passed the follow-up recorded below.

Schedule installation/cancellation and queuing its applied acknowledgement now
share one local transaction. Outbox exhaustion rolls back the installation and
retains the pending change for retry, rather than leaving a half-applied cancelled
schedule that cannot be reinstalled. The capacity-failure regression and eight
related admission/pause/transfer tests pass after this change.

Folder schedules now use an immutable owner-node directory scope and select only
explicit local bindings. Backend enrolment/selected-agent checks reject unrelated
folders and observation-only agents. Zero or multiple candidates defer. An admitted
occurrence retains its agent, binding and conversation. Future firings can use a
replacement unique enrolment. The real folder scheduled-question smoke passes,
including a node restart while the ordinary execution waits and a real TUI answer.

Recovery tests reopen both SQLite databases after a lost native send reply. They
retain the original invocation and never resend whether terminal evidence appears
or remains absent. Proven terminal receipts remain usable if native history later
becomes unavailable. Fresh ordinary continuations now clear old observation and
interruption evidence, matching the scheduled-continuation guard.

V2 server registrations expose a per-load generation. The human inbox rechecks it
before persisting approval and invalidates pending confirmation on `server.connected`.
The real reload-during-confirmation smoke refuses the stale keyboard answer and
leaves its question open. Two real TUIs remain isolated before and after server
reload/client re-entry. Subsequent live probes drop the HTTP event connection and
switch the actual TUI session away and back during confirmation. Both refuse the
old approval and retain the open question. The session switch uses a separate
disposable smoke-only plugin, never normal runtime configuration.
Latest full verification: 1,442 root tests passed, one skipped, zero failures, and
20 v2 tests passed. See [acceptance commands and limits](acceptance-v3.md).

The user's laptop cutover now depends on Paperclip task migration. A separate
read-only export/plan and offline owner-authenticated import path preserves task
graphs, comment bodies/source attribution, original metadata and immutable ID
mappings. Identical imports do not overwrite native edits. Active execution,
pending/unknown interactions and execution/review policies block import. The
complete import commits atomically under the backend service lock. No agent,
execution or schedule is activated. Fixture tests pass. Live source inventory,
local legacy Relay state/reference/schedule migration and actual cutover remain
open. See [task migration](paperclip-task-migration.md).

Remote migration planning exposed three validation defects, now covered by
regressions: parent/dependency graphs were wrongly merged, empty attention objects
were treated as pending, and expired interactions were rejected. Import now creates
parent-ordered tasks then applies dependency edges in the same transaction. Plans
include blocker field values/source digests and can be saved privately with
`--output`. Active task/recovery obligations remain blocking. The laptop's private
166-task export is not present on this host, so these fixes have fixture coverage,
not readback of that actual inventory. Home-host transfer/import remains explicit.

## Interactive scheduling with a real model, 2026-10-21

`npm --prefix packages/opencode-relay run smoke:interactive-cron` passed against
an isolated native `relay/0.2` backend and real node daemon, using OpenCode 2.1.0
and LM Studio's `qwen/qwen3.8-27b`. Two actual TUIs stayed attached throughout.
Agents were registered as `interactive` with explicitly reserved external
`opencode-v2` bindings, not node-provisioned `opencode-v2-owned` runtimes.

- An exact-chat one-shot occurrence remained pending during a held synthetic human
  turn, then completed in the original conversation when it became idle.
- Folder cron occurrences at 09:27 and 09:28 SAST completed in chat A and chat B
  respectively. The second firing deferred with no local binding and then with two
  ambiguous bindings before a single explicitly enrolled replacement admitted it.
- The first admitted target remained unchanged. A subsequent daemon restart did
  not replay settled work, and the folder schedule's pause reached applied revision 2.
- All three occurrences contain completed `relay_work_read`/`relay_work_submit`
  calls, successful native terminal evidence, settled local work and completed
  backend publication. Both TUIs used synthetic input, not human approval.

Evidence: [interactive cron model smoke](evidence/native-interactive-cron-model.json).
This does not certify arbitrary active-chat adoption, atomic protection against
concurrent human input, interactive schedule-management controls, exact-chat
replacement refusal at runtime, physical reboot, remote nodes or backend outages.
Only disposable test processes/state were used. Existing services/routines were
not changed.

Verification at this checkpoint: the explicit serial root run passed 1,465 tests
with one skipped pinned-Paperclip-validator check and zero failures. All 20 v2
tests, the existing two-TUI deterministic smoke, syntax checks and whitespace
checks passed. The earlier root invocation hit two legacy discovery timing
assertions. Both passed in the serial rerun without changing their implementation
or tests.
