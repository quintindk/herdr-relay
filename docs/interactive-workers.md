# Interactive Workers

Relay implements `relay_worker_prepare` with `create` and `adopt` modes, plus
read-only `relay_workers` inspection, for interactive OpenCode workers in Herdr.
Preparation is separate from task assignment. Herdr owns native launch and
placement. This is not the dedicated managed-runtime lifecycle.

The repository implementation is prepared for explicitly configured use, not
live-certified for this workflow. Fixture checks do not certify the installed
plugin, running service, repository permissions or a live Herdr launch. No new
live Herdr worker launch is part of this increment's verification.

## Repository Authority

Strict mode is the default. The operator's service Herdr configuration must contain
exact absolute pairs:

```json
{
  "workerRepositories": [
    {
      "repository": "/absolute/path/project",
      "worktreeRoot": "/absolute/path/worker-checkouts"
    }
  ]
}
```

This is a configuration fragment, not an instruction to replace or edit live
configuration. The existing socket, company, machine and Herdr session scope
still applies. `worktreeRoot` must already exist as a directory.

- The requested `repository` must exactly match one entry. Missing, empty,
  unknown or duplicate matching entries refuse preparation.
- Git validation resolves real paths and requires the configured repository to
  identify its exact worktree root. The origin chat must belong to that same
  repository, verified by its common Git directory. An allowlisted second
  repository does not grant this chat cross-repository provisioning authority.
- Worker directories must be strictly beneath the resolved `worktreeRoot` and
  registered linked worktrees of that repository. Subdirectories, other
  repositories and escaping symlinks are not adoption targets.
- `workerRepositories` does not add paths to `bridgeDirectories`. The origin
  needs an armed, verified bridge. Worker enrolment follows its exact preparation
  grant, not a broad folder permission.
- Preparation requires current native human text and tool permission. A Relay
  invocation or notification cannot authorise it. Unsettled Relay work in the
  calling conversation refuses preparation, including recursive provisioning.
- `trustRepository` defaults to false. Request true only with explicit authority.
  It applies scoped Git trust for the operation, not a global Git configuration
  change or permission to widen the repository allowlist.

### Local User Mode

A single-user installation can deliberately use the operating-system account as
the filesystem authority instead of maintaining repository allowlists:

```json
{
  "workerProvisioning": {
    "mode": "localUser",
    "maxActiveWorkers": 10
  }
}
```

`maxActiveWorkers` defaults to 10 and accepts 1 to 100. In this mode:

- An armed human chat may prepare a linked worktree from any accessible repository
  or create a plain workspace at an exact absolute directory.
- Cross-repository preparation is allowed. The origin does not need to share the
  requested repository's Git common directory.
- Create always requires `directory`. Its canonical parent must already exist and
  the destination must not exist. Relay never adopts existing content implicitly.
- Omit `repository` for a plain workspace. `branch`, `base` and `trustRepository`
  are then invalid. Relay creates the directory with mode `0700`, creates a Herdr
  workspace there and launches the fixed OpenCode standby agent.
- Supply `repository` for a linked worktree. Relay still pins the base commit,
  requires a new branch and validates the exact Git worktree identity.
- Adopt requires exact `directory` and `observedId`. Repository-less adoption
  validates the directory identity and preserves its contents without launching.
- Git trust remains false unless explicitly requested. Local-user mode does not
  edit global or repository Git configuration.

The armed bridge, verified human source, idempotency, exact native placement,
worker limit and review boundaries remain enforced. This mode deliberately trusts
the service's OS account, so it is unsuitable for a shared or hostile host.

## Prepare Before Dispatch

Prepare all required workers before dispatching the parent task. An active parent
may delegate to existing prepared peers when its task explicitly permits fan-out,
but cannot provision further workers through the human-chat route.

1. Inspect `relay_workers`. It returns this exact chat's `workers` receipts and
   verified `candidates` for adoption in its authorised repository. It does not
   launch, configure, arm or advance a preparation.
