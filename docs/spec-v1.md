# Herdr Retinue specification, version 1

- Version: 1
- Date: 2026-10-03
- Status: Design baseline, not an implemented feature contract
- Superseded architecture: [Herdr Relay specification v2](spec-v2.md)
- Initial harnesses: OpenCode and Hermes

Subsequent requirements and product evaluation are captured in
[Evaluation baseline v1](evaluation-baseline-v1.md) and
[Evaluation results v1](evaluation-results-v1.md). The baseline adds human task
ownership, service-scoped monitoring and multiple open obligations per agent.
It supersedes this version's restrictive one-active-assignment scheduling default.
This document remains the original design baseline pending a revised architecture.

## 1. Purpose

Retinue provides durable task coordination and agent lifecycle management across
coding harnesses. Agents can discover one another, delegate directly, work from a
shared backlog, exchange messages and return results for acceptance.

Task coordination runs independently of herdr and of any agent conversation.
Herdr integration provides machine discovery, terminal placement, lifecycle
operations and user interface entry points. Harness adapters handle native
conversation and execution behaviour.

A later communications gateway will route external channels to agents. Its
protocol, channel model and user experience are deferred.

This document records the agreed direction and makes the proposed implementation
contracts explicit. Items in section 18 remain decisions or investigations rather
than settled capabilities.

## 2. Agreed decisions

1. A backlog and direct agent-to-agent delegation use the same task model.
2. Agents have a discoverable directory and durable identities independent of
   their harness conversations and terminal placement.
3. Agent lifetime is either persistent or task-scoped. Task-scoped workers retain
   durable records even though their execution lifetime is temporary.
4. A coordinating agent manages a task-scoped worker through Retinue. Retinue
   persists and executes lifecycle operations independently of that coordinator's
   current conversation.
5. A worker submits a result for review. Coordinator acceptance of that exact
   result triggers retirement of a task-scoped worker.
6. Persistent agents remain available for further assignments after acceptance.
7. OpenCode and Hermes are the first supported harnesses.
8. A shared CLI and skill are the initial agent interface. Native harness plugins
   can follow later.
9. The integration uses herdr's existing plugin system for actions and views.
10. External communications gateway design is deferred.

## 3. Architecture and ownership

```text
Agents / CLI / task UI
          |
          v
     Retinue service
     +-- Task coordination
     |    +-- Backlog, assignments and dependencies
     |    +-- Messages, questions and results
     |    +-- Delivery records and notifications
     +-- Agent lifecycle
     |    +-- Agent registry and runtime bindings
     |    +-- Provisioning, resume and retirement operations
     +-- Durable state and event stream
          |
          +-- Herdr integration --> machines, workspaces, panes
          +-- Harness adapters ---> conversations, launch and notification
```

The initial implementation is one service with separate module interfaces. It
does not require independently deployed coordination and lifecycle services.

| Component | Authority |
| --- | --- |
| Task coordination | Work definitions, assignments, attempts, dependencies, messages, questions, results and review decisions |
| Agent lifecycle | Retinue identities, management relationships, operation intent, runtime bindings and tracked resources |
| Herdr | Terminal processes, panes, workspaces, machine connections and observed terminal state |
| Harness | Native conversations, model execution and harness configuration |
| Harness adapter | Translation between Retinue contracts and verified harness capabilities |
| Git | Repositories, worktrees, branches and commits |
| Future gateway | External channel connections and routing, to be specified separately |

Inter-agent task messages belong to Retinue. Herdr's control socket and event
stream provide placement and runtime observations, not the authoritative task
mailbox. Herdr may carry a notification prompting an agent to read that mailbox.

The service survives closing a task view or disconnecting a herdr client. The
task API remains usable without herdr. Agents outside herdr may register and read
their inbox, although automatic wake-up depends on their runtime integration.

## 4. Domain model

All entity IDs are opaque. Display names, paths, native session titles and pane
labels are not identities. Mutable records carry revisions and timestamps.

