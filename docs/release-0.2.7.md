# Herdr Relay 0.2.7

**Status: draft, not published.** Release date and final verification are pending.
Preparing or merging this version does not authorise a tag, publication or live
service upgrade. Published installation examples remain on 0.2.6 until release.

## Bounded peer collaboration

- The normal task handover carries collaboration permission, selected peers, a
  round budget and a deadline. The board selects the peer with **Ctrl+B** and
  changes the round limit with **Ctrl+R**, in the existing handover form.
- After a coordinator requests peer work and finishes its native turn, Relay
  waits automatically and resumes the same execution with the actual outcome.
  A separate model-managed wait call is unnecessary for this mode.
- Failed, cancelled and rejected peers return control to the coordinator. A
  delegated native turn without a result or clarification becomes an explicit
  failure instead of remaining accepted indefinitely.
- Provisional reports wait for active peers. Failed attempts retain their states
  and evidence, and final coordinator reports expose peer failures rather than
  pretending that every attempt succeeded.
- Ordinary internal peer work defaults to no formal review. Final human review
  does not add a human gate to every exchange. Explicit peer review policies and
  existing submitted candidates are preserved.
- Named-peer and round limits are transactional. Deadline expiry and human job
  cancellation stop new peer work and request cancellation of active peers.
  Previously submitted results are retained. Cancellation does not claim process
  termination or undo external effects.

Informational messaging remains separate. It does not become an unrestricted
work channel or permission to create additional assignments. See
[collaboration](collaboration.md) for the supported work path.

## Instructions and tool routing

- Everyday skills distinguish human-chat, assigned-execution, headless and
  informational contexts. Routine in-scope work does not require repeated approval.
- Worker restrictions apply to the affected execution, not the entire chat.
  Shell, MCP and artifact APIs retain their distinct granted capabilities.
- The everyday skills shrink from 4,336 to 1,139 words. Specialised and historical
  guidance moves to on-demand operational references.
- A current human read can explicitly select worker context without being
  incorrectly required to supply active execution provenance. Assigned execution
  mutations retain their existing scope and revision checks.

## Attachment recovery

- Loading excludes validated, unreferenced refused attachment bindings while
  retaining their identity, command and error history. Rejected preparations no
  longer block unrelated receiver refreshes as conversation aliases.
- `node recover attachment` previews and retires only an eligible refused binding.
  It verifies ownership, takes an integrity-checked backup and records an immutable
  audit receipt without moving the current receiving chat or deleting history.
- Terminal retry slots are scoped by node configuration and workspace. Legacy
  intent migrates only in its original workspace, retaining its original key and
  arguments. Conflicting saved operations remain available for inspection.
- Reconciliation displays the saved target, and upgrade checks inspect both
  legacy and workspace-scoped outboxes.

## Compatibility

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**,
interactive provisioning protocol **1** and installer protocol **1**. Bounded
collaboration declares compatibility protocol **1**. The minimum upgrade source
remains **0.2.1-rc4**. No database migration or re-enrolment is introduced.

Upgrade the backend and participating nodes before enabling bounded collaboration.
An active collaborative job fences a switch to older code lacking its protocol;
settled history and unrelated work do not create that fence. Existing grants,
credential boundaries, model pins and uncertain-effect evidence remain intact.

## Verification completed during development

- 661 root regression tests and 143 plugin tests passed, with repository checks.
- A real-model run on OpenCode **2.2.6** used two GPT-6.1 Sol agents in two private
  workspaces. Independent assessment, coordinator repair, fresh peer verification
  and final reporting completed in two peer rounds and three coordinator turns,
  without additional human prompts or manual execution-state repair.
- The actual repaired artifact and complete native transcripts were verified.
  Evidence reinspection uses read-only database handles and native GETs rather
  than replaying models when verification code needs correction.
- Native terminal attachment/enrolment smoke passed on OpenCode **2.1.0** using
  deterministic fixture models. That is transport/terminal evidence, not the
  real-model collaboration result.

These checks do not replace the required installed-package host matrix, production
audit, compatible upgrade/rollback and Herdr keyboard verification. Those remain
release gates while the PR is draft. Real-model acceptance covers the private
manifest task, not production business-source access or physical multi-machine
qualification.

The [release procedure](releasing.md) still requires explicit publication authority
and exact verified assets. No release tag or live upgrade is part of this draft.
