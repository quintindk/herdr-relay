# Specification v3 implementation ledger

Updated: 2026-10-22. Target: [specification v3](spec-v3.md).

This ledger distinguishes implemented modules from deployed and verified workflows.
The specification is not complete. Local Paperclip compatibility remains separate;
the legacy SSH remote execution transport is retired in RC5.

| Area | Current evidence | Remaining work |
| --- | --- | --- |
| OpenCode v2 | Pinned 2.1.0, tools/RPC/TUIs, reload-fenced proposal confirmation and owned launch/stop/resume | Full parity, actual-human provenance, transport-loss/pane-switch matrix and Herdr integration |
| Native backend | SQLite atomic mutations/events/receipts, revisions, node credentials, loopback API | Broader scope/contract tests, lifecycle and review integration |
| Tasks | Native CRUD/comments/relations, references, bounded activity, exact-session reads and Ink adapter | UI live certification and full provider parity |
| Questions | Staging, escalation, continuation, agent inbox routes and real-TUI keyboard answer | Real-human evidence, orphan recovery and natural-chat source integration |
| Agent messages (RC4 candidate) | Task-independent send/inbox/sent tools, sender attribution, durable exact-chat delivery and restart/uncertainty tests; real native tool smoke on 2.1.0/2.1.2 | Live rollout, physical two-node acceptance and separate automatic execution-completion handback |
| Node | Journal/outbox, v2/Hermes adapters, daemon offline restart and observation-only Herdr discovery | Live Herdr/Hermes acceptance and broader recovery |
| Scheduling | Exact/folder jobs, scheduled clarification, offline/monitor runtime smokes; reminder UI and fenced transfer | Reminder/disconnection runtime matrix and full lifecycle |
| Providers | Pinned node Tasks read boundary, native/Paperclip/GitHub adapters, qualified GitHub relations and no-resend journal | External execution/delegation/review integration, full parity and live provider proof |
| Deployment | Installed RC2 administration/onboarding, production-install smoke and all four live Access checks | Physical Surface proof, data disposition and approved cutover |
| Maintenance (RC5) | Versioned backend/node/both upgrades, private backups, busy/decision guards, actual release/identity checks, resume and code-only rollback; installed real-process upgrade rehearsal | Evo live maintenance acceptance and physical Surface upgrade evidence; future schema migration design |

## RC2 installation and onboarding

Installed CLI commands now cover backend administration, separate daemon/operator
node bootstrap/join/revocation, plugin installation/upgrades/uninstall, read-only
doctor and Paperclip source discovery/export/plan/import. Backend-root credentials
remain on Evo. Surface's operator is scoped to its node for enrolment/attachment
and retains the same human's task/inbox authority, not backend administration.

The package verifier exercises separate Evo/Surface homes against actual scoped
HTTP endpoints, enrolment/attachment, pre-session plugin setup, read-only source
export, repeated import, backup and systemd unit dry-run. Release mode requires a
clean source commit and fresh zero-finding audit. Versioned artifacts/checksums
cannot be replaced with different bytes. Publication and tags remain explicit.

Scoped keyboard/TUI probes pass on OpenCode 2.1.0 and 2.1.2. These are single-host
fixtures, not physical Surface certification. The running Evo backend remains
unchanged. Its actual data, accepted execution and enabled definitions require
reconciliation before any reset. See [current acceptance](acceptance-v3.md),
[onboarding](installation-and-onboarding.md) and
[RC2 evidence](evidence/native-rc2-onboarding.json).

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
  logging secrets. Latest probe on 22 October 2026 passes: unauthenticated and
  actor-only receive 403, Access-only receives Relay 401 and both credentials
  receive 200 with `relay/0.2`. This supersedes the original Access-policy failure.
- Control requests to existing `fc.synthswarm.com` return 403 without Access headers
  and reach that origin with the shared headers, confirming the credential pair.
- No local Cloudflare origin certificate or management token was found. Updating
  management-plane changes are not required by the successful current probe.
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

Native interactive provisioning now implements owner grants, addressed local/remote
requests, conservative Herdr workspace/native-launch recovery, durable attachment,
discussion context and separate scoped dispatch. The same-node live Herdr/model
test passes with verified native model and placement. Read the
[new native contract](native-interactive-provisioning.md), rather than assuming
the legacy Paperclip bridge-worker implementation is the native execution path.