### 4.1 Work entities

| Entity | Responsibility |
| --- | --- |
| `Task` | Work definition, scope, completion criteria, backlog/project grouping and dependencies |
| `Assignment` | One agent's responsibility for a task, including its coordinator and execution policy |
| `Attempt` | One execution or continuation of an assignment |
| `Result` | Immutable outcome, deliverables and evidence published for an attempt |
| `ReviewDecision` | Acceptance or requested changes against an exact result |
| `Message` | Durable communication between participants, optionally linked to work |
| `Question` | A correlated request for an answer, optionally blocking an attempt |
| `Delivery` | Notification intent and evidence for a particular recipient binding |

A task can exist without an assignment. A task can have multiple historical
assignments, but at most one active assignment in version 1. Parallel work uses
child tasks. Each child explicitly declares whether it blocks its parent.

Reassignment preserves earlier attempts and results. Cancelling or releasing an
assignment does not prove the previous agent stopped executing. A successor
assignment must account for that unresolved execution before dispatch.

### 4.2 Agent and lifecycle entities

| Entity | Responsibility |
| --- | --- |
| `Agent` | Stable Retinue identity, label, declared capabilities, lifetime and assignment policy |
| `RuntimeIncarnation` | A specific running instance of an agent |
| `ConversationBinding` | Harness instance, native conversation reference and binding history |
| `Placement` | Machine, herdr server/session, workspace, pane and terminal references |
| `Management` | Coordinator relationship and permitted lifecycle/resource operations |
| `Resource` | Tracked process, pane, workspace, folder, worktree or branch |
| `Operation` | Recoverable launch, resume, stop, retirement or explicit cleanup workflow |

```text
Task --> Assignment --> Attempt --> Result --> ReviewDecision
             |
             +--> Agent --> RuntimeIncarnation
                              +--> ConversationBinding history
                              +--> Placement

Agent / Task / Assignment / Attempt --> Messages and Questions
Messages --> Deliveries pinned to runtime bindings
Management --> Operations --> Resources
```

Task state, assignment state, delivery state, runtime activity and operation
progress are separate. No single status field represents all five.

## 5. Discovery and delegation

The agent directory exposes:

- Stable ID and display name.
- Role and declared capabilities.
- Harness, machine and placement when known.
- Persistent or task-scoped lifetime.
- Availability, observation time and current assignments.
- Whether the agent accepts direct assignments.

Capabilities are declarations unless explicitly verified. Availability is an
observation. Idle does not mean unassigned, and offline does not mean retired.

The following workflows share the same records:

| Workflow | Behaviour |
| --- | --- |
| Backlog creation | Create a task without an assignee |
| Direct assignment | Assign an existing task to an existing agent |
| Direct delegation | Create a task and assign it to an existing agent |
| Worker delegation | Create a task, provision a task-scoped worker and assign it |
| Subdelegation | Create a child task and assign it, with an explicit dependency if needed |

Coordinator is a relationship, not a special agent class. OpenCode can delegate
to Hermes and Hermes can delegate to OpenCode. A worker may coordinate child
tasks while remaining assigned to its parent work.

Discovery, registration and management are distinct:

- Discovery observes a running agent.
- Registration establishes its Retinue communication identity.
- Management establishes lifecycle control over specified resources.

Assigning work to an existing agent does not acquire management rights over it.

## 6. Identity and lifetime

### 6.1 Persistent agents

- Keep their identity across runtime restarts and conversation changes.
- Remain registered while offline.
- Receive successive assignments.
- May be user-managed or coordinator-managed.

### 6.2 Task-scoped agents

- Exist for one assignment, including pauses, questions and review corrections.
- Have a recorded coordinating agent and lifecycle policy.
- Retire after acceptance of their result.
- Leave active discovery after retirement, but remain accessible through history.
- Retain results, binding history and operation records for recovery and review.

