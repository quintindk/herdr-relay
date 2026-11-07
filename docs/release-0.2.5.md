# Herdr Relay 0.2.5

Patch release for interactive provisioning, grant selection and recovery. This
candidate is not yet published. Building or publishing it does not upgrade live
services, change existing approvals or restart receiving chats.

## Changes

- **Scope-aware matching:** existing grants must cover the requested folders,
  profiles, actions, node-wide ceiling, review policy and expiry. Preparation
  reports the selected grant/revision or the reasons a standing grant was refused.
  A corrected permission request cannot silently reuse an insufficient grant.
- **Capacity before effects:** the backend reserves an enrolment slot before the
  driver creates a directory or native session. Reservations participate in all
  enrolment admission checks, including competing grants with higher ceilings.
  Capacity exhaustion reports `waiting_capacity`. Uncertain creation retains its
  capacity and evidence until inspection proves a safe disposition.
- **Linked repair:** `relay_interactive_repair` and Grants **p** preview a correction
  against the original preparation, permission and node checkpoint. The human
  approves the exact repair once. The original agent/conversation identity,
  verified directory/placement, captured tasks, operation keys and failure history
  remain intact. The old standing grant is not silently edited or revoked.
- **Usable Grants controls:** search includes the requested agent, request ID and
  grant ID. Active permissions link their preparations. **v** opens a revoke
  preview, followed by explicit confirmation. Refused decisions and unconfirmed
  acknowledgements have distinct recovery actions. Polling and delayed reads
  cannot change the selected grant or replace a newer dialog.
- **Clear semantics:** `maxAgents` remains the node-wide enrolment ceiling, not a
  per-request creation allowance. Omit it to inherit the joined node ceiling and
  use **Approve once** for one preparation. Cancelling a blocked request is an
  explicit `already_terminal` no-op. New IDs cannot duplicate an existing
  blocked or pending agent/workspace intent.
- **No uncertain replay:** session-create, workspace, launch and attachment
  observations must be reconciled before repair can continue. A lost native
  session-create response never becomes permission to create another session.

## Installation and compatibility

After publication, use the verified release installer as described in
[installation](installation-and-onboarding.md). Upgrade the **backend, destination
Relay node and OpenCode Relay plugin** explicitly to enable the complete recovery
flow. An older driver is fenced before new provisioning effects and reports
`waiting_node_upgrade`. CLI activation alone does not update those services.

Existing legacy preparations are retained. The destination node inspects their
local records and observations before a repair preview becomes eligible. Missing
or uncertain evidence is a blocker, not a reason to delete a journal, directory,
approval or agent. See [interactive recovery](interactive-recovery.md).

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1** and
installer protocol **1**. The minimum upgrade source is **0.2.1-rc4**. No reset,
database migration, credential copying or re-enrolment is required.
Interactive provisioning compatibility protocol **1** fences a downgrade to older
code while new preparations, reservations or repair approvals still depend on it.
Settled history and unrelated active executions do not block compatible upgrades.

## Verification gates

Release certification requires clean committed source, aligned version/tag
metadata, all root/plugin regressions, installed OpenCode **2.1.0, 2.1.2 and 2.2.5**
recovery checks, real Herdr keyboard repair/approval/revocation, compatible upgrade
and rollback, installer-process evidence and a fresh zero-vulnerability production
audit. Fixture model responses and Herdr placement fixtures are identified
separately from actual native sessions and real Herdr UI checks.