Durable receiving-chat follow-up: [the receiver contract](native-receivers.md)
now separates stable installation/agent identity from exact conversation bindings.
Human-only `/relay-enrol` and `/relay-attach`, a fresh-chat launcher, automatic
selected-root-chat attachment and scoped persistent schedule controls are
implemented. The node hot-loads replacements while retaining pinned historical
attempts. Real OpenCode 2.1.0 and 2.1.2 daemon/tool cron probes pass, and the 2.1.2
TUI verifies both keyboard commands and automatic new-chat scheduled delivery.
The model and keyboard/navigation input are fixtures, not actual-human acceptance.
See [sanitised receiver evidence](evidence/native-durable-receivers.json).

1. Complete native correctness and tool/UI parity. Exact/folder scheduling now has bounded runtime proof.
2. Extend v2 UI parity and actual-human evidence. Reload, transport reconnect and session-switch probes pass.
3. Verify broader offline schedules, reminders and combined Git/daemon recovery.
4. Certify live Hermes/Herdr integration and orphan/revoked-review recovery.
5. Complete real-model, actual-human and rollback/cutover evidence. External provider work is deferred by user direction.
6. Recheck ingress after changes and complete the manually installed second-node proof.

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

## Existing interactive session, 2026-10-21

The user explicitly requested enrolling this already-open conversation and testing
a cron here. Its native service was OpenCode 2.1.2 rather than the 2.1.0 spike
baseline. Read-only exact identity/history verification passed, followed by the
isolated 2.1.2 backend/worker-tool/daemon/two-TUI smoke. At that checkpoint, version
admission allowed only the explicitly exercised 2.1.0 and 2.1.2 releases. The
subsequent user-requested 2.x policy is recorded below.

External bindings may explicitly select `workerTransport: "cli"` when the existing
chat already has shell access. The default remains direct worker tools. The
override changes instructions only, retains scoped credentials and exact run
checks, and is refused for owned bindings. This avoids a plugin reload or permission
change solely to test an existing interactive chat.

A separate node enrolled the exact current session. Its minute cron fired at
09:38 SAST and completed native settlement/backend publication at 09:38:30 SAST.
The agent used the real scoped worker CLI to read and stage the acknowledgement,
then finished the turn. The test controller paused future scheduling immediately
after admission. Pause revision 2 was acknowledged. The chat stays enrolled, while
the test schedule stays paused. No existing native service, model, plugin or
permission was changed and no replacement session was created.

Evidence: [current-session cron](evidence/native-current-session-cron.json).
This closes the bounded existing-session execution test, not arbitrary active-chat
adoption, simultaneous typing safety, natural-chat schedule-management parity or
the wider v3 acceptance gates.

Follow-up verification passed: 1,466 root tests with one skipped and zero failed,
all 21 v2 tests, syntax/whitespace checks, and the isolated 2.1.2 owned
launch/interruption/provision/stop/resume smoke. The latter retained the original
session through verified stop and idle-process crash recovery.

## Native CLI and schedule visibility follow-up, 2026-10-21

The enrolment/cron smoke originally used temporary operator scripts for setup and
pause-after-first-admission. They called native commands and the maintained node
installer, not direct database writes. Native admission, intent, invocation,
worker staging, settlement and publication still ran through the node/backend.
That was execution evidence, not proof of a complete operator CLI. The live job
was taskless. It did not test task creation, comments or a manual Done transition.

The maintained `node src/cli.mjs native` entry point now covers exact interactive
enrolment, separate node installation/run, task creation/edit/comment/status,
execution requests/cancellation, schedule preview/create/list/inspect/control,
occurrence reads, scoped worker commands and the native board. Legacy commands
retain their old backend. Stable mutation keys, backend revision checks and
owner-versus-worker credentials remain mandatory. Advanced mutations without a
named verb still use the explicit native command API. Cron run-now remains absent.

The native board previously hard-coded `routines: []`. It now reads schedules,
including paused ones, and displays requested/applied state plus published
occurrence receipts and summaries. Next-run values are labelled clock previews,
not admission guarantees. Existing panes must be reopened to load the changed
adapter. Live read-only PTY verification against the deployed backend displayed
this chat's paused cron and completed receipt, then exited cleanly. The maintained
enrolment CLI also verified this existing binding without replacing it or changing
its service/policy. The test schedule remains paused.

Runtime version admission now accepts 2.x by user instruction. Other majors and
malformed versions remain refused. Exact identity, decoded API responses,
pagination, idle/inbox, durable intent and native terminal correlation still fail
closed. This is not certification of every future 2.x release. Dependency
lockfiles stay reproducible. See [native CLI](native-cli.md) for exact commands,
payloads, authority boundaries and remaining gaps.