Lifetime is an assignment execution choice, not a task type. A review task can
run on a persistent reviewer or a newly provisioned task-scoped worker.

Retired workers are not silently resurrected for unrelated work. A replacement
worker receives a new identity linked to the prior assignment or attempt.

Lifetime, management and retention are independent. Temporary execution never
implies volatile bookkeeping.

### 6.3 Runtime and conversation binding

Messages address stable agents, while dispatch records pin the exact runtime
incarnation and conversation binding used for submission.

Native conversation IDs are scoped to their harness instance. Herdr references
are scoped to their machine and server/session. A reused pane is not the same
runtime.

An adapter may establish verified conversation continuation within a runtime.
This is necessary for Hermes, whose installed implementation can create a child
session during compression and update the active native session ID.

- Record previous and new bindings with continuation evidence.
- Reconcile pending deliveries before transferring them to the new binding.
- Preserve the original target and evidence for attempted deliveries.
- Pause dispatch when continuation cannot be verified.
- Never infer continuation from a label, directory, pane or “latest” lookup alone.

Retinue credentials identify the registered caller. A model-supplied agent or
conversation ID is not sufficient caller authentication. The concrete CLI
credential and binding-verification mechanism remains an implementation decision.

## 7. Task scheduling and attempts

Version 1 uses one active assignment per agent, with further assignments queued.
The initial queue is FIFO with a transactionally allocated sequence. Priority
scheduling and pre-emption are not part of this baseline.

- Questions and active-work messages do not join the new-assignment queue.
- Waiting on an answer or child task retains the active assignment.
- Awaiting acceptance retains the assignment, so the worker remains available
  for corrections rather than beginning unrelated work.
- A paused attempt does not implicitly release its assignment. Explicit release
  or reassignment is required to free that scheduling slot.
- A continuation or rework creates a new attempt and preserves prior history.
- Releasing a scheduling slot does not bypass runtime readiness. Dispatch of the
  next assignment waits for an eligible execution state.

Suggested task projection:

```text
Backlog --> Assigned --> In progress --> In review --> Completed
                            ^               |
                            +--- Rework ----+
```

Paused, blocked, failed and cancellation information must remain inspectable
without conflating them with delivery or runtime state. The exact storage enums
can differ from this user-facing projection.

Dependencies must reject cycles. Blocking child tasks must be resolved before a
parent can be accepted. Non-blocking children have independent outcomes and
lifecycle management. Their existence does not authorise cascade shutdown.

## 8. Results, acceptance and retirement

```text
Assigned --> Running --> Awaiting acceptance --> Accepted
                ^               |                  |
                +---- Rework ---+                  +--> Retirement operation
                                                        for task-scoped worker
```

### 8.1 Submission

The worker publishes an immutable result for its exact assignment and attempt.
The result includes:

- Outcome and summary.
- Deliverables or references to artefacts.
- Checks and evidence, including who reported or executed them.
- Known risks and follow-up work.

Duplicate identical submissions return the original result. Conflicting retries
do not overwrite it. A reported check is not an independently verified check.

Submission places finished work into review. A harness becoming idle or exiting
never substitutes for submission.

### 8.2 Review

The recorded coordinator can:

- Accept the exact current result.
- Request changes with feedback, opening a new attempt on the same assignment.

Review decisions are durable records. Acceptance checks the current result and
assignment revision. A stale acceptance cannot retire a worker already executing
corrections. Accepting work with unresolved blocking dependencies is refused.

Acceptance of a successful result completes the assignment and satisfies the
task's completion contract. Recording a failed outcome does not satisfy that
contract. Failure closure and reassignment details remain open in section 18.
Persistent agents become eligible for their next queued assignment after
acceptance, subject to runtime readiness.

### 8.3 Retirement

For task-scoped workers, acceptance atomically schedules a retirement operation.
The operation stops the exact managed runtime and removes the agent from active
discovery after shutdown is confirmed.

