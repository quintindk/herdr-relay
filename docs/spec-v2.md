# Herdr Relay specification, version 2

- Date: 2026-10-03
- Status: Proposed implementation contract
- Product: **Herdr Relay**
- Package name: **herdr-relay**
- Initial harnesses: OpenCode and Hermes
- Work backend: Paperclip
- Implementation progress: [first working slice](build-v1.md)
- Native progress: [reserved OpenCode delivery](native-opencode-v1.md)
- Current coverage and remaining limitations: [implementation status](implementation-status.md)
- Approved control/topology decision (2026-10-04): [owned-runtime nodes over SSH](node-topology.md)

## 1. Defining principle

> The requirement is lightweight interaction backed by durable state. Structure
> should appear when work needs it, rather than being something you must configure
> before asking an agent for help.

Herdr Relay connects Paperclip work to persistent agents in herdr. It remains a
herdr plugin, with a persistent service, agent-facing CLI/skill and external
Paperclip adapter supporting that integration.

An agent can start with a conversation and a directory. Roles, reporting lines,
projects, teams and workflow graphs are not prerequisites to asking for help.
Capabilities and context aid discovery without defining permanent job boundaries.

This version supersedes the standalone task-engine architecture in
[version 1](spec-v1.md). The [scenario baseline](evaluation-baseline-v1.md) remains
the behavioural evaluation contract. Existing prototype filenames using Retinue
are historical and do not define the product name.

## 2. Product components

| Component | Responsibility |
| --- | --- |
| Herdr plugin | Actions, task/inbox views, agent discovery entry points and placement integration |
| Relay service | Durable external-agent bindings, delivery state, runtime operations and reconciliation |
| Relay CLI | Structured agent/human commands against the service |
| Shared skill | Teaches discovery, delegation, assignment handling, questions and submission |
| Paperclip adapter | Converts Paperclip execution invocations into bounded work in Relay-managed conversations |
| Harness adapters | Native conversation identification, notification, activity observation, resume and interruption |

These are components of one integration, not separate agent personas. Relay does
not run a model to decide what work should be delegated. The participating agents
and human make those decisions.

Use herdr's existing plugin manifest for actions and views. The Relay service
must survive closing its UI pane, disconnecting a herdr client or ending an agent
conversation. Service supervision and installation packaging remain implementation
decisions. A plugin startup hook alone is not a supervision guarantee.

The working repository directory is not renamed by this specification. CLI binary
naming and package-name availability require confirmation before distribution.

## 3. Authorities and boundaries

| Authority | Owns |
| --- | --- |
| Paperclip | Backlog, human/agent assignment, dependencies, questions/interactions, review decisions and work-run history |
| Relay | External agent registration, exact runtime/conversation bindings, dispatch receipts and lifecycle operation progress |
| Herdr | Machines, terminal processes, panes and workspaces |
| Harness | Native conversations, tools and model execution |
| Git | Worktrees, branches, file changes and commits |

Paperclip is the single authoritative work store. Relay may cache projections and
persist pending mutations, but must not maintain a competing backlog or review
state machine. Pending backend updates remain visibly pending.

Relay owns the lifecycle of the actual participating agent runtimes. Paperclip
continues to own its own bounded work-run lifecycle. Ending a work run does not
mean closing the conversation or terminating the process.

For agents using Relay, Paperclip dispatches through the Relay adapter. Another
Paperclip adapter must not independently launch the same logical agent.

Standalone support now means that CLI/service coordination does not require an
open herdr view or a harness plugin. Paperclip remains a required work backend.
Outage behaviour is described in section 10.

## 4. Identity and work relationships

### One Paperclip identity per logical agent

```text
Paperclip
 +-- Daily driver ------+
 +-- Inbox monitor -----+
 +-- Project agent -----+--> Relay adapter/service --> corresponding conversations
 +-- Graph worker ------+                            and herdr resources
```

Each agent has its own Paperclip ID, assignments and run history. Multiple agents
share the same adapter implementation, configured with different Relay bindings.
There is no single Relay agent impersonating all participants.

Relay records:

- Stable logical agent ID and associated Paperclip agent ID.
- Label, optional capabilities and current directory/repository context.
- Harness type and instance identity.
- Stored conversation reference and live runtime incarnation.
- Machine and herdr server/session, workspace, pane and terminal references.
- Binding revisions and verified continuation history.
- Lifetime policy and lifecycle controller, where applicable.

