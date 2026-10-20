# Herdr Relay specification, revision 3

- Date: 2026-10-20
- Status: Implementation contract. The architecture is agreed, not implemented.
- Product/package: **Herdr Relay** / **herdr-relay**
- Target product version: **0.2.0**
- Target harnesses: **OpenCode v2** and Hermes
- Initial work backend: native Relay backend
- Compatibility provider: Paperclip
- Next independent provider: GitHub Issues

## 1. Purpose and decisions

Herdr Relay provides durable task management and collaboration between independent
agents on interactive machines and headless workers. The human coordinates work
through any participating agent. Agents collaborate through a shared backend,
without a permanent coordinator agent, privileged Relay node, reporting hierarchy
or required direct connection between machines.

Version 0.2.0 establishes these decisions:

1. Build a small native backend for tasks, interactions and collaboration events.
2. Separate the Tasks provider contract from the Collaboration store contract.
3. Make Paperclip optional, including its agent management, heartbeats and cron.
4. Run execution admission, native supervision and scheduling on each local node.
5. Exchange cross-machine work through the shared backend. Each Relay consumes
   addressed requests and relevant events, then publishes local outcomes.
6. Treat questions, answers, escalation and candidate review as first-class
   interactions, rather than inferring them from comments or task status.
7. Preserve local automation during backend disconnection and reconcile afterwards.
8. Prove the native workflow first, retain a Paperclip implementation, and use
   GitHub Issues to validate the independence of the provider contracts.
9. Target OpenCode v2 for interactive and managed execution. OpenCode v1 support
   is transitional migration compatibility, not the target architecture.

This specification supersedes [specification version 2](archive/spec-v2.md) where it makes
Paperclip authoritative or mandatory, and the earlier Paperclip-dependent topology
and scheduling direction. The old document's numbering is a document revision,
not product version 0.2.0. This document is revision 3 for product version 0.2.0.
Existing feature documents describe the shipped 0.1.x
implementation until explicitly updated. [Implementation status](implementation-status.md)
remains the evidence record. This specification does not change the package version
or certify a release.

## 2. Scope

### Required outcomes

- Tasks, comments, parentage, dependencies, human responsibility and task queries.
- Independent agent identities, node discovery and explicit execution requests.
- Interactive Herdr machines and dedicated headless workers in one installation.
- Board-mediated delegation, progress, results and asynchronous continuation.
- Questions addressed to an initiating agent or human, including escalation.
- Human and task-scoped agent review of exact submitted candidates.
- Durable local recurring jobs, delayed continuations and human reminders.
- Backend-independent execution, recovery and runtime/resource lifecycle.
- A versioned provider boundary and a clean native backend, with Paperclip migration
  designed for a later milestone.
- OpenCode v2 server/TUI plugins, native adapter and managed runtime migration.

### Exclusions

- Multi-master replication of task databases or shared SQLite files.
- Leader election or automatic reassignment from an unreachable node.
- Mandatory direct node-to-node messaging, inbound node listeners or all-to-all links.
- Bidirectional task mirroring between providers.
- A general project-management suite, organisational hierarchy or workflow designer.
- Automatic replication of repositories, worktrees or arbitrary filesystem paths.
- Exactly-once native execution or guaranteed immediate remote cancellation.
- Importing existing Paperclip tasks or interactions for the initial native cutover.

## 3. Architecture and authority

```text
        Native Relay backend initially
      Tasks + Collaboration + durable events
              ^        ^        ^
              |        |        |
         Relay node Relay node Relay node
           desktop    laptop     server
              |        |        |
           Herdr     Herdr     headless
           agents    agents     agents
```

Every node runs the same local Relay service capabilities. The backend validates
shared records and transitions, authenticates callers and exposes durable changes.
It does not choose a lead agent, plan work, launch native processes or schedule
model turns. Participating agents and the human make task-specific decisions.

The shared backend is an infrastructure dependency, as an external tracker would
be. It is not a Relay execution coordinator. Offline nodes retain local authority
over their resources and installed automation.

