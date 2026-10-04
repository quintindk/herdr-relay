# Specification implementation tracker

Updated: 2026-10-04. Contract: [specification v2](spec-v2.md).

This tracker records verified behaviour, not intended capabilities. Every remaining
item requires implementation and evidence before the specification is complete.

| Requirement | Current evidence | Remaining work |
| --- | --- | --- |
| Separate agents without managers | Real Paperclip smoke | Preserve through provisioning |
| Existing native conversations | Live OpenCode/Hermes tests and revisioned rebinding | Enforceable shared-conversation reservation |
| Native dispatch and CLI submission | Live OpenCode/Hermes delivery and owned cancellation | Shared-conversation input locking |
| Duplicate/stale protection | Store, HTTP and process-restart tests | Backend mutation reconciliation beyond result comments |
| Paperclip host recovery | Real host crash/restart and explicit replacement-run recovery | Board-authorised recovery orchestration |
| Questions and continuation | Real Paperclip interaction and automatic continuation smoke | Agent answer commands and full native question scenario |
| Agent discovery and work CLI | Scoped discovery, task create/list/assign, answer commands and shared skill | Inbox, uncertain mutation reconciliation and skill provisioning |
| Result review and acceptance | Working-tree digest and real candidate-bound board acceptance | Correction orchestration, finalisation and retirement |
| Lifetimes and provisioning | Integrated agent/runtime/binding provisioning, task lifetimes and worktrees | Combined live-backend provisioning and herdr placement |
| Retirement and cleanup | Controller-scoped acceptance retirement, owned runtime stop and worktree cleanup | Hermes runtime ownership and placement reconciliation |
| Herdr integration | Live-verified interactive work pane, status and discovery actions | Runtime placement restoration reconciliation |
| Monitoring workflow | Real Paperclip end-to-end fixture with events, schedules and task routing | Combined native scenario and production connectors |
| Subnet-request workflow | Real Paperclip peer request, clarification and synthetic resource result | Combined native scenario |
| Worktree workflow | Real Paperclip/Git corrections, candidate checks, acceptance and dirty-cleanup recovery | Combined native scenario |
| Operational installation | Generated Linux user service | Full install lifecycle and macOS supervision |

Cross-machine topology and gateway routing remain open decisions in v2. They must
be explicitly resolved before claiming the whole specification is implemented.
