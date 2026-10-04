# Paperclip and OpenRig: scenario evaluation, version 1

Date: 2026-10-03

## Conclusion

Both products support useful ad hoc collaboration without permanent reporting
relationships. Rejecting them because of their organisational vocabulary would
discard working functionality for the wrong reason.

Paperclip is the stronger current candidate for our task backend: human ownership,
unassigned backlog, peer delegation, structured questions and review all worked
without a project, goal, manager or job title. Its significant constraint is that
agent execution writes require a Paperclip run, not just a durable agent identity.

OpenRig is the stronger current candidate for interactive agent coordination:
cross-rig requests, inbox deposits, multiple claimed obligations and persistent
stub terminals worked. Its queue requires a destination, its human registry
requires a connector binding, and exact-candidate acceptance required workflow
configuration in the path tested. Its selected-harness and tmux boundaries remain.

Neither was shown to provide our complete acceptance, commit and automatic
task-scoped retirement contract. Keep the requirements baseline independent of
both products. Do not introduce two authoritative task stores.

## Evaluation principle

> The requirement is lightweight interaction backed by durable state. Structure
> should appear when work needs it, rather than being something you must configure
> before asking an agent for help.

The [scenario baseline](evaluation-baseline-v1.md) is the requirements checklist.
This report distinguishes observed behaviour from proposed integration work.

## Versions and isolation

| Product | Release | Source commit |
| --- | --- | --- |
| Paperclip | `2026.1001.0` | `8f8a0ab7effbd6a0584107d8038736c134ee5047` |
| OpenRig | `0.6.4` | `6342862884a7146cbd0797e91399b3704025f161` |

- Installed published npm packages in separate Docker containers using Node
  `24.21.0`, Debian Bookworm and tmux `3.3a`.
- Pinned product versions and base-image digest in
  [`evaluation/Dockerfile`](../evaluation/Dockerfile). Transitive npm packages are
  resolved at build time, so this is not a complete dependency-lock reproduction.
- Paperclip used its actual embedded PostgreSQL and local-trusted API.
- OpenRig used its actual SQLite daemon, with kernel auto-boot disabled, and five
  native stub seats in tmux.
- No host agent configuration, model credentials, inbox, Teams, Azure or herdr
  sockets were mounted. Model calls were not part of the evaluation.
- Paperclip execution tests used its native `process` adapter to run deterministic
  Node scripts with real run-scoped credentials.
- Both products' databases survived restart. These were restart tests after
  completed writes, not exhaustive crash injection inside database transactions.

## Findings that change the earlier assessment

### 1. Paperclip does not require an actual management hierarchy

Creating an agent with only its name, adapter and execution settings succeeded.
The stored role defaults to `general`, while title and `reportsTo` remain null.
Five peer agents were created this way.

An authenticated daily-driver agent then discovered peers and created work for
the unrelated landing-zone and project agents. No parent task, goal or project
was required. A company namespace remains mandatory and could be supplied by a
Retinue integration without presenting a company-setup exercise to the user.

This narrows our concern from “corporate hierarchy is compulsory” to “does the
run-based execution contract fit existing interactive agents?”

### 2. OpenRig has an ad hoc entry point, with opinionated defaults

`rig create daily --runtime stub` worked without an authored YAML file. It created
a rig, a `main` pod and a `main.lead` seat using the bundled orchestrator blueprint.
Separate project, monitor, landing-zone and graph rigs were created the same way.

Cross-rig delegation worked without edges or reporting relationships. However,
the simple creation command still selects a lead/orchestrator identity. Whether
that default guidance can be replaced cleanly for ordinary context-bound agents
was not exercised.

### 3. A stable Paperclip agent key is not sufficient for all coordination writes

Agent-key discovery and task creation succeeded. Checkout without a run returned
`401 Agent run id required`. Agent comments and task updates without a valid run
returned `403` with run-attribution guidance.

The same workflow succeeded through actual process-adapter runs. Therefore this
is an execution-context requirement, not evidence that peer delegation is denied.
An integration for existing conversations must establish legitimate Paperclip run
context rather than silently proxying agent actions as the human operator.

### 4. Both products replay original content on idempotency-key reuse

Identical request retries returned the original record. Changing content while
reusing the same key also returned the original record rather than rejecting the
mismatch. The original content was preserved.