| Authority | Owns |
| --- | --- |
| Tasks provider | Task records, comments and supported task relationships/history |
| Collaboration store | Addressed requests, interactions, directory records and collaboration events |
| Local Relay node | Admission, local schedules/occurrences, execution journals, bindings and lifecycle operations |
| Herdr | Local terminal placement, panes and workspaces |
| Harness | Native conversations and model/tool execution |
| Git | Candidate bytes, commits, branches and worktrees |
| Human | Instructions, grants and decisions requiring human authority |

Resource ownership is not a management hierarchy. An initiating agent may organise
one task without gaining general control over another agent or its machine.
Delegation does not grant interruption, process termination or worktree cleanup.

## 4. Provider boundaries

### 4.1 Tasks

The Tasks API exposes normalised operations for listing, inspecting, creating and
updating tasks, reading/adding comments, managing relationships and reading activity
where supported. It owns public validation, authorisation and operation semantics.
Providers own native authentication, mapping, API calls, pagination and reconciliation.

The task model includes opaque Relay identity, optional native identifier/URL,
title, description, priority, labels, status, human responsibility/assignees,
optional project/parent/dependencies, revisions, timestamps and external references.

The status vocabulary is `backlog`, `todo`, `in_progress`, `in_review`, `blocked`,
`done` and `cancelled`. Providers declare mappings and limitations. Task status is
not proof of native execution, answer resolution or candidate acceptance. Human
responsibility and an agent's execution assignment are separate relationships.

The provider interface must not require agent registration, heartbeats, routine
creation or candidate acceptance. These belong to collaboration or local execution.

### 4.2 Collaboration

The Collaboration contract exposes:

- Node/agent registration and timestamped discovery.
- Addressed execution requests, admission receipts and execution projections.
- Questions, forwarding/escalation, answers and candidate review.
- Recipient inboxes and explicit acknowledgement.
- Durable event consumption and reconciliation.

Tasks and Collaboration are separate contracts even when served by one backend.
Supporting issues/comments does not automatically provide reliable collaboration.

### 4.3 Selection and capabilities

An installation selects one Tasks provider. It does not mirror tasks between
Paperclip and GitHub or aggregate multiple authoritative task stores in this
version. Switching providers is an explicit migration.

The native backend implements both contracts first. Paperclip remains a provider
and compatibility implementation. GitHub Issues is the next independent provider.
Before implementing GitHub, document whether:

1. GitHub implements both contracts and can replace the whole shared backend, or
2. GitHub holds tasks while the native backend remains the Collaboration store.

Implementation scope decision: external task adapters initially use option 2,
documented in [provider contracts](providers-v3.md). Native Collaboration remains
required. Whole-backend replacement remains a later capability, not an implied
property of a task-only provider.

GitHub task support alone must not be presented as GitHub-only operation. Do not
force native interactions into issue comments before proving their behaviour.

Capabilities describe native versus mapped fields, relationship support,
conditional writes, deduplication, activity coverage and change consumption. Missing
capabilities produce explicit unsupported/incomplete results, never empty success.
Relay revision hashes must not be advertised as backend compare-and-swap.

## 5. Native backend

Build a bounded service for the required records. The Herdr task/inbox pane and
existing CLI/tools are the first user interfaces.

The initial deployment uses one backend service with its own local SQLite database
and transactional event outbox. Nodes each retain a separate local SQLite database.
Never mount one SQLite database across machines. Multi-instance backend availability
and a different database engine are future work behind the same contracts.

Initial deployment decisions, 2026-10-20: the current development machine will host the
native backend server. It may also run a normal Relay node. Co-location does not
give that node additional execution authority. Keep backend and node state,
credentials and service lifecycles separate so the backend can move later without
changing logical identities.

- Expose the backend over public HTTPS through Cloudflare Tunnel (`cloudflared`),
  following the existing Portcullis service's API-key access pattern and reusing
  its existing keys as instructed. Inspect that deployment's actual header,
  validation and secret-loading contract before configuring Relay. Do not guess
  the contract or copy key values into repository files, logs or documentation.