Verification passed: 1,478 root tests, one skipped, zero failed. All 21 v2 tests,
syntax/Python syntax/whitespace checks and the real OpenCode 2.1.2
backend/tool/daemon/two-TUI smoke passed. The new CLI/board tests cover task and
comment writes, explicit execution requests, schedule revisions/activation, scoped
submission without fabricated settlement, rejected privilege escalation,
idempotent enrolment, lost credential replies and real PTY schedule detail/quit.
The three original temporary setup/watch scripts were retired after verification.
Evidence: [native CLI and board](evidence/native-cli-board.json).

## Existing Wright chat and human review, 2026-10-21

The maintained enrolment CLI reserved the exact existing Wright conversation,
then installed its separate native Relay node with explicit CLI worker transport.
A bounded read/submit execution completed before the human workflow. OpenCode,
its model, plugins and permissions were not restarted or changed.

The subsequent human-review execution asked one blocking question, settled its
native turn and waited. Quintin selected `cobalt` through the controlling chat's
interactive question tool. The controller recorded that answer with the maintained
`native command` API and owner credential. The worker resumed the original native
conversation with a new run, read the answer and submitted the expected candidate.
Task and execution remained in review until Quintin explicitly accepted that exact
candidate. Review completed the task without a manual Done transition. Identical
answer/review retries reused receipts. Read-only journal inspection showed two
correlated successful native turns: one initial question and one continuation.

This adds actual-human **operator-relayed** answer/review evidence. It does not
certify source-bound v2 plugin confirmations, natural-chat provenance, agent
escalation, closed-origin recovery, crash/replay or Git/resource retirement. Those
remain implementation/acceptance work, not inferred from this successful run.
Evidence: [Wright human workflow](evidence/native-wright-human-workflow.json).

## Direct human inbox delivery, 2026-10-21

Closed the live setup/notification gap with `native inbox install` and pane-local
human inbox notifications. Installation preserves unrelated settings, backs up
original files privately, refuses conflicting Relay scopes/JSONC shadowing and is
repeat-safe. The owner context stays in the TUI configuration. No worker obtains
it and no model tool is granted backend human authority. Live configuration
hot-reload loaded the existing server/TUI plugin without restarting OpenCode.

Polling shows pending-human question/review counts only in the configured selected
session. It is non-modal, read-only and deduplicated. In-flight reads are fenced
after session changes, reconnect or disposal. Errors report unavailability rather
than empty success. Actual keyboard decisions still use the original exact
selection/revision/confirmation checks and durable pending-operation reconciliation.
The bootstrap `owner.json` URL omission exposed during installation is now handled
consistently with the native CLI.

Verification: 1,482 root tests passed, one skipped, zero failed. All 30 v2 tests
and syntax checks passed. The OpenCode 2.1.2 daemon/worker-tool automated smoke
verified actual TUI notification, answer and review paths with synthetic input.
The live configured human TUI reported `human_inbox_ready`; the actual-human
Wright workflow is started but not yet certified. The controller must not publish
its answer or review. Evidence:
[human inbox installation](evidence/native-human-inbox-install.json).

Actual-human follow-up passed: Quintin supplied `rumplestiltskin` in the native
`/relay-questions` dialog and later accepted the exact candidate in `/relay-reviews`.
Backend source records and local TUI evidence agree on the human session, client,
distinct dialog IDs and immutable operation keys. The worker retained its native
conversation and made one continuation with the supplied answer. Execution/task
completed only after direct human review. The controller performed readback, not
answer/review publication. This is keyboard-dialog provenance rather than arbitrary
natural-chat source authentication. Escalation, closed-origin and failure recovery
remain separate gates. Evidence:
[actual-human inbox workflow](evidence/native-human-inbox-live.json).

## Native task-board Inbox, 2026-10-21

The native work pane now has Tasks, Agents, Inbox and Schedule views. Native projection
joins task/execution/question state without making the responsible human the
executing agent. It exposes human questions, ordinary/monitor/taskless candidate
reviews and reminder acknowledgements. Agent-addressed questions remain separate
until forwarded. Task Actions and Inbox open the same decision component. Result,
comment and question/review activity remain visible after resolution.

Keyboard decisions use explicit edit/preview/confirmation, exact backend revisions
and a private persistent decision journal beside the owner context. The command
and backend identity are saved before network publication. Retries reuse the same
confirmed bytes/key after process restart. Unknown outcomes and malformed receipts
remain pending. Definite refusals can be inspected/dismissed without deleting their
history. Current backend authority/revision checks remain authoritative. The UI
does not silently upgrade a stale preview or describe an answer as proof that a
worker has resumed. Inbox selection follows identity through refreshes and an open
decision retains its original preview.