Acceptance does not itself authorise merging, pushing, deleting a working
directory, removing a worktree or deleting a branch. Those resource actions have
separate policies and operations.

Retirement waits for current execution to finish rather than interrupting a turn
merely because the result was accepted. Exact graceful-stop behaviour is
adapter-dependent and requires validation.

If shutdown fails, work remains accepted and retirement is visibly pending or
failed. Runtime cleanup failure cannot rewrite a successful work outcome.

## 9. Messaging, questions and delivery

Retinue provides two scheduling paths:

1. New assignments, serialised through the agent's work queue.
2. Active-work communication, including answers, clarifications, progress,
   review feedback and cancellation requests.

An answer must never wait behind the assignment that is blocked on it. Whether
it can be injected during model execution depends on adapter capabilities. The
agent can always read stored messages through the CLI when it next executes.

Messages can be addressed directly between agents and optionally correlated to
a task, assignment, attempt or question. Delivery alone creates no expectation
of a task result. Work requiring a result must be represented as an assignment.

Questions have stable IDs. Answers refer to the exact question and applicable
attempt. A delayed answer to an old attempt cannot satisfy a different question.

### 9.1 Delivery evidence

```text
Stored --> Notification attempted --> Recipient acknowledged
                       |
                       +--> Uncertain --> Reconciled
```

- Store message content and notification intent durably before external effects.
- A wake-up notification points the recipient to durable inbox content.
- CLI reading/acknowledgement records receipt, not comprehension or completion.
- Herdr prompt success or observed idle/done is not recipient acknowledgement.
- A lost submission response may leave delivery uncertain.
- A later authenticated receipt can resolve uncertainty.
- Do not blindly resubmit an uncertain prompt without reconciliation.
- Stable delivery IDs allow repeated reads and acknowledgements without creating
  new assignments or results.

The service guarantees durable, idempotent state transitions, not exactly-once
model execution. External submission and human input are not assumed atomic.

### 9.2 Cancellation

Cancellation before dispatch can prevent queued execution. After a notification
attempt or acceptance, cancellation is a request and records that execution may
continue until stopping or relinquishment is confirmed.

Cancellation, interrupting a turn, stopping a runtime and discarding files are
different operations. Preserve late results and identify them as late. They do
not silently reopen cancelled work.

## 10. Lifecycle and resource management

### 10.1 Launch

```text
Requested
  --> Prepare directory/worktree
  --> Create placement
  --> Start harness
  --> Bind conversation
  --> Confirm communication readiness
  --> Ready
```

Record intent before each external side effect and confirmed resource references
after it. Each operation has an idempotency key and recoverable step progress.

- A pane appearing is not proof that an agent is ready.
- A timeout does not prove launch failed.
- Uncertain startup requires inventory reconciliation before another launch.
- Creating an agent is separate from assigning work, even when a convenience
  command coordinates both operations.
- Existing folders and shared workspaces are not implicitly disposable.
- Rollback is limited to operation-created resources confirmed safe to remove.

### 10.2 Resume and restoration

Resume retains the stable agent identity, verifies the intended native
conversation and establishes a new runtime incarnation where applicable.
Missing resources or ambiguous conversation bindings are surfaced for repair.

Herdr is the proposed owner of automatic terminal-session restoration. Retinue
reconciles agent and task bindings afterwards. Retinue and herdr must not each
independently decide to relaunch the same runtime.

Explicit resume operations coordinate with herdr's observed restoration state.
The handshake and ownership boundary need validation against herdr behaviour.

### 10.3 Stop and resource cleanup

Stop targets a verified runtime and its managed resources. Closing a workspace
must account for other agents or panes in it. Prefer the narrowest operation
that stops the intended runtime.

Worktree removal, branch deletion and folder cleanup remain distinct from stop.
Task completion or a result's wording does not expand resource authority.

Management is recorded against stable coordinator identity, not its transient
conversation. Coordinator absence preserves pending review and lifecycle state.
Manual management transfer and orphan recovery require an explicit policy.