- Public backend hostname: `relay.synthswarm.com`.
- Keep the backend origin local to the host. The tunnel supplies remote ingress,
  not a directly exposed origin listener.
- Initially support one human user and that user's agents. Preserve distinct
  user, node and agent identities without requiring multi-user administration.
- Start with an empty native backend. Existing Paperclip data remains in Paperclip.
  Import/migration is deferred and is not an initial native cutover requirement.

Required shared records:

| Record | Purpose |
| --- | --- |
| Task/comment/relation | Work, responsibility, discussion and dependencies |
| Node/agent advertisement | Identity, capabilities and last reported availability |
| Execution request/receipt | Addressed attempt and admission/outcome projection |
| Interaction/answer/routing event | Questions, decisions and provenance |
| Candidate/review decision | Exact result identity and authorised decision |
| Event | Durable scoped changes with opaque consumption cursors |
| Operation receipt | Idempotency, payload matching and conditional-write outcome |

Native mutations require stable idempotency keys with payload-digest checks and
expected revisions where editing existing state. The mutation, operation receipt and
resulting event commit together. Identical retries return the original receipt.
Changed payloads under the same key conflict. Competing decisions cannot both
resolve the same current interaction.

Authenticated remote access uses HTTPS. Nodes have revocable identities and scoped
permissions, not a shared operator credential passed to workers. The local Unix
socket remains the harness-facing credential boundary. Enrolment, credential
rotation and protocol compatibility need explicit contracts before deployment.

The reused Portcullis API keys authenticate ingress for this initial trusted-user
deployment. They do not identify an individual agent or grant operator authority
to every request. Relay still authenticates enrolled nodes and enforces scoped
actor/action permissions. Node credentials remain distinct from the ingress key.

## 6. Identity, discovery and addressing

Use stable backend-independent IDs for users, nodes, agents, tasks, execution
requests, runs, interactions, schedules and occurrences. Bindings retain their own
identity/revision for the exact native conversation. Native provider IDs are
mappings, not public UUID validation rules. Names and paths are not identities.

Each agent has one owning node in this version. Conversation replacement does not
silently transfer executions or review rights. A directory reference includes its
node. The same path on two machines is not the same resource.

Nodes publish their local directory and last-seen state. Discovery shows node,
capabilities, interactive/headless mode, timestamp and stale/unknown state. An
advertisement is advisory and grants no dispatch authority. The destination node
makes the final admission decision.

Execution origins record the initiating agent, node, task and exact conversation
when present. Human recipients use durable user identities with a preferred chat
delivery location. Operator-created tasks need not invent an originating chat.

## 7. Board-mediated execution

An execution request contains at least:

```text
requestId, taskId, taskRevision
origin: agent/user, node, conversation when present
target: nodeId, agentId, binding revision when exact-targeted
instructions, authorised scope, reviewPolicy
```

Assignment, a mention or a task edit is not an execution request. Multiple watchers
must not independently start the same task.

1. The requester durably publishes the addressed request.
2. The destination validates scope, target and current task context.
3. It records acceptance/rejection or visible deferral before native delivery.
4. It admits at most one unsettled native turn per binding.
5. It publishes progress, questions and results through durable local outboxes.
6. Interested nodes consume events and update inboxes or continuation eligibility.

Only the addressed node may accept a request. Repeat observations use the same
request identity. A shared receipt does not replace local native delivery evidence.
A crash after acceptance is recovered from the local journal, not by assigning a
fresh attempt elsewhere.

Typed event families cover execution requested/accepted/deferred/settled, question
opened/forwarded/answered, result submitted, review decided and cancellation
requested. Exact API/event names remain implementation decisions. Ordinary comments
cannot become protocol commands or authorisation.

An initiating agent can create bounded child work across nodes and inspect results.
Parentage is not a reporting line. Waiting on children releases the native turn
only after settlement. Cancelled children are not successful dependencies.
Candidate-ready events may enable task-scoped review without implying completion.

