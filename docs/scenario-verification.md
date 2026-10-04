# End-to-end scenario verification

`scripts/scenario-smoke.mjs` ran successfully on 2026-10-04 against isolated real
Paperclip `2026.1001.0`, using the installed Relay adapter, live Relay service,
worker-scoped HTTP commands and a real disposable Git repository.

The test covers all three workflow families:

1. A bounded monitor emits three fixture source events and retries each without
   duplication. The daily driver creates only the two actionable tasks, one owned
   by a human and one assigned to an independent project agent. The project result
   returns and the monitoring schedule stops.
2. A demo agent creates a subnet request for an independent provider. The provider
   asks for a region, ends its turn, receives a persisted answer in a later run,
   and returns a synthetic subnet ID. The requester verifies that result and the
   provider remains registered.
3. A task-scoped worker changes a graph in an owned worktree. The first candidate
   is rejected. The corrected candidate supersedes it, stale acceptance is refused,
   the reviewer checks actual JSON and commits the exact candidate, and Paperclip
   records acceptance. An untracked file blocks cleanup without undoing acceptance.
   After resolving that file, retirement removes the worktree and preserves the
   result commit and persistent controller.

The graph review fixture deliberately ends a review-only adapter run through
cancellation. Paperclip then requires explicit execution reconciliation before
the correction run. The test resolves that real backend recovery action with
evidence that the deterministic review operation has stopped. This is not bypassed
by inventing a fresh task or clearing database state.

Reproduce inside the existing evaluation image with Paperclip running:

```bash
docker exec ISOLATED_CONTAINER node /relay/scripts/scenario-smoke.mjs
```

Each execution creates a fresh company and identities. Worker reasoning, source
messages and Azure resources are deterministic fixtures. It does not access real
mail or provision Azure resources. Native OpenCode/Hermes delivery and cancellation
have separate real-model evidence.

`scripts/live-paperclip-opencode.mjs` also passed with real Paperclip, OpenCode and
`github-copilot/gpt-6-astra` together. It provisioned an independent backend agent
and native conversation, had the model ask a region question through the CLI,
observed bounded waiting, answered in Paperclip, and verified automatic native
continuation in the same conversation. The model used the answer and submitted
one attributed synthetic subnet result. The owned runtime was then retired.
This closes the combined native/backend question and provisioning path. The
monitoring and correction/worktree scenario workers remain deterministic.