## 11. Harness adapter contract

Adapters expose capability-aware operations:

```text
probe capabilities
prepare launch / resume
identify conversation
verify conversation continuation
observe execution
notify or submit message
reconcile submission
request interruption / stop
```

Capabilities distinguish:

- Native session identification and continuation verification.
- Exact-conversation resume.
- Structured message submission.
- Submission readback or receipts.
- Delivery while busy.
- Execution observation and interruption.
- Graceful runtime shutdown.

A terminal-only adapter may support launch and observation while offering only
limited notification guarantees. Capabilities describe verified behaviour for a
specific adapter/harness version, not merely the existence of a CLI flag.

### 11.1 Initial capability evidence

Inspected locally on 2026-10-03:

| Product | Installed version |
| --- | --- |
| OpenCode | 1.18.34 |
| Hermes | 0.21.5+2164.gfdec926, upstream fdec926e |
| Herdr | 0.9.3, bundled API protocol 22 |

| Capability | OpenCode | Hermes |
| --- | --- | --- |
| Initial interactive instructions | `--prompt` | `chat -q` seeds a session on a TTY |
| Explicit conversation resume | `--session ID` | `--resume ID` |
| Structured single-run output | `run --format json` | `chat --format stream-json` |
| Guidance | Agent can load a skill | `--skills` supports preload |
| Herdr interactive launch | `herdr agent start --kind opencode` | `herdr agent start --kind hermes` |

These are CLI/source findings, not completed live integration tests. Launching a
second CLI process with a resume flag is not established as a safe mechanism for
notifying a conversation already active in another process.

Hermes' installed compression implementation follows continuation sessions and
updates the live session context. Its stream JSON implementation emits native
session IDs. The adapter's method of verifying this lineage remains to be chosen.

Herdr's `agent prompt` help states that waiting does not track turns and may match
completion of an already active turn. Its inspected prompt schema has no explicit
delivery idempotency key or expected-conversation binding. Retinue therefore
requires its own recipient acknowledgement and uncertainty handling.

## 12. CLI and skill

The CLI exposes structured JSON output and human-readable output over the same
service API. Mutating operations support idempotency keys. Reusing a key with
different parameters is an error.

Proposed command groups:

| Purpose | Commands |
| --- | --- |
| Discovery | `agent list`, `agent inspect` |
| Registration and provisioning | `agent register`, `agent launch` |
| Backlog | `task create`, `task list`, `task inspect` |
| Assignment | `task assign`, `task delegate` |
| Inbox | `inbox list`, `inbox read`, `inbox wait` |
| Communication | `message send`, `question ask`, `question answer` |
| Results and review | `attempt submit`, `result accept`, `result request-changes` |
| Lifecycle | `agent resume`, `agent stop`, `operation inspect` |

Command names are proposed, not implemented. Pause, cancellation, reassignment
and backlog-editing argument contracts must be finalised with the API schema.

`task delegate` coordinates task creation, optional provisioning and assignment.
It uses the same records and recovery rules as the individual operations.

The CLI derives caller identity from registered runtime context rather than
requiring agents to repeatedly supply their own identity. The shared skill teaches
discovery, delegation, reading assignments, question handling, result submission
and review. Harness-specific guidance is kept small.

A skill cannot wake an idle agent. Initial delivery mechanisms are:

- Launch instructions for newly provisioned workers.
- CLI inbox reads by running agents.
- A verified herdr or harness notification mechanism for existing agents.

Without a usable notification mechanism, messages remain queued until read. A
waiting CLI process can observe new messages, but this alone does not establish
that the model will consume its output or begin another turn.

MCP and native harness plugins can expose the same API later. They must not
become independent owners of coordination state.

## 13. Herdr plugin integration

Use herdr's existing plugin manifest and API for:

- Task and inbox pane entry points.
- Agent launch, registration and lifecycle actions.
- Pane/workspace task summary metadata.
- Discovery and event-driven reconciliation hints.