Repositories/worktrees remain local. Share commits, artifact references and explicit
repository context. A local branch/path is not a transferred artifact. The event
log is not a large-file store.

## 8. Questions, escalation and answers

### 8.1 First-class interaction

A question belongs to a task and identifies the execution needing its answer.
It is neither a comment-only convention nor a mandatory child task.

```text
id, taskId, requestingAgentId, requestingRunId
addressedTo, allowedResponders
prompt, optional choices, blocking
status, revision, origin
```

Question states are `open`, `answered`, `cancelled` and `superseded`. Routing is
separate from resolution. Forwarding/escalation retains the same open question and
appends a routing record. Answers retain author, body/selection, source attribution
and timestamp. Discussion is separate from the resolving answer.

`addressedTo` selects an inbox. `allowedResponders` determines resolution authority.
Reading a notification grants no answering rights. An agent cannot resolve a
human-required question by presenting its own answer as the human's decision.

### 8.2 Worker to initiating agent

A worker asks through its scoped Relay context. The default recipient is the
recorded initiating agent when present. Human-required questions route to the
authorised human. Requests without an initiating agent require an explicit
recipient or responsible human, never a guessed latest chat.

Default responder scope includes the initiating agent and the responsible human
authorised by the execution request. Human-required questions restrict resolution
to that human scope. This makes ordinary escalation possible without granting new
authority merely by changing the recipient.

For a blocking question, persist the question and waiting obligation, then finish
the native turn without submitting a result. Verified settlement releases execution
capacity. Non-blocking questions may leave execution running and must not create a
second overlapping turn.

Local persistence precedes publication. During an outage the worker can settle as
waiting with publication pending, but the question is not reported as delivered
until the backend confirms it. Reconnection publishes the original interaction ID.

The recipient Relay queues delivery until its target conversation can accept it.
An agent can answer from existing instructions and delegated scope. It cannot
invent a human decision or expand authority through an answer.

### 8.3 Escalation to the human

If the initiating agent cannot answer, it forwards the same question to the human,
adding context and a reason. Requester and waiting execution remain unchanged.
Forwarding cannot widen responder authority beyond the original grant. Explicit
grant changes are revisioned/audited. Automatic forwarding loops are refused.

Human questions target the user identity, with the originating chat as preferred
delivery location. They remain in a durable personal inbox and Herdr pane if that
chat closes or goes offline. Another authorised chat can present/answer the same
question without making a copy or inheriting worker execution rights.

The user can answer naturally in chat. A deliberate Relay answer operation selects
the exact interaction and records its permission-checked source message. Ambiguous
answers require clarification. An agent-relayed human answer retains that
attribution, rather than claiming a separately authenticated backend human session.

### 8.4 Resolution and continuation

Resolving an open question requires expected revision and idempotency key.
Recording the answer, changing status and emitting the event are atomic. Identical
retries reuse the receipt. Competing answers conflict. Corrections are explicit
follow-up/superseding interactions, not silent edits to a consumed answer.

Resolution makes waiting work eligible for continuation. Its node rechecks
cancellation, task disposition, target identity, other waits and native admission.
It creates a new Relay run in the original execution chain using a stable
continuation identity. Replay cannot create another continuation. A running author
of a non-blocking question receives its answer without a second native turn.

An answer does not complete a task, approve a candidate, restart cancelled work or
resolve unrelated waits. A missing/replaced conversation leaves a visible recovery
requirement rather than being rerouted silently.

### 8.5 Example

1. A desktop agent delegates deployment preparation to a server agent.
2. The server asks which Azure region to use and settles its turn as waiting.
3. The desktop agent has no region instruction and forwards the same question to
   the user with deployment context.
4. The user answers “South Africa North” in an authorised chat.
5. Relay records that source against the question and publishes one answer event.
6. The server verifies eligibility and resumes the stored conversation.
7. The desktop agent sees resolution and later inspects the submitted result.

## 9. Results, review and lifecycle

