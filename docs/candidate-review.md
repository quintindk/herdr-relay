# Candidate identity and review

`candidate inspect --directory REPOSITORY_ROOT` computes a SHA-256 identity from
tracked and non-ignored untracked working-tree files, executable modes and symlink
targets. Deleted tracked files are absent from the candidate. Staging or committing
the same bytes does not change its identity. Submodules and special files are
rejected. Ignored build outputs and `.git` state are outside this candidate.

Capture only after editing stops. The command detects Git status changes during
capture, but it is not a filesystem snapshot or a lock against concurrent writers.
The reviewer must independently capture and compare candidate bytes before acting.

```bash
herdr-relay candidate inspect --directory /absolute/worktree
herdr-relay result request CALLER_RUN --file review.json
herdr-relay result inspect CALLER_RUN --file review.json
herdr-relay result accept CALLER_RUN --file review.json
herdr-relay result reject CALLER_RUN --file review.json
```

`review.json` identifies the submitted Relay run and its exact candidate:

```json
{
  "runId": "SUBMITTED_RELAY_RUN",
  "candidate": "sha256:EXACT_DIGEST",
  "reviewerUserId": "local-board"
}
```

For agent review, use `reviewerAgentId`. Rejection also requires `reason`.
The caller must have an active acknowledged run and appropriate Paperclip task
authority. Paperclip checkout locks still apply. Transfer task ownership to the
reviewer through authorised backend operations before asking it to mutate review
state. Relay does not override those permissions.

Reviews are Paperclip `request_confirmation` interactions with a custom target
whose revision is the exact candidate digest. Relay rejects a mismatched candidate,
a result superseded by a newer submission, and self-acceptance/rejection. It reads
back backend disposition, retaining only the integration receipt. Native completion
and result publication must settle before review begins.

Board acceptance was exercised through the real backend and read back through
Relay. Rejection does not yet automatically create a correction invocation.
Acceptance is not automatic task completion or runtime retirement. Finalisation,
retirement and cleanup remain separate implementation work.

## Structured evidence

`work submit RUN --file submission.json` accepts the normal key, summary and
candidate plus optional `deliverables` and `checks`. Each check contains `command`,
`outcome` (`passed`, `failed` or `not_run`) and `evidence`. Relay labels these as
`worker_reported`, regardless of a supplied source label, and includes them in the
backend result comment.

An independent reviewer records its own checks with `result check CALLER_RUN
--file evidence.json`. The file names `runId`, exact `candidate`, stable `key`,
`command`, `outcome` and `evidence`. These are recorded separately as
`reviewer_reported`. Relay records the reporting identity and does not claim to
have independently run commands merely because an agent reports them.

`work progress RUN --key KEY --summary-file FILE` records durable, retry-safe
progress while the turn is acknowledged and active. Progress after submission,
clarification or cancellation is refused.