The installed API exposes plugin linking, enablement, actions, plugin panes,
events, agent start/prompt operations, and conversation/resume reporting. An
installed plugin manifest also demonstrates startup commands and event handlers.

A startup action may connect to or ensure Retinue is running. Service supervision
is an explicit concern and cannot depend on a UI pane staying open. The exact
service manager and startup contract remain undecided.

Views are projections of Retinue state. They distinguish task outcome, pending
review, delivery uncertainty, runtime availability and retirement progress.

## 14. Persistence and machine boundaries

Proposed deployment:

- One service per user per machine, serving multiple projects and herdr sessions.
- SQLite on a local filesystem under `$XDG_STATE_HOME/herdr-retinue/`, falling
  back to `~/.local/state/herdr-retinue/`.
- Versioned schema migrations and transactional domain updates.
- Durable outbox for notifications and lifecycle scheduling.
- Stable operation IDs, revisions and deduplication records.
- Event subscriptions for responsiveness, reconciliation for recovery.

State changes and their associated outbox entries commit together. External
herdr, harness and Git operations cannot participate in that transaction.

Each task has one authoritative service. Remote representations are projections,
not competing writable copies. No shared SQLite file, database replication or
cross-machine transaction is assumed.

Machine-scoped references are required from the beginning. Remote provisioning,
delivery transport, identity establishment and outage behaviour need a separate
protocol decision before cross-machine execution is implemented. Existing SSH
delivery in `opencode-herdr` is reference material, not an automatically inherited
contract.

Retain records in the initial implementation. A later retention policy must
preserve unresolved operations, result history and sufficient idempotency evidence.

## 15. Recovery invariants

| Event | Required behaviour |
| --- | --- |
| Coordinator exits during launch | Service reconciles persisted launch intent and tracked resources |
| Coordinator unavailable during review | Result waits for acceptance, without automatically retiring the worker |
| Worker exits before review | Result remains reviewable, corrections may require exact-conversation resume |
| Service restarts after acceptance | Persisted retirement operation resumes |
| Runtime stop fails | Assignment stays accepted and operation failure remains visible |
| Prompt response is lost | Delivery becomes uncertain until reconciled or acknowledged |
| Native session changes | Verify continuation before changing dispatch binding |
| Pane is reused | Refuse stale delivery and lifecycle targets |
| Blocking child awaits an answer | Answer remains accessible independently of the work queue |
| Result arrives after cancellation | Preserve it as late without reopening cancelled work |

Observations always carry freshness information. Unavailable is not absent.
Heartbeat loss does not automatically mean task failure or permission to replace
an executing worker.

## 16. Delivery sequence

1. Define domain schemas, state transitions and CLI/API contracts.
2. Implement standalone service, SQLite persistence, caller registration, CLI and
   recovery behaviour.
3. Implement herdr discovery, placement and recoverable lifecycle operations.
4. Add OpenCode and Hermes launchers, identity handling and shared guidance.
5. Verify bidirectional delegation, review, retirement and failure recovery.
6. Add herdr actions and a task/inbox pane using the same service state.

The existing `opencode-herdr` implementation is a source for delivery, immutable
results, correlated questions and recovery logic. Its OpenCode-hosted worker,
conversation-bound identities and configuration-directory database location are
not requirements for this design. Existing state import needs an explicit plan.

## 17. Acceptance criteria

### Coordination

- A task can be created and inspected without an agent or herdr instance.
- Agents discover each other and delegate directly using the backlog's task and
  assignment model.
- One active assignment per agent is enforced across concurrent coordinators.
- Blocking dependencies reject cycles and prevent premature parent acceptance.
- Active-work answers are not held behind the new-assignment queue.
- Attempts, submitted results and review history survive pause and rework.
- Duplicate operations do not create duplicate assignments or results.

### Identity and lifecycle