Submission, native settlement, publication, acceptance, task completion, commit
finalisation and retirement remain separate facts.

Collaboration records exact candidate identity, author/run, result digest, policy
and decisions. The baseline supports no formal review or explicit human review.
Existing coordinator review maps to an explicitly granted task-scoped reviewer,
not a permanent role. Preserve existing policies or refuse unsupported migrations.

Workers cannot accept their own candidates. Decisions require the current exact
candidate and authorised actor. Closing a provider task is not acceptance or proof
that a process stopped. Reconcile external edits without bypassing review policy.

Acceptance can trigger only previously authorised finalisation/retirement on the
resource owner. Preserve dirty-worktree, process-identity and native-settlement
guards. Cancellation is a durable request. Report requested versus observed
cancellation separately, especially while nodes are offline.

## 10. Local scheduling

Each node owns its installed schedules and is their clock. Paperclip routines and
GitHub Actions are not prerequisites. Remote management travels through addressed
backend records and acknowledgements.

| Intent | Behaviour |
| --- | --- |
| Recurring job | New local occurrence for each eligible firing |
| Delayed continuation | Later eligibility check for existing work |
| Bounded monitoring | Existing standing-task/start/end-window contract |
| Human reminder | Durable notification without a model turn |

Definitions include owner node, revision, instructions, target, cron/one-shot time,
IANA timezone, review policy, busy/offline handling, admission expiry and missed-run
policy. Persist UTC instants and show timezone explicitly. This installation's
display/default timezone is `Africa/Johannesburg`. Document/test cron matching and
DST behaviour rather than inheriting it accidentally from a provider.

Occurrence identity derives from schedule and intended firing instant. It retains
an immutable definition revision and separate scheduling/admission/execution/result
states. Creating it and advancing the local clock checkpoint are one transaction.
External publication is a separate durable operation.

Defaults are no overlap per schedule/binding and skipping missed recurring firings
after downtime. Busy/offline deferral is visible and bounded by installed policy.
Admitted native targets are pinned. Preserve exact-chat versus explicitly
authorised node/folder targeting. Never infer replacements from names or paths.

Jobs may keep local occurrence history, attach to a standing task, or explicitly
create a task per occurrence. Frequent polling must not require an issue per tick.
Local occurrence identity exists before backend task identity is available.

An offline owner continues its last installed definition until reconnection or
expiry. UI/API distinguish change requested from change applied. Remote pause or
cancel is not effective until observed/acknowledged. Pause does not cancel admitted
execution.

Schedules have one owner. Transfers require fencing and acknowledgement from the
old owner before activating the new one. Unavailability does not authorise automatic
failover. Exceptional transfer must address possible continued offline execution.

## 11. Events, delivery and disconnection

Nodes require outbound backend access only. Polling with reconciliation is the
correctness baseline. Streams/webhooks may reduce latency but cannot be the only
record of work. SSH remains administrative, not required collaboration.

Events carry stable identity, entity revision, scope, causation/correlation and an
opaque cursor. Native consumption needs documented retention and a snapshot/
reconciliation path for expired cursors. Current state is not complete history.

Nodes maintain durable incoming deduplication journals, outgoing mutation queues
and consumption checkpoints. Applying an event and recording its local effect/
checkpoint are atomic. Delivery is at least once. Exactly-once guarantees do not
extend to native prompts or external APIs.

| Disconnected operation | Required behaviour |
| --- | --- |
| Admitted execution | Continue and retain evidence/results locally |
| Installed automation | Continue within installed scope and offline policy |
| Remote request/question | Wait durably for publication or consumption |
| Task writes | Queue intent and check conflicts before applying |
| Fresh global query/dependency | Report stale/unavailable and defer dependent work |
| Remote answer/cancellation | Remain pending until recipient observes it |

Cached state shows fetch time. Jobs needing current global evidence wait. Offline
scope cannot expand, and authentication failure is not an authority bypass.

