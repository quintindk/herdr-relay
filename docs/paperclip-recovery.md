# Paperclip host recovery

Verified on 2026-10-04 against Paperclip `2026.1001.0`.

## Observed behaviour

After the Paperclip application process is killed, its legacy-controller lease
remains valid for 60 seconds. Startup reconciliation after lease expiry marks an
external-adapter run `failed` with `process_lost`. It does not re-invoke the Relay
adapter. Paperclip also blocks a replacement issue run until execution outcomes
are reconciled through its recovery-action API.

Relay preserves its native reservation and received result independently. A failed
Paperclip run is not evidence that the native agent stopped. Work already delivered
may continue and submit locally. Task reads requiring expired backend credentials
can become unavailable. New work stays blocked behind unsettled native execution.

## Recovery procedure

The operator can now orchestrate this procedure with `backend recover RUN` when
Relay has a configured `--backend-context` file. Native result and settlement must
already be complete. The command resolves the matching Paperclip recovery action,
configures and invokes a replacement under a stable key, then restores prior agent
configuration once attachment is observed. Repeat the command while its operation
is `replacement_started`. It never invents native settlement. The real host-restart
smoke now exercises this command rather than manual configuration changes.

1. Inspect the Relay run with `work inspect RUN`. Establish actual native
   settlement. For native delivery, Relay must observe the terminal response. For
   pull mode, the operator records verified settlement using `operation settle`.
2. Inspect Paperclip's `GET /api/issues/ISSUE_ID/recovery-actions`.
3. Resolve the action through `POST /api/issues/ISSUE_ID/recovery-actions/resolve`
   using the current action ID, `outcome: "restored"`, `sourceIssueStatus: "todo"`
   and `executionReconciliation` containing the failed run ID, `providerStopped:
   true`, the actual `actionOutcome`, and evidence of the observed effects. Do not
   assert provider termination merely because Paperclip failed the run.
4. Configure the same Paperclip agent's adapter with `recoverRelayRunId: "RUN"`,
   retaining its binding ID, revision and operator context.
5. Invoke the same task under a replacement Paperclip run. Relay verifies the old
   run is terminal and the replacement is running for the same company, agent and
   task. It attaches the replacement to the existing Relay run. It never creates
   another native prompt.
6. After recovery succeeds, remove `recoverRelayRunId` from the adapter config
   before dispatching unrelated work.

Pending results publish under the replacement run's credentials and attribution.
Uncertain writes preserve the original publication run ID for read-back. Recovery
never authorises reposting an uncertain comment. A matching existing receipt is
reconciled without another POST.

Schema 3 adds a unique backend-recovery mapping and preserves original dispatch
identity and recovery history. Old adapter credentials cannot attach or publish
after a replacement is selected. A lost recovery response is safely repeatable.

## Reproduction

Run the opt-in integration test in an isolated container with an init process:

```bash
docker run -d --init --name relay-recovery-test \
  -v "$PWD:/relay:ro" retinue-evaluation:2026-10-03
docker exec relay-recovery-test node /relay/scripts/paperclip-recovery-smoke.mjs
docker stop relay-recovery-test
```

The test kills only its own Paperclip application process, leaves the embedded
database available, waits for controller-lease expiry, and restarts the host. It
verifies a single retained Relay run and one correctly attributed recovered result.
The worker is deterministic. This test does not run native model turns.

Upstream source inspected at `8f8a0ab7effbd6a0584107d8038736c134ee5047`:

- `server/src/services/legacy-controller-lease.ts`: controller lease lifetime.
- `server/src/services/heartbeat.ts`: orphan processing and `process_lost` status.
- `server/src/routes/issues.ts`: recovery-action resolution and outcome checks.

Recovery remains operator-triggered and board-authorised. A background process
does not silently make outcome assertions or rewrite unrelated agent configuration.