Names, directories and pane labels are not identities. Stored conversation IDs
and live runtime IDs may differ. Verified continuation changes a binding while
preserving its history. An unrelated replacement conversation is never selected
silently.

### Task-specific relationships

Requester, assignee, reviewer and lifecycle controller are separate relationships.
An agent requesting a subnet from another agent does not become its manager.
Receiving work does not grant the sender permission to stop the recipient.

A default Paperclip company can act as an internal namespace. Ordinary agents
can use its default general role without a title or reporting line. Relay must
not introduce mandatory organisational setup through its own interface.

Humans are actual Paperclip user participants, not agents pretending to be human.
Shared work can have one accountable owner with collaborators or separately
assigned child tasks. Tasks may be unassigned and need not belong to a project.

## 5. Lifetime and execution

| Lifetime | Behaviour |
| --- | --- |
| Persistent | Registered across runtime restarts, accepts successive assignments |
| Service-scoped | Performs a standing brief within an operating window or until explicitly stopped |
| Task-scoped | Reserved for one assignment, including corrections, then retired after acceptance and required finalisation |

All lifetimes retain durable identity and operation records. Temporary execution
does not mean volatile bookkeeping.

A standing monitoring service may use scheduled checks or subscriptions. It does
not require a continuously executing model. Source cursors belong to the monitoring
integration and must survive restarts independently of individual model turns.

An agent may have multiple open obligations. Default to one executing turn per
conversation, subject to the harness's capabilities. Waiting on a response releases
execution capacity without losing the obligation. New work and active-work answers
must not block each other behind an assignment-wide FIFO queue.

Task-scoped workers remain reserved for corrections while their result is under
review. After submission they do not keep editing the submitted candidate.

## 6. Paperclip adapter contract

The adapter is an external Paperclip adapter package. It uses supported execution
interfaces rather than modifying Paperclip core.

Conceptual configuration:

```text
Paperclip agent: Daily driver
  adapter: herdr_relay
  relay binding: exact registered OpenCode conversation

Paperclip agent: Inbox monitor
  adapter: herdr_relay
  relay binding: exact registered Hermes conversation
```

The adapter type and field names above are illustrative, not a released schema.

For each invocation, the adapter:

1. Receives the Paperclip agent, run, work context and scoped authentication.
2. Persists dispatch intent in Relay, keyed by backend run and binding revision.
3. Resolves the exact eligible conversation and requests delivery.
4. Tracks recipient acknowledgement, progress and submission/waiting state.
5. Updates Paperclip through the appropriate work APIs.
6. Returns a bounded execution result once the native turn and required backend
   updates have settled.

The adapter does not equate submission, acceptance and native process exit.
Paperclip's existing review machinery remains authoritative. Exact mappings for
blocked runs, intermediate turns and review stages need contract tests against a
pinned Paperclip release.

A waiting question normally ends the current bounded execution after persisting
the waiting path. A response causes a later run in the same stored conversation.
Keeping a run open for an entire day is not the monitoring-service model.

Cancellation must propagate to the exact native work invocation and settle before
the adapter reports it stopped. Killing a bridge process is not proof that an
external harness stopped. If interruption cannot be established, report uncertainty
and prevent unsafe overlapping dispatch. Do not kill unrelated human work.

## 7. Agent-facing CLI and skill

Agents use a shared CLI rather than constructing Paperclip API requests. Proposed
command families are:

```text
agent list / inspect / register / launch / resume / stop
task create / list / inspect / assign / delegate
inbox list / read / wait
work read / acknowledge / progress / ask / answer / submit
result inspect / request-changes / accept
operation inspect / retry
```

Exact executable name and arguments remain undecided. JSON output must carry IDs,
revisions, receipts and actionable errors. Human-readable output is a projection
of the same responses.

Caller identity comes from registered runtime context. Work commands infer the
current binding only when unambiguous. Agents with multiple obligations must
explicitly select the work when necessary. Guessing the latest task is forbidden.

The skill teaches:

- Discover peers and ask directly without establishing a hierarchy.
- Use a message for information and a task for a tracked deliverable.
- Read and acknowledge work before executing it.
- Record questions and waiting state rather than polling indefinitely.
- Submit an exact result and stop editing it during review.
- Request corrections or accept results using the recorded work identities.