Persist native delivery intent before sending. Lost responses reconcile the same
request. Absence does not prove a request cannot commit. Offline nodes are unknown,
not stopped, and their work is not automatically reissued. Outbox capacity failure
stops new work that cannot be recorded durably without discarding existing evidence.

## 12. User and agent interfaces

Preserve existing tools, CLI and Herdr entry points where semantics still fit.
Harnesses use local Relay APIs, never backend credentials directly. Document exact
new command names and HTTP schemas separately as versioned contracts.

Required interface capabilities:

- Paginated tasks with explicit completeness/freshness.
- Cross-node discovery with stale availability visible.
- Scoped execution requests and admission/progress/result inspection.
- Recipient questions, forwarding, explicit answers and human inboxes.
- Human decisions without copying UUIDs.
- Exact candidate review through authorised human/agent paths.
- Local/remote schedules with requested/applied state.
- Pending publications, conflicts, recovery and connection health.

Question delivery respects local admission instead of interrupting busy human chats.
Native synchronous question tools remain appropriate when the human is present and
can decide within that turn. Relay questions handle asynchronous waiting/routing.

## 13. OpenCode v2 target and migration

OpenCode v2 is a required 0.2.0 integration, not a later optional port. The
[OpenCode v2 migration assessment](opencode-v2-migration-assessment.md) supplies
the research baseline and detailed compatibility inventory. Its observed versions
are dated evidence, not claims about the current latest release. This specification
governs scope where the earlier assessment proposes mandatory dual-version support.

### 13.1 Version and package contract

- Pin and record a tested OpenCode v2 CLI/plugin/client combination before building
  the integration. Recheck the assessment's `2.0.27` contract against that baseline.
- Use the supported `@opencode/plugin` and `@opencode/client` interfaces. Pin schema
  or protocol packages where imported directly.
- Ship a loadable plugin package/directory with separate server and TUI entrypoints.
  Do not rely on translation of `@opencode-ai/plugin` v1 hooks.
- Detect the native major/API version explicitly. Refuse unsupported combinations
  rather than probing incompatible write paths.
- Keep any v1 adapter isolated for migration and rollback. Maintaining full v1/v2
  feature parity indefinitely is not a release requirement. Hermes remains supported.

### 13.2 Server plugin and pane-local TUI

OpenCode v2's shared service can host multiple clients and sessions. A server plugin
is location-scoped, not owned by the pane that first launched the service.

The server plugin registers `relay_*` tools through the v2 tool interface, uses
strict JSON/Standard Schema inputs and structured results, and handles session
events and local Relay calls. Preserve applicable existing tool contracts and
document explicit replacements. Cleanup must release timers, streams and RPC once.

The TUI plugin supplies pane-local selected-session identity, notifications and
human confirmations. Typed server/TUI RPC must correlate the client, session,
interaction/action and current source message. Never derive pane identity from
the shared server's `HERDR_PANE_ID` or directory alone. Pane switching, reconnect
and reload invalidate stale confirmation contexts instead of transferring authority.

Headless execution uses native service evidence. It must not depend on TUI presence
or Herdr pane lifecycle reports. A headless agent cannot supply human confirmation.

### 13.3 Human answer and mutation authority

V1 `context.ask(...)` is not a v2 confirmation contract. Implement a supported
pane-local confirmation/form or documented v2 permission primitive that preserves:

- Exact session, pane/client and current human-source message.
- Exact proposed action, task, question/answer or candidate and revision.
- Explicit human decision and durable source/provenance evidence.
- Rejection of worker prompts, notifications and synthetic continuations as authority.
- Durable mutation intent and safe reconciliation of uncertain outcomes.

An agent calling a tool is not proof of human approval. One TUI client must never
consume another client's confirmation or receive its private notification. Apply
these rules to task writes, delegation, scheduling, question answers and review.

### 13.4 Native delivery and managed runtimes

Implement a versioned native adapter behind one Relay-facing contract for exact
location/session identity, immutable snapshots, activity, prompt admission,
message-correlated terminal observation, owned interruption and restart recovery.
Do not spread v2 endpoint branches through business logic.