2. State the repository, mode, branch/base or exact adoption target, and any trust
   request visibly before calling `relay_worker_prepare`. The generic permission
   popup does not display those details.
3. Keep a stable key for the exact preparation and current human source message.
   Read the returned receipt, then use bounded `relay_workers` checks rather than
   repeating preparation to drive it forward. Background reconciliation advances
   the operation independently.
4. Wait for `armed` with no blocker, then refresh `relay_agents` and use the exact
   ready `bindingId` for delegation. A receipt or an existing pane is not readiness.
   No automatic worker-readiness toast or model wake is implemented currently.
5. Delegate a self-contained task with explicit scope, checks and review policy.
   Preparation alone never assigns work.

### Create

Example `relay_worker_prepare` arguments, after operator configuration and human
authorisation:

```json
{
  "key": "prepare-parser-worker-1",
  "mode": "create",
  "repository": "/absolute/path/project",
  "directory": "/absolute/path/project-workers/parser",
  "branch": "relay/parser-worker",
  "base": "HEAD",
  "label": "Parser worker"
}
```

In local-user mode `directory` is required. `branch`, `base` and `label` are
optional. Omitted base means `HEAD`. Relay resolves
the base once to a full commit SHA and persists it. Background `worktree.create`
uses that pinned SHA even if the ref later moves. The branch and path must be new.
Strict mode generates the directory beneath `worktreeRoot` and does not accept a
create directory. Both modes generate a branch if omitted. Never supply
`observedId` in create mode.

For a plain local-user workspace, omit repository and Git fields:

```json
{
  "key": "prepare-lab-1",
  "mode": "create",
  "directory": "/home/user/play/lab-1",
  "label": "Lab 1"
}
```

Preparation returns a durable `intent`, not a launched worker. The background
driver calls raw Herdr protocol-22 `worktree.create` or `workspace.create`, then
`agent.start`. Launch
uses the fixed interactive OpenCode `build` standby prompt, not caller-supplied
commands or executable arguments. The standby turn is not a work assignment.

Raw `agent.start` acknowledges asynchronous launch and may have no native session
yet. Relay persists the receipt as `awaiting_native` and later inspects
`session.snapshot` for the exact pane, terminal, workspace, tab, directory, name
and native session. Even a start receipt containing a session is not readiness.

### Adopt

Use the exact `directory` and `observedId` returned by `relay_workers`, not guessed
IDs or an arbitrary working directory:

```json
{
  "key": "adopt-parser-worker-1",
  "mode": "adopt",
  "repository": "/absolute/path/project",
  "directory": "/absolute/path/worker-checkouts/existing-worker",
  "observedId": "EXACT_ID_FROM_RELAY_WORKERS"
}
```

Adoption requires those two fields and forbids `base`. An optional `branch` pins
the expected branch. It preserves the existing worktree, dirty files and native
conversation, and does not launch an agent. A candidate's `eligible` flag means
it is not reserved by another preparation, not that it is idle or ready for work.
Exact observation and plugin readiness must still pass before arming.

Existing access workers and other peers with ongoing jobs must not be disturbed.
Do not restart, stop, rebind, clean, replace or force delivery into them. If the
required plugin is unavailable, report the blocker rather than interrupting work.

## States And Retries

`relay_workers` receipts include `state`, `step`, `blocker`, `directory`, `branch`,
`baseCommit`, `observedId` and `bindingId`. Some identifiers remain null until
verified. Read the state and blocker together.

| State | Meaning |
| --- | --- |
| `intent` | Create request persisted. Background creation has not completed. |
| `directory_created` | Plain workspace directory created. Herdr workspace creation remains pending. |
| `created` | Worktree and shell receipt verified. Agent start remains pending. |
| `awaiting_native` | Start receipt persisted. Exact native session observation is pending. |
| `prepared` | Exact target selected. Bridge enrolment remains pending. Adoption starts here. |
| `configured` | Bridge configured, but plugin readiness or arming remains pending. |
| `armed` | Grant armed. A current blocker can still prevent readiness. Refresh `relay_agents`. |
| `uncertain` | A mutating RPC was attempted without a verified outcome. Manual recovery required. |
| `blocked` | Grant invalidated or revoked. Disarm may still await unsettled work. |

