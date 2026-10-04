# Specification implementation and evidence

Updated: 2026-10-04. Contract: [specification v2](spec-v2.md).

**The supported local Linux workflows are implemented and extensively verified.
The entire specification is not closed.** Remaining limits are listed explicitly
below. This document distinguishes implemented behaviour from proposed extensions.

## First milestone acceptance criteria

| Criterion | Implementation and evidence |
| --- | --- |
| Separate logical agents without managers | Real Paperclip registration and integrated provisioning for both harnesses |
| Exact existing conversations | Native identity checks, stored/live Hermes identity, revisioned rebinding and managed same-conversation resume |
| Installed adapter dispatch and acknowledgement | Real Paperclip external adapter and combined native tests |
| Native CLI submission with correct attribution | Combined real Paperclip + OpenCode and Paperclip + Hermes tests |
| Preserve conversations after work runs | Both native tests and owned stop/resume tests |
| Reject stale binding and changed retries | Store, HTTP, process-restart and mutation tests |
| Bounded questions and continuation | Both real native harnesses ask, settle waiting and resume after a real backend answer |
| Verified cancellation | Dedicated owned OpenCode and Hermes interruption tests. Shared mode intentionally cannot guarantee exact interruption. |
| Restart without duplicate work | Native lost-response tests, adapter-process restart, real Paperclip host recovery, persisted terminal receipts and real systemd restart |
| Distinct task/delivery/runtime state | JSON CLI, operation inspection and herdr work/inbox pane |

## Wider workflow coverage

| Area | Verified behaviour |
| --- | --- |
| Discovery and participation | Company-scoped peers, labels/capabilities, shared skill, explicit run identity |
| Backend work | Create/list/assign/update tasks, human ownership, dependencies, peer question answers and accepted task completion |
| Monitoring | Bounded backend schedules, scoped window-expiry cancellation, atomic source checkpoints and receipt-only inbox events |
| Evidence | Worker progress, deliverables and checks, separately attributed reviewer checks |
| Candidate review | File-state SHA-256, exact revision-bound Paperclip confirmation, stale/self-review rejection and uncertain-decision reconciliation |
| Provisioning | Independent backend agent, optional owned worktree, dedicated native runtime, conversation, binding, adapter configuration and skill |
| Lifetimes | Persistent/service/task bindings, task reservation during review and controller transfer for orphan recovery |
| Runtime lifecycle | Owned launch, verified interruption, process-group shutdown and explicit same-conversation resume on Linux |
| Finalisation | Real Git commit with candidate verification and lost-receipt reconciliation |
| Retirement | Acceptance-triggered owned runtime stop and worktree cleanup, restart reconciliation, dirty/ignored cleanup refusal |
| Herdr | Live-verified interactive work/inbox pane and exact pane/terminal/conversation reconciliation |
| Installation | Owned Linux systemd user install/uninstall, generated-unit validation and real automatic restart test |

## End-to-end scenarios

- **Monitoring:** real Paperclip with deterministic source/worker fixtures. Three
  source events deduplicate, two actionable tasks are created, human ownership and
  independent project execution are preserved, and the schedule stops.
- **Subnet request:** real backend peer request, region clarification, an agent's
  answer to another task, synthetic subnet result and preserved provider. Combined
  native question/continuation paths pass with both OpenCode and Hermes.
- **Graph worktree:** real Paperclip/Git correction loop, stale acceptance rejection,
  exact candidate checks, commit before acceptance, dirty-cleanup recovery and
  backend task completion. A separate real-model graph edit also passes candidate
  verification, commit, acceptance, automatic runtime retirement and guarded cleanup.

See [scenario verification](scenario-verification.md) and `docs/evidence/`.

## Remaining limitations and open scope

1. **Shared human-controlled conversations:** native APIs lack atomic idle-and-send
   and general invocation-scoped interruption. Shared mode requires an operator
   reservation and fails closed on observed conflicts. Dedicated owned mode is the
   verified automated lifecycle path. Arbitrary active TUI adoption is not supported.
2. **Cross-machine transport:** Relay's socket and native endpoints are local.
   V2 explicitly leaves topology/routing open. No remote Relay gateway, Windows
   transport or cross-machine acceptance test has been implemented.
3. **macOS managed lifecycle:** external local native bindings may use Unix sockets,
   but owned process identity and automatic service installation are Linux-only.
   No macOS runtime/launchd verification has been performed.
4. **Native uncertainty:** a crash between persisted intent and native POST can
   remain unresolved. Hermes terminal replay eviction before observation, compaction
   continuation or a native crash before a correlated terminal receipt may block
   work. There is no unsafe replay or fabricated settlement override.
5. **Candidate snapshot limits:** hashes cover tracked and non-ignored untracked
   file bytes, modes and symlinks. They are not atomic filesystem snapshots.
   Submodules and special files are refused. Concurrent external writers remain
   outside the trusted reserved-workspace contract.
6. **Source integrations:** production mail/Teams connectors and real Azure subnet
   provisioning are not part of the implemented synthetic scenario connectors.
   Provider-side resource idempotency must be supplied by those integrations.
7. **Credential lifecycle:** run tokens are memory-only and reattached by adapters.
   General rotation, revocation and retention policy are not implemented.
8. **Recovery administration:** uncertain non-idempotent backend writes with no
   matching current state remain unresolved. There is no general operator override.
9. **UI scope:** the herdr pane is a local state overview with selection/details,
   not a replacement for Paperclip's task/review UI. It does not automatically
   create agent panes or close unrelated/restored terminal resources.
10. **Release scope:** the package is a development build, not published to npm.
    No release CI or multi-platform support claim has been established.

These limits must not be hidden by marking the entire spec complete. The v2 open
decisions remain open where implementation requires a topology or platform contract.