The assessment maps v2 health/session/prompt/interrupt operations to `/api/...`
and documents new envelopes and outcomes. Validate these against the pinned client
and real runtime. Idle or a successful HTTP response is not terminal proof. Retain
stable prompt correlation, prior-input evidence, foreign-input fencing and
no-blind-replay handling after a lost send response.

Replace the v1 `serve --pure` launch contract with explicit private v2 configuration
and location/provider/plugin/permission policy. Managed runtimes must prove
loopback-only access, private authentication, dedicated process identity, exact
session binding, interruption and terminal settlement. Shared background services
must not accidentally be adopted as dedicated owned processes.

### 13.5 Cutover and rollback

Implement and test v2 under an isolated binary/configuration before upgrading the
primary installation. Preserve v1 binary/configuration/auth/plugin state because
both majors can use the same configuration locations. Do not overwrite rollback
configuration with v2-only syntax.

Inventory installed plugins and providers. Port or deliberately disable incompatible
plugins, remove obsolete Envoy from active discovery, and verify model/tool/media
and context-limit behaviour. Install the matching current Herdr v2 server/TUI
integration and verify its reported version. Historical `v13` is a baseline, not a
permanent version requirement. Skills and instruction files need compatibility
verification rather than an assumed rewrite.

Before primary cutover, pause runtime-producing schedules, settle or explicitly
resolve active work, verify exact-pane tools/notifications and run interactive and
managed v2 smokes. Resume automation only after those gates pass. Rehearse rollback
without replaying v2 executions or discarding their backend/local receipts.

## 14. Migration from 0.1.x

Current code embeds Paperclip identities, URL-shaped operations and backend
interactions across modules. Replacing only `paperclipClient()` is insufficient.

The initial deployment is clean. Build and validate it alongside the existing
installation using separate state and configuration, without importing Paperclip
records or redirecting existing work. Preserve the identity/provider boundaries
needed for later import. The migration requirements below apply when that later
milestone is undertaken, not as gates for starting the native backend.

Migration must:

1. Introduce opaque IDs, provider mappings and node identities without rewriting
   old receipts to appear native.
2. Version schemas, operations and protocols. Preserve the pinned-backend guard
   until explicit migration verifies the new scope.
3. Export tasks, comments, relations, references, pending questions/reviews and
   relevant execution provenance with an inventory and completeness report.
4. Validate imported identity/graph relationships and human/agent mappings.
5. Fence old heartbeat/routine admission before native admission/clocks drive the
   same work. Reconcile admitted and uncertain operations.
6. Finish legacy runs through their old path or explicitly adopt verified state.
   Never redeliver them as fresh requests.
7. Preserve decisions, waits, schedule ownership and authority. Unsupported
   mappings block cutover instead of dropping obligations.
8. Record cutover and rollback limits. Restoring an old database after native work
   executed is not a safe replay strategy.

The Paperclip adapter remains transitional compatibility ingress, not a native run
driver. Package upgrades do not implicitly switch providers, restart agents or
activate imported schedules.

## 15. Delivery sequence

| Stage | Deliverable and exit condition |
| --- | --- |
| 1. Contracts/identity | Tasks/Collaboration models, ownership, capabilities, migration format and pinned OpenCode v2 baseline |
| 2. OpenCode v2 spike | Read-only server tool, pane-local notification, typed RPC, exact managed prompt/settlement and two-client isolation |
| 3. Native backend | Transactional records/events, credentials and conditional/idempotent operations through a real service |
| 4. Standalone v2 node | Complete v2 tools/native runtime port, dispatch, questions, review and continuation without Paperclip heartbeats |
| 5. Two-node collaboration | Directory, remote execution, initiating-agent questions and human escalation |
| 6. Offline automation | Local schedules/outboxes, reconnect reconciliation and remote change acknowledgements |
| 7. Compatibility/cutover | Paperclip provider, clean native deployment, primary OpenCode v2 cutover and rehearsed rollback |
| 8. GitHub provider | Declare whole-backend/task-only scope and verify advertised capabilities |

