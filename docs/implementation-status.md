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
| Lifetimes and provisioning | Owned OpenCode/Hermes launch/stop, task lifetimes and worktrees | Integrated provisioning and herdr placement |
| Retirement and cleanup | Controller-scoped acceptance retirement, owned runtime stop and worktree cleanup | Hermes runtime ownership and placement reconciliation |
| Herdr integration | Live-verified interactive work pane, status and discovery actions | Runtime placement restoration reconciliation |
| Monitoring workflow | Durable source events, atomic checkpoints and inbox receipts | Connectors and bounded schedule lifecycle |
| Subnet-request workflow | Historical deterministic evaluation | Peer request, clarification, dependency and result acceptance through Relay |
| Worktree workflow | Historical deterministic evaluation | Provision, exact candidate, corrections, finalisation, acceptance and cleanup |
| Operational installation | Generated Linux user service | Full install lifecycle and macOS supervision |

Cross-machine topology and gateway routing remain open decisions in v2. They must
be explicitly resolved before claiming the whole specification is implemented.