The service enforces state transitions. The skill is guidance, not a substitute
for duplicate protection, identity checks or recovery.

Backend credentials remain behind Relay's CLI/service boundary and are not placed
in prompts. Credential scope, renewal and storage are implementation contracts.

## 8. Completion, acceptance and finalisation

```text
Dispatch --> Acknowledge --> Execute --> Submit --> Review
                              ^                    |
                              +---- Corrections ---+
                                                   |
                              Required finalisation +--> Accept
                                                           |
                                      Task-scoped retirement operation
```

### Submission

Submission means the worker finished an attempt, not that the requester accepted
the work. Relay durably records the submitted result and its backend association
before acknowledging the CLI call.

The result identifies the task/attempt, summary, deliverables, checks and evidence.
Uncommitted changes require candidate identity beyond a branch name or HEAD commit,
such as a patch/file-state digest. Evidence must distinguish worker-reported checks
from checks the reviewer independently executed.

A stable submission key returns the recorded result on an identical retry. Changed
content under the same key conflicts at Relay's boundary. Both evaluated backends
replay original create content rather than enforcing this stricter mismatch rule.

### Review and acceptance

Use Paperclip review decisions and revision-bound interactions to represent the
agreed review contract. Acceptance must refer to the exact current candidate.
Requested corrections preserve previous evidence and create a new attempt.

The relationship between candidate revisions, review stages and Relay attempts
must be explicit. General review approval alone must not accidentally accept a
stale candidate.

### Finalisation and retirement

For the graph workflow, the daily driver checks and commits the candidate before
accepting the handback. The human's instruction authorises that commit. Submission
alone does not.

Acceptance triggers retirement of a task-scoped worker after execution has settled.
Persistent agents remain registered. Stopping the process, closing its pane,
removing a worktree and deleting a branch are separate resource operations.

Retirement failure does not change accepted work to failed. Persist progress so
retrying shutdown or cleanup cannot repeat the task or create another commit.

## 9. Practical workflows

### Daily driver and inbox monitor

1. Human asks daily driver to monitor inbox and Teams during an operating window.
2. Daily driver creates a service-scoped helper with a standing brief and response
   destination. Relay manages its runtime and schedule linkage.
3. Monitor records source cursors and emits relevant events with source references.
4. Daily driver chooses notification, human-owned task, agent-owned task or
   delegation to an existing project agent.
5. Relevant project results return to the daily driver for presentation.
6. The monitoring window ends without affecting unrelated agents or obligations.

Source events and repeated notifications must not create duplicate work. An event
is not automatically a task. Monitoring connectors and a general receipt-only
message channel require an explicit mapping beyond Paperclip issues.

### Demo deployment requests a subnet

1. Demo agent discovers a peer capable of subnet vending.
2. It sends a tracked request without acquiring lifecycle control.
3. Provider asks a correlated question if needed and executes under its own Azure
   authority. The requester does not supply authority merely by asking.
4. Provider returns the subnet ID and configuration.
5. Requester verifies suitability and resumes the dependent deployment step.

Provider-side provisioning is idempotent and reconciles resources after uncertain
responses. Backend task deduplication alone cannot prevent duplicate Azure effects.

### Graph update in a worktree

1. Daily driver creates a task and a task-scoped worker with isolated worktree.
2. Worker updates the graph and submits an exact candidate, then stops editing.
3. Daily driver reviews, runs checks and requests corrections if necessary.
4. Daily driver commits the reviewed candidate under the human's instruction.
5. Acceptance is recorded in Paperclip.
6. Relay retires the worker and performs separately scoped eligible cleanup.

Dirty cleanup remains blocked independently of accepted task outcome. A commit
that succeeded before a lost response is reconciled, not repeated.

## 10. Persistence, recovery and outages

Relay's proposed local store records only integration state:

- Agent/runtime/conversation/placement bindings and their revisions.
- Backend run-to-native invocation mappings.
- Dispatch and receipt history.
- Pending backend mutations with stable operation keys and payload digests.
- Resource references and recoverable launch/stop/cleanup operations.