Transient blockers include `native_session_unavailable`,
`native_snapshot_unavailable`, `plugin_unavailable`, `native_busy` and
`enrolment_blocked`. Observation may resume when the exact identities return.
Replacement identities or revoked scope are not transient readiness problems.
Revocation blocks fresh work and waits for unsettled work before disarming.

- An identical preparation retry requires the same key, immutable fields, origin
  conversation and source message. A changed request or source conflicts. Do not
  retry from a later human message as though it were the original request.
- Persisted uncertainty precedes directory creation and each mutating RPC. An
  unknown outcome never authorises repeating `workspace.create`, `worktree.create`
  or `agent.start`, including after a
  restart. Do not choose a new key, branch or path to evade that fence.
- Read-only snapshot failures can be retried. They do not require another launch.
  A verified `created` stage can resume its not-yet-attempted start, which is not
  replay of an uncertain start.
- Task creation has its own idempotency contract. Reuse the exact key and payload
  for the same request, inspect `relay_delegations` after a lost response, and do
  not duplicate the task under a new key. Human-review retries must also retain
  the exact source message, decision and candidate.

There is no automatic merge, commit, push, branch/worktree deletion, pane closure
or worker termination in this preparation workflow. Neither task acceptance nor
adoption grants those rights. Do not apply managed-runtime cleanup assumptions to
interactive peers.

## Parent And Child Tasks

From a human chat, `relay_delegate` accepts optional `parentTaskId`. Relay maps it
to the Paperclip payload's `parentId`. The parent must have a recorded origin in
this exact conversation and a current nonterminal status in the same company.
This is not a way for an active worker to use the operator route.

An authorised active worker instead uses its supplied CLI and private worker
context. Read and acknowledge the current run first, discover an existing prepared
peer, then create each child with `task create RUN --key KEY --file child.json`.
This is the worker-scoped `task.create` operation. Example file contents:

```json
{
  "title": "Check parser edge cases",
  "description": "Read-only review. Report defects and checks. No commits, provisioning or external changes.",
  "assigneeAgentId": "EXACT_DISCOVERED_PEER_AGENT_ID",
  "parentId": "CURRENT_TASK_ID",
  "status": "todo",
  "relayReviewPolicy": "human"
}
```

After collecting the child creation receipts, write a wait file:

```json
{"taskIds":["CHILD_ID_A","CHILD_ID_B"]}
```

Use `work wait-children RUN --file children.json`. The set accepts 1 to 64 unique
IDs without surrounding whitespace. All must identify direct children of the
current task in the same company, assigned to another agent. Relay canonicalises
the set and preserves existing blockers. One run cannot switch to a different
wait set on retry. `work wait-child RUN --task CHILD_ID` remains the single-child
form.

If a dependency wait is recorded, finish the native turn without submitting or
polling. Paperclip owns continuation. On continuation inspect every child with
`task inspect RUN --task CHILD_ID`. If the response is `needs_inspection`, no new
wait is needed: retain the turn and inspect the results. Cancelled children are
blocked work, never successful completion. A dependency mutation with an uncertain
receipt requires inspection of the parent and its original blockers, not a new set.

## Origin And Review

Verified worker-created children inherit the parent's originating chat for result
status, completion/review notifications and pending human-review access. Relay
derives lineage from durable recorded creation operations, matching company,
parent, assignment and parent-run evidence. Backend parent links alone, fabricated
origins, uncertain receipts, cycles or conflicting records do not establish it.
A replacement chat in the same folder does not inherit that return path.