Paperclip data import is a later milestone. Its migration gates in section 14
apply before importing existing work, rather than blocking the clean deployment.

Extract existing delivery, waiting, candidate and lifecycle invariants while
replacing provider dependencies. Do not reproduce Paperclip's company/heartbeat
model under different names.

## 16. Acceptance and verification

Version 0.2.0 requires evidence for:

1. **Standalone:** Paperclip is unavailable. Native creation, execution, questions,
   results, review and completion succeed.
2. **Two real machines:** Interactive-to-headless delegation uses backend access
   only, with no direct Relay-to-Relay connection.
3. **Agent answer:** A question reaches its initiating agent, receives an authorised
   answer and causes one eligible continuation.
4. **Human escalation:** The same question reaches the human and a chat answer with
   provenance resumes the waiting worker.
5. **Origin unavailable:** Another authorised chat can answer after the originating
   chat closes, without losing question identity.
6. **Conflicting answers:** One answer commits, competing answers conflict and
   identical retries reuse its receipt.
7. **Replay/restart:** Node/backend restart and event replay produce no extra native
   execution, answer, review decision or continuation.
8. **Offline job:** Installed automation executes locally through disconnection and
   reconciles occurrences/results without duplicate work.
9. **Offline pause:** Pause remains requested until acknowledgement and does not
   claim that prior execution stopped.
10. **Changed scope:** Cancellation, replacement bindings, stale revisions and
    withdrawn authority cannot be bypassed by delayed events.
11. **Lifecycle:** Review/retirement preserve process, worktree and settlement guards.
12. **Clean deployment:** Native state starts empty and remains separate from the
    existing Paperclip installation. Existing tasks, schedules and pending
    interactions are neither imported nor activated implicitly. Before a later
    import, verify an isolated graph/interaction migration and fence old execution.
13. **Providers:** Native/Paperclip pass meaningful shared contract tests. GitHub
    passes its advertised contracts and a workflow with Paperclip absent. Task-only
    support explicitly records its native Collaboration dependency.
14. **OpenCode v2 plugins:** The package loads every applicable Relay tool with strict
    schemas/structured results. Reload/disable cleanup leaves no duplicate polling,
    notifications or RPC handlers.
15. **Shared v2 service:** Two TUI clients on different sessions cannot exchange
    authority or notifications. Pane switch, client exit/reconnect and service
    reload invalidate stale confirmations while retaining durable questions.
16. **V2 native execution:** Exact location/session creation, prompt correlation,
    lost-response reconciliation, foreign-input detection, owned interruption and
    Relay restart recovery pass against a real pinned runtime.
17. **V2 workflows/cutover:** Task mutations, delegation, questions, accept/reject,
    folder/exact schedules and managed headless execution pass on v2. Smokes record
    actual executable/package versions. Configuration, Herdr integration and plugin
    inventory are verified and rollback preserves completed work.

Cover busy targets, missed events, expired cursors, uncertain writes and cancelled
dependencies. Fixtures support failure injection but do not replace real-harness
and physical second-machine evidence. Implementation status records verified
behaviour separately from this target contract.

V1 fixtures and historical evidence do not certify v2. The release matrix must
include real OpenCode v2 interactive and managed execution plus Hermes regression
coverage. Report baseline failures explicitly rather than claiming unrun tests pass.

## 17. Decisions to close during implementation

- Backend schemas, credential enrolment and protocol versions.
- Event retention, snapshot reconciliation and bounded outbox policy.
- Precise cron/DST semantics and default deferral/expiry policies.
- Conversation adoption and schedule-transfer recovery workflows.
- Artifact transport/storage beyond Git commits and URLs.
- GitHub whole-backend versus task-only scope and status/priority mapping.
- Pinned OpenCode v2 package set, supported confirmation primitive and exact
  server/TUI RPC schema, validated by the initial v2 spike.

These refine the contract. They do not reopen native-first delivery, equal nodes,
backend-mediated collaboration or first-class interactions.
