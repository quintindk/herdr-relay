# Herdr Relay 0.2.6

**Unpublished draft bug-fix batch.** More fixes will be collected before the human
authorises publication. A draft pull request or CI package build is not a release.
Do not create/push the version tag, publish assets or upgrade live installations
while this batch remains in draft.

## Current fixes

- **Interactive model acknowledgement:** a structured native `model-switched`
  event can be acknowledged by a subsequent genuine human message in the same
  verified chat. The observer checks the previous/current model and variant,
  records control evidence separately from human authority and retains the same
  assignment and original invocation. Selecting a model alone authorises no work.
- **Retained model-conflict recovery:** exact current-human preview/apply can
  recover an older model-switch conflict without replacing the agent, replaying
  a prompt or fabricating completion. An upgrade alone does not clear old conflicts.
- **Background-completion provenance:** an owned shell/subagent completion arriving
  after a human follow-up preserves that latest human CLI source. Correlation uses
  successful native tool receipts, not IDs mentioned in tool input or contradictory
  output. A question-tool answer is not a fresh native human source.
- **Recovery and publication fences:** model changes alter the input revision and
  supersede stale staged outcomes. Recovery rechecks the receiver generation before
  applying. Pending/uncertain publications, cancellation, ambiguous ownership and
  foreign peer/profile/workspace inputs remain fenced.
- **Per-invocation identity failures:** a changed native project identity blocks its
  owning invocation instead of aborting other agents' execution processing. No
  identity pin is adopted automatically.
- **Native regression gates:** CI and installed-package verification exercise new
  model acknowledgement, exact historical model recovery and a real background
  shell completion arriving after a human follow-up on OpenCode 2.1.0, 2.1.2 and 2.2.5.
- **Upgrade CI asset reads:** the test-only RC4 baseline downloader retries transient
  HTTP/transport failures at most three times, discards partial responses and reports
  the HTTP status, attempt and asset path on refusal. Permanent HTTP refusals,
  insecure redirects, excessive size and invalid checksums still fail immediately.
  Baseline audit findings remain explicit and candidate production audits stay strict.

Scheduled/headless jobs and standing monitors do not acquire interactive model
acknowledgement. Existing model/authentication pins, permissions, task ownership,
native history and uncertain-effect evidence remain intact.

## Compatibility and release hold

Protocol remains **relay/0.2**, backend schema **2**, node journal schema **1**,
interactive provisioning protocol **1** and installer protocol **1**. The minimum
upgrade source remains **0.2.1-rc4**. No database migration, reset, credential copy
or re-enrolment is required.

The initial fixes passed local root/plugin regressions and isolated native checks
on all three supported OpenCode hosts. Fixture models are deterministic and do
not certify business execution or live provider authentication. Final release
certification still requires the complete [release gates](releasing.md), including
clean-source provenance, production installation/audit, installed-host checks,
Herdr keyboard verification and compatible upgrade/rollback evidence.

Keep the pull request in draft and append further reviewed fixes to this batch.
Publication, merging and live deployment require their own explicit human decisions.
