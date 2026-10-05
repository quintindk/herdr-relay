# Bounded clarification and continuation

Verified against Paperclip `2026.1001.0` on 2026-10-04.

An acknowledged worker can request clarification before submission:

```bash
herdr-relay --context worker.json work ask RUN \
  --key region --question-file question.md
herdr-relay --context worker.json work inspect RUN
```

Relay durably records the question and publishes a Paperclip `ask_user_questions`
interaction with a stable idempotency key and `wake_assignee` continuation policy.
Changed question retries conflict. This turn cannot also submit a candidate.
Publication retries use Paperclip's interaction idempotency contract and read back
an existing receipt. Result comments retain their stricter no-repost contract.

After the question is published, native completion settles the turn as `waiting`.
Pull mode requires the operator to verify the turn ended and call
`operation settle RUN --outcome waiting --evidence TEXT`. The adapter returns a
successful bounded execution with a waiting disposition. The outstanding question
remains in Paperclip while the conversation becomes available for another turn.

An authorised participant answers in Paperclip. Paperclip wakes the assignee in a
new run. The existing binding preserves the conversation. Workers use
`work interactions RUN` to retrieve the correlated answer, then acknowledge and
continue under the new run ID. Prior receipts remain available.

`agent discover` exposes company-scoped peer identities without backend secrets,
operator context paths or lifecycle authority. The shared participation guide is
in `skills/relay-work/SKILL.md`. It uses only implemented commands. Installation
into native harness skill paths remains a separate provisioning step.

`scripts/paperclip-question-smoke.mjs` exercises actual backend interaction
creation, a board response, automatic continuation and one final result through
the installed adapter. Workers are deterministic in this test. The separate live
native tests establish each harness's CLI participation and terminal settlement.

## Live Existing-Conversation Verification

On 2026-10-05, DEF-11 verified the clarification flow through the in-process
OpenCode bridge in the existing scriptorium conversation:

- The assignment turn created exactly one city-choice question and settled as
  `waiting`, without submitting a candidate or retaining an active execution.
- The user answered `Johannesburg` in Paperclip interaction
  `c1bdc205-d647-4da9-89ca-99663a55925d`.
- Paperclip automatically started a continuation run in the same native
  conversation. The worker read the answered interaction through its scoped
  Relay CLI and used `Africa/Johannesburg` for the local time observation.
- The continuation submitted one result, settled from correlated native evidence,
  and created a review confirmation. Both backend runs succeeded.
- The user accepted the result. Relay recorded completion and marked DEF-11 Done
  at `2026-10-05T12:33:18.646Z`, with no missing-disposition handoff, execution
  blocker or active recovery action.

No manual answer injection, continuation prompt, settlement or status repair was
needed. The original Herdr pane, terminal and OpenCode conversation were retained.
