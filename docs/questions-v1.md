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

## Reply From The Harness

The OpenCode bridge provides explicit, permission-checked tools:

- `relay_questions`: list pending Relay clarification questions for the enrolled
  conversation. Internal IDs are resolved by the agent, not typed by the user.
- `relay_answer`: proposes an answer grounded in the current user turn. It selects
  the single pending question automatically, or accepts an agent-resolved exact
  interaction ID when multiple questions exist.
- `relay_reviews` and `relay_review`: list exact pending candidate reviews and
  relay an explicit human accept/reject decision. Rejection requires a reason.

After the question turn ends, respond naturally, for example:

```text
Use South African Standard Time please.
```

The tool verifies its executing session and assistant-parent user message through
the native SDK, requires that source to be the most recent user message, and calls
OpenCode's `context.ask` permission mechanism with the proposed answer/decision,
source text and exact issue/question/candidate
before posting. Permission behaviour follows the user's configured policy; no
automatic permission grant is installed. The agent must distinguish an actual
answer or decision from hypothetical discussion and handle ordinary typos. When
ambiguous, clarify the issue in human terms. Synthetic source text, older turns
and another conversation are refused. Nothing is posted merely by typing a
message: a deliberate tool call and the configured permission check are required.

The bridge endpoint is authorised only for its own settled waiting run and exact
recorded `ask_user_questions` interaction. It works after the original backend
run token has expired by using the connector's configured operator backend
authority, never exposing that credential to the agent. Only Relay's single
free-text clarification shape is supported initially. The separate review path
only targets the latest exact settled/published candidate and refuses unrelated
confirmations. It never approves a candidate during its own worker turn.

### Attribution And Retries

Paperclip's authenticated resolver is the **operator connector account**. The
answer summary identifies the originating native conversation and user-message
ID and explicitly says this was a harness-relayed answer, not a separate
authenticated Paperclip human session. Relay retains the source digest and exact
answer in its private operation receipt. A native `user` role is not cryptographic
proof of a human: other automation can create user messages. The permission check
and same-user trusted plugin are the current authority boundary. If permissions
are globally auto-approved, this is not an independent human approval guarantee.
Paperclip's review-accept endpoint has no provenance field, so review source and
decision evidence are kept in Relay's private `harness-review` receipt instead of
posting a comment that might supersede the review. The backend resolver remains
the operator connector, not the worker agent impersonating a reviewer.

One durable `harness-answer` operation exists per interaction. Identical retries
return its receipt. A different answer conflicts rather than overwriting the
first one. An identical answer already recorded in Paperclip is read back with
no new POST. A conflicting dashboard answer or closed question is refused.
A lost POST response is reconciled from the question; if still pending, Relay
does not blindly resend or manufacture a new idempotency key.

After successful relay, the agent must end its current turn, not solve the task
inline. Paperclip's existing `wake_assignee` continuation starts the next Relay
run, and the bridge waits for native idle before delivering it. The plugin holds
delivery polling during the answer tool itself. This does not make concurrent
human input atomic; do not keep typing while the task continuation is running.

### Installation And Verification

This ships in the existing `opencode-bridge-plugin.mjs`. Run `npm ci` in the Relay
checkout for its pinned `@opencode-ai/plugin` tool-schema dependency. No additional
MCP server or credentials are needed. Restart the enrolled OpenCode process and
resume the same conversation in the same Herdr terminal to load the new tools.
Do not restart while a Relay invocation is unsettled.

Automated tests cover the source-message/permission path through a real Relay
socket, natural answers, denied permissions, scope, identical/conflicting dashboard
answers and lost responses. Review decision and retry handling are unit-tested.
The original explicit-command variant was live-tested in DEF-12: the answer was
recorded, the same conversation continued and the issue completed after dashboard
acceptance. That test also exposed the unacceptable UUID-copying experience and
missing harness review action. Old loaded plugins retain their explicit command
until restarted; the server accepts that shipped shape during transition.

DEF-13 verified the revised natural-language flow on 2026-10-05. The user answered
in the existing scriptorium conversation, and `relay_answer` recorded `SAST` against
the exact pending clarification with source-message attribution. Paperclip woke
the same native conversation for the result turn. The user approved in the harness,
`relay_review` recorded acceptance of that exact candidate, and Relay marked the
issue Done automatically at `2026-10-05T13:25:04.551Z`. Readback confirmed recorded
`harness-answer`, `harness-review` and completion receipts, one answered question,
one accepted review, and no missing-disposition handoff, execution blocker or
active recovery action. No UUID copying or manual dashboard repair was required.
