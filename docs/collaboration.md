# Bounded agent collaboration

One human handover can authorise a coordinator to work with selected existing
peers. Relay handles waiting, peer outcomes and coordinator continuation. There
is no additional permission request for each routine peer check.

This is the execution/delegation path, not task-independent messaging. Status
messages retain their informational one-reply policy and do not dispatch work.

## Task board

1. Select the task, press **a**, choose the coordinator and enter the handover.
2. **Ctrl+B** cycles through available peers or turns collaboration off.
3. **Ctrl+R** changes the round limit. The default is two peer executions and a
   ten-minute job deadline. The peer and budget are shown in the same handover.
4. **Enter** sends that one authorised job. No second approval dialog is needed.

A round is one peer execution, not a notification or tool call. A coordinator can
request a fresh peer verification after incorporating the earlier result, within
the original budget. Advanced callers can select multiple peers and a different
bounded limit. Existing enrolments are reused; collaboration does not provision
another agent or select a different receiving chat.

The backend and owning nodes need bounded-collaboration support. Older backends
leave the board option unavailable rather than silently dropping the budget.

## Native CLI and bridge

Use the ordinary human-requested `native execution request` operation:

```json
{
  "id": "review-and-repair",
  "taskId": "EXISTING_TASK_ID",
  "taskRevision": 1,
  "targetAgentId": "COORDINATOR_AGENT_ID",
  "instructions": "Work with the selected peer to review, repair and verify the manifest.",
  "reviewPolicy": "human",
  "allowDelegation": true,
  "collaboration": {
    "peerAgentIds": ["PEER_AGENT_ID"],
    "maxRounds": 2,
    "timeoutSeconds": 600
  }
}
```

The bridge uses the configured human operator context for a current human request.
It does not require a parent execution or reading credentials. The normal board
handover carries the same fields and preserves its original key on retry.

`peerAgentIds` contains 1-16 independent enrolled peers with the same owner.
`maxRounds` supports 1-16 peer executions. `timeoutSeconds` supports 1-3600 seconds.
The backend records an immutable absolute deadline. Another peer, extra rounds,
or a later deadline requires a separately authorised job, not a changed payload
under the original operation key.

## Coordinator and peer behaviour

- The coordinator reads its assignment and requests selected peer work through
  `relay_delegate`. It then finishes the native turn.
- After the exact native terminal is observed, Relay waits automatically. The
  coordinator need not make a separate `relay_wait_children` call for this mode.
- The peer uses its granted business tools, then submits its result or a required
  clarification. Peer scope does not become human operator scope.
- Relay resumes the same coordinator execution with the actual peer results or
  terminal failures. The coordinator can integrate the result or use the remaining
  round budget to investigate and verify.
- A provisional final report cannot publish while current peers are still active.
  It is retained as provisional evidence and the coordinator resumes with outcomes.

Legacy delegation with `allowDelegation` but no collaboration budget retains its
explicit `relay_wait_children` protocol.

## Failure, review and cancellation

A failed, cancelled or rejected peer wakes the coordinator after the selected
peer set is terminal. A delegated native turn that finishes without submitting
a result or clarification becomes an explicit failed peer outcome. It does not
remain accepted indefinitely, and no successful result is invented.

The coordinator can handle those failures and submit its own report. Failed peer
attempts stay failed, their task/evidence records remain visible, and the final
report carries `peerFailures` when applicable. Explicit task dependencies and
unrelated outstanding child tasks still prevent completion.

Internal peer executions default to `reviewPolicy: "none"`. Final human review
on the coordinator does not add a human gate to every peer exchange. A caller
can still opt an individual peer into human review or use an explicit formal
agent-review grant. Existing submitted candidates and explicit review policies
are preserved.

The round budget is enforced transactionally. Deadline expiry requests
cancellation and prevents new rounds. Human cancellation of a collaborative job
also stops its unstarted peers and requests cancellation of active peer work.
Submitted peer results are not discarded. Cancellation does not claim that
already-started processes or external effects stopped.

Unknown write outcomes remain subject to original-key reconciliation. A peer
failure is not evidence that an external operation did nothing and is not an
instruction to resend it.

## Verification

The regression suite exercises normal handover, automatic wait/resume, failed
peers, missing submissions, provisional results, intermediate/final review,
round/deadline limits, cancellation and immutable retries:

```sh
node --test test/collaboration.test.mjs test/native-board-dispatch.test.mjs test/task-board-dispatch.test.mjs
```

Real-model acceptance is separate and explicitly opt-in:

```sh
node scripts/verify-collaboration.mjs --real-model --session EXISTING_MODEL_SOURCE_SESSION
```

It uses that session's current model and existing authenticated OpenCode service,
without copying a provider credential store. It creates private workspaces,
sessions, backend, node and task records. The candidate plugin runs under a
private test registration ID so it cannot collide with the installed Relay
plugin. Existing live enrolments, assignments and global configuration are not
modified. Only test-created sessions are interrupted/archived on exit.

The job asks a coordinator and reviewer to assess, repair and freshly verify a
manifest. Models choose their own tools. The verifier checks the resulting file,
both peer executions, real business-tool use and coordinator continuations. It
does not inject provider responses, stage results on the models' behalf or use
extra human prompts to repair the loop. Private evidence is retained under
`/tmp/opencode`; a scripted transport smoke is not labelled real-model acceptance.

Recheck an existing completed run without dispatching models again:

```sh
node scripts/verify-collaboration.mjs --inspect /tmp/opencode/relay-collaboration-real-EXACT_RUN
```

Inspection validates the actual backend/node records, artifact and complete
native transcripts using GETs and read-only database handles. It does not resume
or repair the execution. The original failed-verifier receipt remains alongside
the new verification report when only evidence collection needed correction.
