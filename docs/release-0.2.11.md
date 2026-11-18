# Herdr Relay 0.2.11

Automatic active-provider authentication for headless jobs. This release is in
preparation. A branch, pull request or merge does not publish assets or upgrade
running services. Existing 0.2.10 tags and assets remain unchanged.

## Automatic provider authentication

- Always use the current active OpenCode connection for the job's approved provider
  and model. This applies to every existing and new headless grant, without an
  opt-in policy or manual recovery approval.
- Accept a changed account, credential ID or authentication client for the same
  provider. The original coordinator need not be active or have an open chat.
- Follow OpenCode's active OAuth, key, external-credential or environment connection.
  Relay neither enumerates credential values nor resolves or copies secrets.
- Keep the provider and model fixed. Do not select another provider/model when
  authentication is unavailable or the approved model is absent.
- Accept provider/model-only grant specifications. Existing `integrationID` and
  `connectionId` fields remain readable as historical metadata, not authentication
  pins. Existing grants do not need rewriting or reapproval.

The selected active account can receive the job's model prompts and incur its
model usage. Account selection is owned by OpenCode, not a per-job Relay pin.
There is no coordinator requirement, idle boundary, grant revision or additional
readiness run solely because an already-ready worker's sign-in changes.

## Remove manual connection rebind

- Remove `relay_headless_connection`, both connection preview/rebind CLI commands,
  their node endpoints, backend handlers and the old capability advertisement.
- Remove the implementation modules rather than retain compatibility aliases.
- Update the managed Relay skill, CLI help and operational/security documentation.
  Agents must not ask the human to apply a rebind or activate the old coordinator.
- Retain historical recovery records and their no-backfill fences. Removing an API
  does not erase work history or make an old uncertain invocation safe to replay.

## Recover old authentication-only setup blocks

The owning node checks whether access has returned and retries bounded setup
readiness for authentication/model-availability blocks. This includes saved
`model_connection_changed` and `model_integration_mismatch` failures from older
versions. No live coordinator or grant rewrite is required.

Recovery retains the worker, native session, instructions, permissions and schedule.
Paused schedules remain paused. Revoked grants, cancelled schedules, changed
instructions, unsettled readiness and unrelated failures are not overridden.
Failed or uncertain business effects are never retried because of a login change.

## Compatibility and rollout

Protocol remains **relay/0.2**, backend schema **2** and node schema **1**. Existing
interactive provisioning, collaboration, agent deletion and installer compatibility
protocols remain **1**. No database migration or re-enrolment is introduced.

Upgrade the Relay backend, destination node and OpenCode plugin together before
relying on the new behaviour. The backend advertises `activeProviderConnections`
for autonomous recovery of saved setup blocks. Publishing this release does not
change live sign-ins, restart OpenCode, replace workers or activate paused jobs.

## Verification

- Core and plugin regressions cover repeated sign-in/auth-client changes,
  provider/model-only grants, environment connections and unavailable-auth failures.
- Node tests cover an offline coordinator, next-tick cron admission, automatic
  recovery, paused/cancelled schedules, revocation and original-key reconciliation.
- Removal tests verify the tool is absent and old CLI commands, node endpoints
  and backend actions cannot enqueue or mutate work.
- Isolated OpenCode **2.1.0** and **2.3.0** fixtures completed an actual cron after
  changing the active connection with the coordinator archived. Native model
  requests used the replacement key. Worker/session, grant and schedule identities
  were preserved, along with granted MCP/shell behaviour and revocation.
- Source checks and an offline production-install smoke passed during development.
  That smoke skipped the production audit and is not release certification.

Exact clean-source package verification, the required OpenCode **2.1.0, 2.1.2 and
2.2.5** matrix, Herdr checks and a fresh zero-finding production audit remain
publication gates. OpenCode 2.3.0 is a supplemental host check, not a replacement
for that matrix. CI results must apply to the exact release commit.

## Known limitations

Unavailable or rejected provider authentication, rate limits and provider-specific
retained-history errors still surface normally. In particular, a retained Copilot
conversation may reject input references created under another account. This
release removes Relay's connection pin. It does not erase provider history,
manufacture a successful run or replay a failed request.

See [headless authentication](headless-authenticated-setup.md#automatic-active-provider-authentication)
and the [release procedure](releasing.md).
