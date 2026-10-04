# Coordination product evaluation baseline, version 1

Date: 2026-10-03

## Deciding principle

> The requirement is lightweight interaction backed by durable state. Structure
> should appear when work needs it, rather than being something you must configure
> before asking an agent for help.

Evaluate Paperclip and OpenRig against the same behaviours. Organisational language
is not itself a failure. Distinguish a namespace that an integration can hide from
mandatory roles, reporting relationships or topology that constrain collaboration.

The four previously proposed Paperclip integration proofs are parked. This exercise
first establishes workflow fit. It does not select herdr versus tmux ownership.

## Evidence and classification

For each case record:

- **Native:** public product operations implement the behaviour directly.
- **Configuration:** supported settings provide it, without maintaining new code.
- **Extension:** a supported public interface allows a bounded integration.
- **Core change:** needs changes to product internals or contradictory invariants.
- **Unestablished:** evidence is insufficient. Do not interpret this as unsupported.

Keep capability classification separate from evidence:

- **Live API:** actual isolated service and database, deterministic callers.
- **Live runtime:** actual terminal/runtime lifecycle. A stub proves mechanics only.
- **Upstream test:** named tests executed against the pinned source.
- **Source:** inspected implementation or documentation, not executed behaviour.
- **Not exercised:** explicitly report the missing coverage.

Do not claim agent reasoning, production inbox access, Azure provisioning or native
OpenCode/Hermes delivery from synthetic fixtures. Use source IDs and fake subnet
records, and a real disposable Git repository for filesystem finalisation.

Record release, commit, prerequisites, all required configuration, API requests,
observed outcomes and recovery results. Success must be established by persisted
state, not merely an exit code or a model's completion claim.

## Participants

- Human: Quintin, owner/requester/reviewer where appropriate.
- Daily driver: persistent assistant, no organisation role required.
- Inbox monitor: service-scoped helper, operational window and saved source cursor.
- Project agent: existing independent participant with repository context.
- Demo agent: independent participant requesting infrastructure.
- Landing-zone agent: independent service provider with subnet-vending capability.
- Graph worker: disposable agent assigned an isolated worktree.

Names are labels. Identity must survive runtime changes. Capabilities and context
are useful metadata, not a compulsory employment hierarchy.

## Scenario 0: minimum structure and discovery

**S0.1:** Create/register daily driver and project agent, with no manager, job title,
project plan or assigned task. Record unavoidable namespaces and role defaults.

**S0.2:** Discover the other participant, communicate directly and create a bounded
request. No permanent reporting relationship should be necessary.

**S0.3:** Track human-owned work and an unassigned backlog item. A conversation or
notification must not automatically require a task.

**S0.4:** Existing agents retain conversations and settings. Record whether product
registration alone establishes identity or requires adoption/relaunch. Native
harness verification can remain an explicit later integration test.

## Scenario 1: daily driver and monitoring

The human asks the daily driver to monitor inbox and Teams through the day. The
monitor sends relevant events. The daily driver creates human/agent work or routes
project requests, then presents results to the human.

**S1.1 Standing service:** Represent a monitoring brief with an operating window,
notification destination and persistent checkpoint. It does not need a final
deliverable after each check. Execution may be scheduled rather than continuous.

**S1.2 Event versus task:** Feed three synthetic events: irrelevant, actionable for
the human, actionable for a project. Preserve source references. Only the latter
two create obligations. Classification is deterministic in this evaluation.

**S1.3 Duplicate event:** Replay an identical source event and retry a timed-out
creation using the same request identity. No duplicate task or notification.
Reusing an identity with different content must either conflict or have documented
semantics that the integration accounts for.

**S1.4 Mixed work:** Daily driver has an executing task, a waiting service request
and incoming monitor information. Multiple unresolved obligations must coexist.
Serial execution must not mean serialising the entire day's obligations.

**S1.5 Human participation:** A human owns a task with the daily driver helping.
Track a human decision without inventing a human-shaped agent. One accountable
owner plus collaborators or child tasks is acceptable.