SQLite under `$XDG_STATE_HOME/herdr-relay/` is the initial proposal. Paperclip retains
its own database. Do not replicate Paperclip's task database into Relay.

Persist intent before external effects. Backend changes and native operations
cannot share a transaction. Use an outbox, explicit uncertainty and reconciliation.

| Condition | Required response |
| --- | --- |
| Harness idle without submission | Keep work unresolved |
| Worker exits without result | Record runtime exit, retain outstanding work |
| Backend unavailable | Preserve received receipts and pending writes, expose unavailable authority |
| Backend returns after outage | Reconcile pending operations before replaying them |
| Native submission uncertain | Read back or await acknowledgement, do not blindly resubmit |
| Coordinator unavailable | Preserve pending review and reserved worker |
| Acceptance recorded before Relay crash | Reconcile backend acceptance and resume the same retirement operation |
| Native conversation changes | Verify continuation before rebinding |
| Pane reused | Refuse stale dispatch or shutdown target |

Offline operation does not grant new assignment or acceptance authority. Whether
already-authorised execution continues while disconnected must be an explicit
policy. Recovery must not run competing tasks while previous execution is uncertain.

Herdr and Relay must agree on terminal restoration ownership. Relay must reconcile
herdr-restored sessions rather than independently launch duplicates. Cross-machine
Relay routing and service placement remain to be specified.

## 11. Evidence and implementation limits

The [scenario evaluation](evaluation-results-v1.md) established native work-model
behaviour against pinned Paperclip and OpenRig releases.

The [native conversation evaluation](native-conversation-evaluation-v1.md)
established:

- Existing server-backed OpenCode and Hermes conversations retained prior context.
- Native agents executed a CLI helper and wrote Paperclip comments under legitimate
  agent/run identities.
- A custom process-holder bridge achieved this without product source changes.
- Hermes stored conversation and live runtime identities differed after resume.

It did not establish:

- A finished external Relay adapter or automatic terminal adoption.
- Busy delivery, concurrent human input or reliable native cancellation.
- Recovery of an interrupted native invocation under the same backend run.
- Automatic acceptance-triggered retirement or integrated worktree finalisation.
- Hermes classic REPL integration or arbitrary OpenCode TUI endpoint discovery.

The process-holder prototype is evidence of connectivity, not a production
supervisor. The adapter must supervise and reconcile the native work it dispatches.

## 12. First implementation milestone

Build a bounded external Paperclip adapter, Relay service and CLI that handle one
existing conversation in each initial harness.

Acceptance criteria:

1. Register two logical agents with separate Paperclip identities and no manager.
2. Bind each to an exact existing native conversation without replacing it.
3. Dispatch work through the installed external adapter and record acknowledgement.
4. Have each native agent submit through the CLI with correct task/run attribution.
5. Preserve the conversation after the Paperclip execution run ends.
6. Reject stale binding and changed-payload retries.
7. Handle waiting questions through bounded runs and later continuation.
8. Cancel one assigned native turn without claiming stopped execution prematurely.
9. Restart Relay at uncertain delivery/result boundaries without duplicate work.
10. Show task outcome, delivery uncertainty and runtime state distinctly in CLI output.

Then add task-scoped provisioning, exact-candidate review linkage, finalisation,
acceptance-driven retirement and the herdr task/inbox view. Run the three scenario
families end to end before calling the integration complete.

## 13. Open decisions

The user selected the owned-runtime boundary on 2026-10-04. Automatic lifecycle
control targets dedicated runtimes on local Relay nodes. Shared conversations stay
conservative. Nodes share Paperclip and use SSH for remote administration/adapter
attachment. This resolves the initial control-boundary and transport choice without
requiring modifications to the native harnesses.

- Exact Paperclip adapter result, cancellation and recovery contracts per release.
- Mapping of Relay attempt identity to Paperclip runs and candidate revisions.
- Native notification and activity interfaces, particularly arbitrary existing TUIs.
- Runtime credential binding, renewal and caller verification.
- Service supervision, packaging, CLI name and name availability.
- Monitoring schedule ownership and persisted source cursor storage.
- Receipt-only messages and events without manufacturing task obligations.
- Cross-machine service topology and outage policies.
- Herdr restoration ownership and resource-management scopes.
- Human ownership transfer and orphaned task-scoped workers.
- Gateway channel routing, deferred to a separate specification.