Our proposed stricter “same key, different parameters is an error” contract needs
payload comparison or hashing at the integration boundary. Product deduplication
alone does not establish that contract.

## Scenario 1: monitoring and mixed work

| Behaviour | Paperclip observation | OpenRig observation |
| --- | --- | --- |
| Human-owned task | Native, `assigneeUserId=local-board` accepted | Human queue item accepted after human/connector registration |
| Unassigned backlog | Native `backlog`, no assignee | Queue create refused without destination. Intake stream provides an alternative representation, not an equivalent unassigned task |
| Multiple obligations | Two tasks assigned to daily driver | Two queue items simultaneously claimed by daily seat |
| Project routing | Agent-key task creation to unrelated project agent succeeded | Monitor-created project queue item succeeded |
| Event without task | General event mailbox not established in this pass | Immutable stream event stored without queue item |
| Replay | Task and routine keys returned original records | Stream and queue IDs returned original records |
| Monitoring schedule | Routine plus SAST cron trigger accepted without project/goal | Periodic reminder accepted with YAML body and target seat |
| Stop schedule | Routine paused | Watchdog stopped |
| Retained pending information | Tasks retained across container restart | Inbox deposits retained across daemon restart |

Paperclip's manually triggered routine created an execution issue, and replay
returned the same routine-run and issue IDs. This tests trigger persistence and
deduplication. The monitor adapter was disabled, so it does not demonstrate
source polling, cursor advancement or classification.

OpenRig's human-add command refused a human without `--binding`. A placeholder
Slack binding allowed registration, then a task to `quintin@external` was stored.
Readiness correctly remained `not-ready` because there was no Slack token or
channel. This is human identity coupled to a delivery connector, not successful
external delivery. Supporting a local human participant without such a binding
needs further investigation or a change.

The deposited “offline event” fixture was named for the intended case but the
daily stub was still running when it was deposited. It proves durable unread
storage and subsequent restart retention, not delivery to a genuinely offline
recipient. The evidence label must not be read as proof of that stronger claim.

**Fit:** both provide building blocks. Neither has yet been shown to implement the
whole monitoring service contract, including cursor recovery, a one-day lifetime,
and selective notifications without unnecessary work creation.

Evidence: [Paperclip initial](evidence/paperclip-initial.json),
[Paperclip routines](evidence/paperclip-extra.json),
[OpenRig initial](evidence/openrig-initial.json),
[OpenRig follow-up](evidence/openrig-followup.json).

## Scenario 2: subnet service request

### Paperclip

Observed using independent agents:

1. Daily driver created a landing-zone task using its agent key.
2. Provider ran through the process adapter, checked out its task and created an
   agent-addressed question.
3. A requester run answered that exact interaction. Readback recorded `answered`,
   the response and the requesting agent/run identity.
4. Provider recorded a completed fake subnet result.
5. The task and result state survived container restart.

An explicit dependency was also created successfully. A later fixture regenerated
the subnet task without updating the earlier dependent's blocker ID. Its unchanged
blocked state is consequently **not a product failure** and does not prove
automatic continuation after the regenerated provider result. That specific
end-to-end dependency wake remains untested here.

### OpenRig

Observed using independent rigs:

1. Daily seat created work for the landing-zone seat.
2. Provider claimed the queue item.
3. Question and answer were deposited in separate inboxes while work remained
   claimed. These were correlated by fixture intent, not a typed question entity.
4. Provider recorded completion with a transition note containing the fake subnet
   ID. The result notification was a separate inbox deposit.
5. A second live subnet item blocked a deployment item. Closing that blocker moved
   deployment back to `pending` automatically.
6. Completion, transition history and inbox deposits survived daemon restart.

**Fit:** both support peer service requests without lifecycle transfer being part
of the request API. We did not test adversarial lifecycle authorisation. No Azure
resource was created, no provider-side provisioning retry was tested, and no
cross-machine run was performed.

Evidence: [Paperclip runs](evidence/paperclip-runs.json),
[answered interaction](evidence/paperclip-extra.json),
[OpenRig dependencies](evidence/openrig-deep.json).

## Scenario 3: graph review, commit and reaping

### Paperclip review

An optional per-issue review stage named the daily driver as reviewer. Actual
process-adapter runs produced the following durable comment history:

1. Graph worker submitted candidate A.
2. Daily driver requested corrections.
3. Worker submitted candidate B.
4. Daily driver accepted B.