**S1.6 Delivery and outage:** Persist an event while the recipient is unavailable.
Restart the service, read the same event, and distinguish storage from receipt.
Source checkpoint recovery must not restart monitoring from scratch.

**S1.7 End of service:** Stop or pause monitoring at the window boundary without
closing unrelated project agents or declaring their work complete.

## Scenario 2: subnet request between independent agents

The demo agent needs a subnet from the landing-zone agent. It requests the resource,
answers a clarification and receives the subnet details. Neither becomes the
other's permanent manager, and request authority does not confer lifecycle control.

**S2.1 Peer request:** Create an addressed task/request between unrelated agents.
Include environment and network requirements, stable request key and response target.

**S2.2 Clarification:** Provider asks for missing details. The response remains
available while the request is waiting and does not queue behind that request.

**S2.3 Dependency:** The deployment step waits on the subnet. Unrelated demo work
can proceed. Parentage alone must not impose a dependency.

**S2.4 Completion:** Provider returns a structured fake subnet resource ID and
configuration. The requester validates it, records acceptance and continues.
The provider remains available for other requests.

**S2.5 Lost response/retry:** Persist the provisioned fake resource, lose the first
client response, and retry the same request. There is one resource and one logical
obligation. Distinguish product task deduplication from provider-side idempotency.

**S2.6 Decline/cancellation:** Provider can decline with a reason. Cancelling after
dispatch must not imply the resource was never created or execution has stopped.
Late results remain inspectable.

**S2.7 Machine boundary:** Repeat the request with a remote participant if the
public product deployment model supports it. Otherwise document the required
topology/extension. Do not equate two local agents with a cross-machine test.

## Scenario 3: graph update and worktree worker

The daily driver provisions a worker in an isolated worktree. The worker changes a
graph file and submits the exact candidate. The daily driver checks it, requests
corrections if needed, commits the reviewed changes and accepts the handback.
Acceptance retires the worker. Eligible worktree cleanup follows separately.

**S3.1 Provision:** Record task, worker identity, assignment, worktree, branch and
lifecycle controller. Repeated launch intent must not create another worker.

**S3.2 Submit:** Publish evidence identifying uncommitted changes. Submission does
not imply acceptance, commit, termination or worktree removal.

**S3.3 Rework/staleness:** Request changes and submit a second candidate. Acceptance
of the first candidate must not approve or retire the second attempt.

**S3.4 Finalise:** Verify candidate bytes, execute checks and commit in the isolated
worktree under the scenario's explicit human instruction. Record commit evidence.

**S3.5 Retire:** Accept the exact current result, stop its runtime and clean up only
owned eligible resources. Persistent participants remain live.

**S3.6 Recovery:** Restart between acceptance and retirement. Repeat finalisation
after a simulated lost reply. No duplicate commit, duplicate worker or lost result.

**S3.7 Cleanup failure:** Leave a dirty/untracked file. Preserve it and report cleanup
blocked, independently of the accepted task outcome. Retry after resolving the file.

## Cross-cutting requirements

- Identity, runtime, conversation and placement remain distinct.
- Sending work does not acquire lifecycle control over an existing recipient.
- Acknowledgement, result submission, acceptance and retirement are separate facts.
- Work can start with an ad hoc request, without designing a team or workflow graph.
- No fabricated guarantees from screen rendering, idle observations or supplied IDs.
- OpenCode and Hermes support must be assessed separately from stub-runtime success.
- No two authoritative task stores. Any integration state should cover missing
  execution/receipt behaviour rather than competing task truth.

## Execution scope

First run the public API/data-model cases against both pinned released products in
isolated environments. Exercise native stub/process mechanisms where available.
Use targeted upstream tests for failure boundaries that lack a public fault-injection
interface. Record source-only mappings and missing live coverage explicitly.

The outcome is a workflow-fit report and reproducible evidence, not a production
installation or a claim that a herdr/OpenCode/Hermes integration has been completed.
