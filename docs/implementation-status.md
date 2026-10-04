# Specification implementation tracker

Updated: 2026-10-04. Contract: [specification v2](spec-v2.md).

This tracker records verified behaviour, not intended capabilities. Every remaining
item requires implementation and evidence before the specification is complete.

| Requirement | Current evidence | Remaining work |
| --- | --- | --- |
| Separate agents without managers | Real Paperclip smoke | Preserve through provisioning |
| Existing native conversations | Live OpenCode and Hermes Relay tests | Verified rebinding and enforceable reservation |
| Native dispatch and CLI submission | Live OpenCode/Hermes delivery, owned OpenCode cancellation | Hermes owned interruption and shared-conversation input locking |
| Duplicate/stale protection | Store, HTTP and process-restart tests | Backend mutation reconciliation beyond result comments |
| Paperclip host recovery | Real host crash/restart and explicit replacement-run recovery | Board-authorised recovery orchestration |
| Questions and continuation | Real Paperclip interaction and automatic continuation smoke | Agent answer commands and full native question scenario |
| Agent discovery and work CLI | Scoped discovery, task create/list/assign, answer commands and shared skill | Inbox, uncertain mutation reconciliation and skill provisioning |
| Result review and acceptance | Working-tree digest and real candidate-bound board acceptance | Correction orchestration, finalisation and retirement |
| Lifetimes and provisioning | Owned OpenCode runtime launch/stop and worktree provisioning | Lifetime orchestration, Hermes launch and herdr placement |
| Retirement and cleanup | Owned worktree provisioning, commit recovery and acceptance-gated clean removal | Native runtime retirement, placement ownership and orchestration |
| Herdr integration | Status, discovery and terminal work overview actions | Interactive panes and restoration reconciliation |
| Monitoring workflow | Durable source events, atomic checkpoints and inbox receipts | Connectors and bounded schedule lifecycle |
| Subnet-request workflow | Historical deterministic evaluation | Peer request, clarification, dependency and result acceptance through Relay |
| Worktree workflow | Historical deterministic evaluation | Provision, exact candidate, corrections, finalisation, acceptance and cleanup |
| Operational installation | Generated Linux user service | Full install lifecycle and macOS supervision |

Cross-machine topology and gateway routing remain open decisions in v2. They must
be explicitly resolved before claiming the whole specification is implemented.