The final issue was `done`, execution policy was `completed`, and the worker agent
was `idle`, not terminated.

At reassignment boundaries, the service cancelled the submitting process before
some mutation responses could be saved by the fixture. The committed issue and
comment history provided the evidence. This is relevant to our uncertain-response
handling: a terminated process is not proof that its final state update failed.

A separate candidate document test created revision A, opened a confirmation
bound to A, then wrote revision B. Attempting acceptance of A returned
`409 interaction_stale_target` and persisted the old confirmation as expired.
This proves revision-bound confirmation behaviour, not automatic binding of the
general review stage to a Git candidate.

### OpenRig review

An ordinary queue handoff transferred the candidate to a review item. For a
mechanically checked acceptance, a two-step workflow was configured with local
producer/reviewer aliases and explicit seat addresses.

- Candidate A against a declared candidate B gate returned
  `400 acceptance_payload_mismatch`.
- Candidate B with the declared verdict/evidence reference completed the workflow.
- The graph stub runtime remained running after acceptance and daemon restart.
- Explicit `rig remove` killed its one session. The unrelated project stub stayed
  running.

The evidence path was a declared reference, not verified graph content. This shows
the gate compares identities, not that it assesses the referenced work.

### Git finalisation fixture

The same separate coordinator script ran in both containers:

- Created a real Git repository and isolated worktree.
- Wrote candidate A and corrected candidate B.
- Compared file digests, checked the graph and committed B.
- Reconciled the existing commit instead of creating another after a simulated
  lost response.
- Ordinary worktree removal refused an untracked file and preserved it.
- After removing only that fixture file, cleanup succeeded and retained the branch.

These are **Git and evaluation-coordinator results**, not native Paperclip or
OpenRig finalisation results. The script was not atomically connected to product
acceptance and did not launch the product worker inside that worktree. Full S3
remains an integration gap, even though its component behaviours were exercised.

Evidence: [Paperclip review history](evidence/paperclip-extra.json),
[Paperclip stale acceptance](evidence/paperclip-staleness.json),
[OpenRig acceptance](evidence/openrig-followup.json),
[OpenRig explicit retirement](evidence/openrig-retire.json),
[Git fixture](evidence/paperclip-worktree.json).

## Coverage ledger

“Partial” identifies exactly which part was exercised. It does not count as an
end-to-end pass.

| Cases | Coverage |
| --- | --- |
| S0.1–S0.2 | Live creation and peer requests for both. OpenRig used stub runtimes, Paperclip process-backed identities |
| S0.3 | Live human and backlog probes for both, including refusals and required setup |
| S0.4 | Native existing OpenCode/Hermes adoption not exercised |
| S1.1 | Live schedule creation. No source connector or cursor-processing loop |
| S1.2 | Project task routing and OpenRig non-task stream tested. Three-event classification not executed as a complete monitor pipeline |
| S1.3 | Live duplicate task/event/routine replay and changed-content replay. No actual network response-drop proxy |
| S1.4 | Multiple obligations tested. Busy native conversation delivery not exercised |
| S1.5 | Human ownership tested. Shared-task collaboration and human decision continuation only partially covered by questions/review |
| S1.6 | Completed-write restart retention tested. Offline delivery and source cursor recovery not exercised |
| S1.7 | Explicit schedule stop/pause tested. Automatic window expiry and agent stop not linked |
| S2.1–S2.2 | Peer requests and clarification tested. OpenRig used inbox messages, Paperclip typed interaction with run identity |
| S2.3 | OpenRig dependency release tested. Paperclip dependency creation tested, continuation fixture incomplete |
| S2.4 | Fake results persisted. No independently validated Azure result |
| S2.5 | Product-level request replay and restart tested. Provider-side resource provisioning idempotency not exercised |
| S2.6 | OpenRig cancellation of claimed item tested. Decline, running-turn cancellation and late result cases incomplete |
| S2.7 | Cross-machine behaviour not exercised |
| S3.1 | Product worker identities and separate real worktrees tested. No transactional worker/worktree provisioning |
| S3.2 | Submission/review handoff tested, candidate bytes only in separate Git fixture |
| S3.3 | Paperclip rework and stale document confirmation, OpenRig declared candidate mismatch tested |
| S3.4 | Separate deterministic Git finalisation tested, not product-owned |
| S3.5 | Paperclip worker remains idle, OpenRig worker remains live then explicit removal succeeds. No automatic acceptance-triggered reap |
| S3.6 | Review/result persistence after restart and separate Git retry tested. Retirement operation crash recovery not implemented |
| S3.7 | Real Git cleanup refusal/retry tested, independent of product task state |