Fixture API/journal/Ink tests and a real CLI PTY cover answering, exact acceptance,
request-changes semantics, human/agent routing, cancellation, taskless/monitor
reviews, reminder acknowledgement, offline state, restart and lost-acknowledgement
reconciliation. A read-only deployed-backend PTY verified the new Schedules view
and completed cron receipt without replacing the user's pane. This is not yet an
actual-human live decision test of the new board. Legacy Paperclip interfaces and
OpenCode slash commands remain available. See [board guide](native-task-inbox.md)
and [evidence](evidence/native-task-inbox.json).

Final regression checkpoint: 1,501 root tests passed, one skipped, zero failed.
All 30 v2 tests, syntax/whitespace and Python syntax checks passed. Subsequent
focused checks also covered lossless cell-aware decision wrapping, including CJK
and joined emoji, and exact receipt validation before reporting a decision recorded.

CLI/Agents/machine follow-up: `npm run board`, development `node src/cli.mjs tui`
and installed `herdr-relay tui` open the native board. Board-only context defaulting
does not change other native commands or the legacy Paperclip board. The tab order
is Tasks, Agents, Inbox, Schedule. Agents is a separate read-only directory with
mode, node, workspace, advisory availability, freshness and outstanding work.
Tasks no longer list empty agent groups.

Node and machine labels are separate throughout agent/task/inbox projections.
The optional hostname/platform heartbeat field is owning-node-only and gated by
the backend's advertised capability. Existing heartbeats remain valid. Hostnames
are labels rather than identity or authority. Running deployed services were not
restarted, so their existing machine labels remain unadvertised. The isolated
OpenCode 2.1.2 daemon/TUI smoke verified actual hostname/platform advertisement
alongside question/answer/review. Final follow-up regression passed 1,506 root
tests, one skipped, zero failed, plus all 30 v2 tests and syntax/whitespace checks.

## Live rollout and native board test preparation, 2026-10-21

After explicit user approval, the native backend and three local node daemons
were refreshed to the pushed implementation. The two managed nodes retained their
user-service installation. The manual local node was gracefully stopped through a
verified process handle and started with the same maintained CLI/configuration,
without installing another service. Preflight found no unsettled executions,
notices or outbox entries, and private online backups of the backend plus three
node journals passed integrity checks. Schedules remained paused/expired and
their definitions/revisions were unchanged.

The backend now advertises machine metadata support, and all three local nodes
report their actual local hostname/platform. Original native conversation bindings
remain intact. OpenCode, models, permissions and credentials were not restarted
or replaced. The actual-human native board test is now waiting on its first
question. Only the human board may publish its answer/review; the worker checks
terminal/dialog provenance. These orderly restarts are rollout evidence, not
crash-recovery or physical-machine certification. Evidence:
[rollout and board preparation](evidence/native-machine-rollout-board-live.json).

## Live board acceptance and streamlined decisions, 2026-10-21

The actual-human native board test completed. Quintin answered `make it so` and
accepted the resulting exact candidate with reason `okay`, both directly in the
board. Distinct terminal/dialog source records and durable operation keys agree
with the backend receipts. The local worker history has one settled initial turn
and one successful continuation in the same conversation. Execution and task are
completed/done. The controller read the receipts but published neither decision.

The accepted interaction was unnecessarily indirect. Questions now open straight
into their editor. Review choice/reason and submitted result share a single view,
with typing focusing the reason and Tab switching fields. The final exact
confirmation is still mandatory. Esc returns to editing without changing the
preview or abandons an unconfirmed draft without publication. Successful decisions
return to Inbox with an acknowledgement that persists until dismissed or replaced.
Question acknowledgements explain where a required review will appear. Lost-reply
payload locking, durable journalling, backend revision checks and original-key
retry remain unchanged. Terminal keyboard/PTY tests cover the streamlined flow;
the live human evidence covers the preceding interaction, not a second live run.
Evidence: [native board live](evidence/native-board-live.json).

Final verification: 1,511 root tests passed, one skipped, zero failed. All 30 v2
tests and syntax/whitespace checks passed. The focused 43-test keyboard/PTY group
includes direct editing, combined review fields, explicit confirmation, persistent
acknowledgement, original-key uncertain retry and cancelled-draft refusal.

An actual-human retest of the streamlined interface then passed against the
deployed backend and the existing Wright conversation. The direct board answer,
one continuation and exact candidate acceptance are independently recorded with
terminal/dialog provenance. Quintin confirmed the revised interaction. No
controller-relayed decision or manual Done transition was used. Evidence:
[streamlined board live](evidence/native-board-streamlined-live.json).
