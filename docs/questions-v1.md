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