## Errors encountered and corrected

Evaluation code errors are retained in raw evidence where useful but are not
classified as missing product capabilities:

- Paperclip's pinned release required the legacy `payload.questions` form, unlike
  the newer documentation example using only `questionSet`. The corrected payload
  succeeded. Responses used `optionIds`, not `selectedOptionIds`.
- Initial Paperclip run invocation was skipped with heartbeat/wake settings
  disabled. Enabling the test run and disabling further automatic wakes after
  dispatch exercised valid run authentication without repeated scripted work.
- A first deterministic review fixture reused actions during automatic recovery
  and unnecessarily checked out the reviewer stage. Fresh tasks and correctly
  bounded scripted runs produced the successful review history reported above.
- OpenRig completion does not accept `evidenceRef` as an ordinary `done` update
  field. The corrected transition note persisted the result. Replaying that
  already-completed closure with state-write fields was refused, so not every
  mutation is idempotent merely because create is.
- OpenRig's human address is `quintin@external`, not the guessed
  `human:quintin` or `quintin@gateway`. Canonical-address creation succeeded.
- OpenRig typed acceptance takes `closureEvidence.acceptance` and
  `evidence_ref`, not a top-level `acceptance` object. Correct payloads yielded
  both the expected mismatch refusal and successful acceptance.

## Integration assessment

| Requirement | Paperclip | OpenRig |
| --- | --- | --- |
| Hide organisational vocabulary | Configuration/facade appears sufficient for tested peer workflows | Facade can hide rig addresses, but default lead guidance needs attention |
| Human tasks and unassigned backlog | Native | Human route requires connector config. Backlog needs stream-to-task mapping or another supported surface |
| Direct arbitrary peer requests | Native within company namespace | Native between registered rigs |
| Typed clarification | Native with legitimate run context | Inbox transport native, typed question lifecycle needs mapping/extension |
| Monitoring | Routine configuration native, source cursor/selection is integration work | Watchdog configuration native, source cursor/selection is integration work |
| Exact reviewed candidate | Revision-bound confirmation native, connect it to submission/finalisation | Candidate gate native inside workflow, needs ad hoc generation/mapping |
| Existing interactive OpenCode/Hermes | Adapter/execution bridge not proven | Upstream harness support absent in pinned release, core adapter work currently required |
| Automatic acceptance-to-retirement | Extension candidate, feasibility not proven | Coordinator operation available, automatic durable linkage not proven |
| Herdr ownership | Custom integration required | Existing terminal viewer, tmux owns sessions |

The evidence supports continuing with **Paperclip as the candidate work backend**
and **OpenRig as an execution/coordination reference or alternative**. This is a
provisional engineering judgement, not a selection. The remaining discriminant is
how much legitimate runtime integration each requires for existing OpenCode and
Hermes conversations, under the lightweight interaction requirement.

## Evidence and reproduction

Raw response files are under [`docs/evidence/`](evidence/). The collector performs
assertions over the persisted observations and records its result in
[`verification.json`](evidence/verification.json).

The scripts and commands are described in [the runbook](evaluation-runbook.md).
No upstream test suite was run in this pass. All reported execution evidence comes
from the isolated services, native stub/process adapters and the labelled Git
fixture. Native model-to-model delivery remains outside this pass.

Source references:

- [Paperclip pinned release](https://github.com/paperclipai/paperclip/tree/v2026.1001.0)
- [Paperclip process adapter](https://github.com/paperclipai/paperclip/blob/v2026.1001.0/server/src/adapters/process/execute.ts)
- [Paperclip agent API](https://github.com/paperclipai/paperclip/blob/v2026.1001.0/server/src/routes/agents.ts)
- [OpenRig pinned release](https://github.com/mvschwarz/openrig/tree/v0.6.4)
- [OpenRig queue API](https://github.com/mvschwarz/openrig/blob/v0.6.4/packages/daemon/src/routes/queue.ts)
- [OpenRig acceptance test reference](https://github.com/mvschwarz/openrig/blob/v0.6.4/packages/cli/test/workflow-acceptance-cli.test.ts)
