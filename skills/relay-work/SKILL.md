---
name: relay-work
description: Execute an accepted native Herdr Relay assignment, use its granted tools, collaborate within its job budget, ask for genuinely missing decisions and submit actual results.
license: MIT
compatibility: opencode
---

# Relay work

1. Read `relay_work_read` for this execution, current input, capabilities and
   cancellation state. Perform its authorised goal with the granted business
   tools. No extra approval is needed for routine in-scope steps.
2. Use peer results as inputs to this goal, not new permission. In a collaborative
   job, request selected peer work with `relay_delegate`, then finish the native
   turn. Relay handles waiting and resumes you with a result or terminal failure.
   Legacy delegation without a collaboration budget uses `relay_wait_children`.
3. Handle failures using the returned evidence and remaining budget. Preserve
   partial work and report limitations. A failed peer is not a reason to stall
   indefinitely, claim success or blindly repeat an uncertain external effect.
4. If a required decision is missing, stage `relay_work_ask` with a clear question
   and stable key. Set `humanRequired` only when the decision needs human authority.
   Finish after successful staging; the answer resumes this execution.
5. When the goal is complete, stage `relay_work_submit` with a stable key, exact
   candidate identity and actual results/checks/limitations. Finish after success.
   Native terminal evidence and the chosen review policy govern publication.

## Scope and safety

- A conflict or cancellation stops effects for this execution. Inspect the reason
  and use the supported recovery path rather than changing identity or replaying
  an old prompt. Ordinary human steering continues a verified interactive job.
- Direct tools recheck current input. CLI worker mutations use the returned
  `inputRevision`. Worker context does not provide human operator authority.
- Shell/MCP permissions are separate from native task/artifact permissions. Empty
  native scopes do not restrict already-granted shell/MCP work. Use the native
  headless bridges; shell is full OS-user access, not a path sandbox.
- Technical use of a peer result needs no separate review grant. A formal
  `relay_review_child` decision uses its specified grant. Follow the root's review
  policy rather than assuming every result needs human approval.
- Retain identities, credential privacy and immutable operation keys. Reconcile
  uncertain writes. Do not invent authority, results or process termination.
- Finish after staging a question, result, explicit wait or delay. Service result
  notifications handle reporting; a separate acknowledgement task/message is
  unnecessary. Informational peer messages do not dispatch new work.

Detailed protocol and historical recovery guidance is in
`docs/relay-worker-protocol-reference.md` in the installed package or checkout.