This inheritance is routing and review scope, not human authorisation. Child
output and notifications cannot authorise preparation, delegation or acceptance.
Toasts are UI-only and do not start model turns. Use `relay_delegations` and
`relay_reviews` in the exact origin chat to inspect results.

Human review is the default, including when a child's policy is omitted. `none`
requires intentional authorisation. `agent_decides` permits a worker to choose
human/no-review with a recorded reason, not to approve its own candidate.

Experimental [coordinator review](coordinator-review.md) is implemented and
offline-tested. Only an explicit human `relay_coordinator_grant` from the recorded
root parent's exact origin chat authorises its assigned parent reviewer. The
parent's final review remains human. Never silently grant authority. Each direct
child must opt in at creation with `relayReviewPolicy: "coordinator"` and `grantId`
on `relay_delegate`, or `relayReviewGrantId` on worker `task create`. Policy and grant
reference are immutable. Existing child policies are unchanged. Omission stays human.

The parent reads `task.coordinatorReviewGrants` through `work read RUN` and obtains
child submission/candidate/interaction IDs through `task inspect RUN --task ID`.
Only its exact active acknowledged parent run may decide, with a reason and verified
backend resolver proof. Inspection is not human approval. `relay_review` remains
the explicit human override. `relay_coordinator_revoke` removes future agent
authority, retaining confirmed decisions. Revocation before disposition can recover
to `human_only` under the original exact scope. Legacy `anyone` cards still require
explicit human review and recorded human proof, not agent acceptance.

Candidate-ready parent comments use the backend's standard wake path, unlike
UI-only origin toasts. A `recorded` comment does not prove turn admission:
`awaiting_admission` / `continuation_unconfirmed` remains pending, without automatic
repost. Rejection requires explicit follow-up. No automatic rework wake is
implemented. Review never grants commit, merge or cleanup authority.

## Verification Boundary

Coordinator review has offline fixture coverage only. Live tests are deferred at
the user's request. Neither the final workflow nor complete autonomous recovery is
claimed verified. The historical preparation checks below do not certify this new
feature, and this documentation update makes no global installation changes.

The fixture workflow covers preparation, raw asynchronous launch receipts,
readiness, retries, worker-scoped child waits and inherited origin/review scope.
Worker tests use temporary Git repositories and injected Herdr RPC responses.
Service/plugin tests use fixture backends and native SDK/inventory fixtures.
These are not new live Herdr launches or certification of ongoing access workers.

On 2026-10-07, all 548 automated tests, syntax checks and diff whitespace checks
passed before the service was restarted with the new workflow. The installed
global skill matched the repository copy. Service health and the existing seven
bridge enrolments were verified after restart, with no worker preparations or
unsettled Relay runs present before deployment.

A read-only invocation of the production discovery function against the live
Herdr inventory and a read-only Relay database found the four existing access
worktrees as verified adoption candidates. It checked their linked Git identity,
origin repository scope and native placement without creating a grant, launching
a process, enrolling a worker or changing project files. Candidate eligibility
does not establish idle readiness. A live create/adopt and subtask round trip
remains an explicit follow-up; no current access assignment was replayed.

Relevant checks, without running any live smoke scripts:

```bash
npm run check
node --test test/herdr-workers.test.mjs test/worker-service.test.mjs test/harness-subtasks.test.mjs test/dependencies.test.mjs test/task-origin.test.mjs test/harness-answers.test.mjs test/completion-notifications.test.mjs test/opencode-bridge-plugin.test.mjs
```

The implementation contract is in `src/herdr-workers.mjs`,
`src/opencode-bridge-plugin.mjs`, `src/harness-delegation.mjs`,
`src/operations.mjs`, `src/dependencies.mjs` and `src/task-origin.mjs`.
See the [chat skill](../skills/herdr-relay/SKILL.md),
[worker protocol](../skills/relay-work/SKILL.md) and
[OpenCode bridge](opencode-bridge.md) for the surrounding workflow.