- An existing agent can register and receive work without being recreated or
  granting lifecycle control.
- A task-scoped worker is provisioned with durable resource and manager records.
- Submission keeps that worker available for review corrections.
- Acceptance of the exact current result schedules retirement once.
- Stale acceptance cannot retire a worker executing a newer attempt.
- Persistent agents remain registered after acceptance.
- Retirement stops only the intended runtime and preserves unrelated resources.
- Failed shutdown remains separate from accepted work.
- Verified Hermes continuation preserves Retinue identity and delivery history.
- An unverified binding change prevents dispatch to an unintended conversation.

### Delivery and recovery

- Herdr prompt completion is never treated as task completion or recipient receipt.
- A service restart at launch, notification, submission, acceptance and retirement
  boundaries does not cause blind duplicate execution or untracked resources.
- Worker or coordinator outages preserve task and review state.
- Pending deliveries and operations expose uncertainty and actionable failure state.
- Cancellation does not falsely report that execution stopped.

### End-to-end harness validation

- Hermes delegates to OpenCode and OpenCode delegates to Hermes.
- The exercised workflows include an existing agent and a newly created
  task-scoped worker.
- A worker asks a question, receives its answer and submits a result.
- Its coordinator requests corrections, accepts the newer result and observes
  retirement of the task-scoped runtime.
- Both harnesses use the shared CLI/skill contract without a native Retinue
  harness plugin.
- Live tests distinguish actual behaviour from mocked adapter tests and CLI help.

## 18. Open decisions and investigations

1. Implementation language, service transport and service supervision.
2. CLI executable name, complete argument schemas and error codes.
3. Caller registration, runtime credentials and verification of native conversation
   bindings, including Hermes continuation lineage.
4. Exact notification, busy-delivery, graceful-stop and resume capabilities for
   each initial harness and supported version.
5. Herdr restoration ownership and the handshake preventing duplicate relaunch.
6. Coordinator transfer, orphan recovery and human acceptance when the original
   coordinator is permanently unavailable.
7. Handling non-blocking child work whose task-scoped coordinator has retired.
8. Detailed failure, pause, cancellation and reassignment transitions, including
   prevention of overlapping execution after an uncertain cancellation.
9. Cross-machine transport, registration and routing. Machine integration does
   not by itself establish remote execution support.
10. Artefact storage, retention, archival and importing existing coordination state.
11. Worktree provisioning and cleanup policies beyond the separation from retirement.
12. Task/inbox user interface layout and refresh behaviour.

The future external communications gateway remains outside this version's design
scope. Stable agent IDs and a service API provide the intended integration point.

## 19. Design evidence and references

Local sources inspected during design:

- `~/play/opencode-herdr/docs/coordination-data-model.md`: prior coordination model.
- `~/play/opencode-herdr/docs/cutover.md`: implemented behaviour and limitations.
- `~/play/opencode-herdr/src/model.ts`: existing conversation/placement coupling.
- `~/play/opencode-herdr/src/delivery.ts`: worker, OpenCode submission and readback.
- `~/play/herdr-envoy/README.md`: earlier task-scoped and interactive peer lifecycle.
- `herdr api schema --json`: installed API surface, protocol 22.
- `herdr agent start --help` and `herdr agent prompt --help`: launch and prompt contracts.
- `~/.config/herdr/plugins.json`: installed examples of actions, panes and startup/event hooks.
- `opencode --help` and `opencode run --help`: installed launch/resume/output options.
- `hermes --help` and `hermes chat --help`: installed launch/resume/skill/output options.
- `~/.hermes/hermes-agent/agent/conversation_compression.py`: native continuation handling,
  particularly `_adopt_live_compression_child` and `_rebind_session_context`.
- `~/.hermes/hermes-agent/hermes_cli/stream_json.py`: structured output and session identity.

These paths identify design evidence on the development machine. Runtime
dependencies must use supported interfaces rather than assuming those source
checkouts or local installation paths exist.
