# OpenCode 2 Migration Assessment

Date: 13 October 2026

Status: **Migration required. Do not upgrade the primary OpenCode installation yet.**

## Purpose

This document records the research, compatibility evidence and implementation
specification for moving Herdr Relay from OpenCode 1 to OpenCode 2. It covers the
Relay bridge plugin, managed headless runtimes, native session delivery, Herdr
integration, local OpenCode configuration and other installed plugins.

It is an engineering assessment, not authority to upgrade the installed runtime or
rewrite the user's configuration. The primary installation must remain on OpenCode
1 until the cutover gates in this document pass.

## Executive Decision

The current Herdr Relay implementation does not run correctly on OpenCode 2.
OpenCode 2 intentionally breaks both integration surfaces Relay depends on:

1. The plugin implementation API.
2. The server API and generated clients.

An in-place `opencode upgrade --major` would remove Relay tools from interactive
conversations and break new managed-runtime launches. Existing V1 native processes
may continue until restarted, which would produce a dangerous partial migration
rather than compatibility.

The migration must be implemented and tested as a dual V1/V2 integration before
the primary binary is replaced.

## Verified Versions

| Component | Observed version | Notes |
| --- | --- | --- |
| Primary OpenCode executable | `1.19.0` | `/home/quintindekok/.nvm/versions/node/v24.18.0/bin/opencode` |
| Relay plugin dependency | `@opencode-ai/plugin 1.18.27` | Pinned in `package.json` and `package-lock.json` |
| Relay native contract | OpenCode `1.18.34` | Documented and smoke-tested baseline; now behind the installed runtime |
| Latest OpenCode 1 npm release | `1.19.0` | `opencode-ai` latest tag on 13 October 2026 |
| Latest OpenCode 2 npm release | `@opencode/cli 2.0.27` | Verified from npm and an isolated installation |
| OpenCode 2 plugin/client packages | `2.0.27` | `@opencode/plugin`, `@opencode/client`, `@opencode/schema`, `@opencode/protocol` |
| Herdr | `0.9.3` | Supports OpenCode V1 and V2 |
| Installed Herdr OpenCode integration | `v12` | `herdr integration status` reports current integration `v13` |

The repository currently describes several different V1 versions. Version claims
must be consolidated when the V2 work begins:

- `package.json`: plugin `1.18.27`.
- `docs/native-opencode-v1.md`: native runtime `1.18.34`.
- Current executable: `1.19.0`.
- Some live smoke scripts label results as `1.18.34` without reading the executable
  version, so those labels are not reliable after an upgrade.

## Research Sources

Primary sources:

- [OpenCode V1 to V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/)
- [OpenCode plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [OpenCode V2 JavaScript client](https://opencode.ai/v2/docs/build/client)
- [OpenCode V2 HTTP API](https://opencode.ai/v2/docs/api)
- [OpenCode changelog](https://opencode.ai/changelog)
- [OpenCode releases](https://github.com/anomalyco/opencode/releases)
- [Herdr integrations](https://herdr.dev/docs/integrations/)

Source and package evidence:

- OpenCode tag `v2.0.27`, commit `1f4d07a4a519185955ae8ab2ea3607805509e386`.
- npm package metadata for `@opencode/cli`, `@opencode/plugin` and
  `@opencode/client` `2.0.27`.
- OpenCode V2 source under tag `v2.0.27`, including config normalisation, plugin
  loading, session APIs and tool contracts.

The compatibility probe used an isolated installation under `/tmp/opencode` with
isolated XDG and home directories. It did not replace the primary OpenCode binary or
edit the user's active configuration.

## OpenCode 2 Changes Relevant To Relay

### Runtime Architecture

OpenCode 2 uses a shared background service for local clients. Terminal clients,
plugins and remote clients connect to that service. A server plugin instance belongs
to an OpenCode location, not to one visible Herdr pane.

This matters because the V1 Relay bridge currently treats plugin process environment
as pane identity:

- `HERDR_PANE_ID` identifies the calling pane.
- `directory` identifies the loaded project.
- `context.sessionID` identifies the exact conversation.
- The plugin directly calls the TUI toast API.

Those assumptions cannot be transferred to a V2 server plugin. Several terminal
clients may display different sessions from one server process. Herdr solved this for
its own integration by moving V2 lifecycle reporting into a pane-local TUI plugin.
Relay needs the same architectural split.

### Plugin API

V1:

- Package: `@opencode-ai/plugin`.
- Entrypoint: async function receiving `{ client, directory, ... }`.
- Result: object containing `tool`, `config`, `chat.message`, `dispose` and other
  string-keyed hooks.
- Tools: `tool({...})` with Zod arguments and string results.

V2:

- Package: `@opencode/plugin`.
- Entrypoint: default `Plugin.define({ id, setup(ctx) })`.
- Hooks and transforms are registered through domain methods on `ctx`.
- Tools use `ctx.tool.transform(...)`, JSON Schema or Standard Schema inputs, and
  structured result content.
- Cleanup is the function returned by `setup`.
- TUI extensions use the separate `@opencode/plugin/tui` entrypoint.
- Server and TUI plugin implementations are separate even when shipped by one
  package.

The official migration guide explicitly states that V1 plugin implementations do
not run in V2.

### Server And Client API

V2 replaces the V1 API. Integrations must use `@opencode/client` or the V2 HTTP
contract.

| Relay operation | V1 implementation | V2 equivalent |
| --- | --- | --- |
| Health/readiness | `GET /global/health` | `GET /api/info` |
| List sessions | `GET /session` | `GET /api/session`, paginated response |
| Create session | `POST /session` | `POST /api/session` with `location` |
| Get session | `GET /session/:id` | `GET /api/session/:sessionID` |
| List messages | `GET /session/:id/message` | `GET /api/session/:sessionID/message` |
| Determine activity | `GET /session/status` | `GET /api/session/active` and events |
| Send prompt | `POST /session/:id/prompt_async` | `POST /api/session/:sessionID/prompt` |
| Interrupt | `POST /session/:id/abort` | `POST /api/session/:sessionID/interrupt` |
| Wait for idle | Poll V1 status | `POST /api/experimental/session/:sessionID/wait` or events |

V2 responses use new envelopes and schema types. The current `src/opencode.mjs`
identity, message, status and settlement checks cannot be pointed at new paths and
assumed safe. They must be rewritten against the new message and execution model.

### Terminal UI Plugins

Relay currently calls `client.tui.showToast()` from the V1 bridge. V2 TUI features
live in a CLI plugin with pane-local state, toasts, dialogs, notifications, commands,
routes, panels, slots and Markdown renderers.

Relay completion notifications and human review/answer confirmation therefore need
a V2 CLI plugin. A server plugin alone cannot safely infer which pane should receive
a toast or confirmation.

### Human Permission Proof

Relay V1 mutation tools call `context.ask(...)` before using native human authority.
The V2 tool execution context contains session, agent, message, call identity, abort
signal and progress, but no `ask` method.

The V2 permission domain can inspect/reply to permission requests and hook permission
evaluation, but it is not a direct replacement for Relay's exact mutation
confirmation and source-message proof.

The V2 design must use one of these supported mechanisms:

1. A server-plugin RPC request to a pane-local CLI plugin, which displays and records
   an exact confirmation.
2. A session form with explicit provenance and a pane-local response.
3. A documented V2 permission primitive that proves the same decision properties.

The implementation must retain the existing requirements:

- exact session and current user message;
- explicit candidate/action details;
- one durable mutation intent before external POST;
- no retry after an uncertain response;
- no worker prompt, notification or synthetic input as human authority.

Replacing `context.ask` with "the model called the tool" is not acceptable.

### Configuration

OpenCode 2 reads supported V1 configuration and normalises it in memory. Immediate
conversion to native V2 syntax is optional, but V1 and V2 use the same configuration
locations. A V2-only rewrite would therefore make rollback to V1 unsafe.

| Current V1 field | V2 field/behaviour |
| --- | --- |
| `autoupdate: "notify"` | `update: "notify"` |
| `plugin` | `plugins` |
| `[path, options]` plugin tuple | `{ "package": path, "options": {...} }` |
| `permission` | Ordered `permissions` rules |
| permission action `bash` | `shell` |
| permission action `task` | `subagent` |
| `agent` | `agents` |
| agent `prompt` | `system` |
| agent `disable` | `disabled` |
| separate agent `variant` | `provider/model#variant` |
| `small_model` | Model for the built-in `title` agent |
| `provider` | `providers` |
| provider `npm` | `package`, with AI SDK package translation |
| provider `options.baseURL` | `settings.baseURL` |
| `mcp.<name>` | `mcp.servers.<name>` |
| MCP `enabled` | Inverse `disabled` |
| MCP scalar `timeout` | `timeout.catalog` and `timeout.execution` |

The current config repeats `attachment: true` for custom models. V2 intentionally
ignores the legacy model `attachment` field and emits warnings. The V2 model default
currently includes text and image input, but every custom model must still be
verified against LiteLLM before migration. `tool_call` and model limits are
translated by the V2 normaliser.

Existing `.opencode/skills/`, agent files and `AGENTS.md` remain supported. Skills
do not require a rewrite.

### Managed Runtime CLI

Relay launches managed OpenCode with:

```text
opencode serve --hostname 127.0.0.1 --port PORT --pure
```

OpenCode 2 `serve` accepts `--hostname`, `--port`, `--cors`, `--service` and
`--stdio`; it does not accept `--pure`.

The managed-runtime design must replace `--pure` with a private V2 configuration
and explicit plugin/provider/permission policy. It must continue to prove dedicated
process identity, loopback-only access, private authentication, exact location and
session identity, one binding per runtime, verified interruption and terminal
settlement.

## Current Relay Integration Inventory

### V1 Bridge Plugin

Primary file: `src/opencode-bridge-plugin.mjs`.

V1-specific dependencies and hooks:

- `import { tool } from "@opencode-ai/plugin"`.
- plugin function input `{ client, directory }` plus second options argument.
- returned `tool` map, `config()`, `chat.message` and `dispose()` hooks.
- `context.ask(...)` for mutation confirmation.
- `client.session.get/messages/status/promptAsync(...)`.
- `client.tui.showToast(...)`.

All require a V2 implementation.

### Native OpenCode Client

Primary file: `src/opencode.mjs`. It encodes V1 HTTP paths, query parameters,
authentication and message shape. Callers include:

- `src/supervisor.mjs` for delivery, observation and interruption;
- `src/provisioning.mjs` for session creation and verification;
- `src/resume.mjs` for managed continuation;
- `src/service.mjs` for binding registration;
- `src/routines.mjs` for managed-headless admission.

Replace it with a versioned native adapter rather than spreading V2 branches through
every caller.

### Runtime Host

Primary files are `src/runtimes.mjs`, `src/runtime-host.mjs` and
`src/provisioning.mjs`. The Linux process ownership checks remain useful. CLI
arguments, health, private configuration, session creation and interruption must
change for V2.

### Tests And Evidence

Most automated tests mock V1 clients and HTTP responses. They verify Relay logic but
cannot certify V2 runtime behaviour. Relevant suites:

- `test/opencode-bridge-plugin.test.mjs`.
- `test/native.test.mjs`.
- `test/opencode-bridge.test.mjs`.
- `test/provisioning.test.mjs`.
- `test/routines.test.mjs`.

Real-runtime scripts:

- `scripts/opencode-smoke.mjs`.
- `scripts/managed-opencode-smoke.mjs`.
- `scripts/live-paperclip-opencode.mjs`.
- `scripts/live-worktree-smoke.mjs`.

V2 needs separate fixtures and live evidence. Existing V1 evidence must remain
clearly labelled rather than overwritten.

## Adjacent Installed Components

### Herdr

Herdr `0.9.3` supports OpenCode V2 through separate server and pane-local TUI
integration files. The installed integration is outdated (`v12 < v13`).

Required cutover step:

1. Start OpenCode 2 once so it can migrate terminal-client preferences.
2. Run `herdr integration install opencode`.
3. Confirm `herdr integration status` reports the current version.
4. Restart OpenCode shared services and TUI panes.

Herdr V2 lifecycle reporting is not available in Mini or headless clients. Relay
managed-headless readiness must continue to use the native V2 service API.

### Heddle

`~/.config/opencode/plugins/heddle.ts` exports the current Heddle V1 plugin. No V2
`Plugin.define` implementation was found. It must be ported or disabled.

### Legacy Herdr Envoy

`~/.config/opencode/plugins/herdr-envoy-dist/` imports `@opencode-ai/plugin`, returns
V1 hooks and has no V2 entrypoint. It is obsolete relative to Relay and should be
removed from active discovery, not ported accidentally.

### Herdr Agent State

`herdr-agent-state.js` exposes V1 `server()` and V2 `setup()`, but V2 server setup is
deliberately empty. Pane lifecycle comes from Herdr's V2 TUI integration. Reinstalling
integration v13 is mandatory.

## Isolated Compatibility Probe

Verified with `@opencode/cli 2.0.27` under an isolated HOME/XDG environment:

1. `opencode2 --version` returned `opencode v2.0.27`.
2. `@opencode-ai/plugin` was absent.
3. `@opencode/plugin` and `@opencode/client` loaded.
4. V2 read the Relay config but warned `configured plugin path must be a directory`.
5. Relay was not listed as an active plugin.
6. `opencode serve --help` confirmed `--pure` is absent.
7. The service exposed the new `/api/...` contract.

This is sufficient to reject a direct production upgrade. It is not a complete V2
Relay smoke because a V2 Relay implementation does not exist yet.

## Proposed V2 Architecture

### Package Shape

Ship a package directory with separate implementations:

```text
packages/opencode-relay/
  package.json
  src/
    v1-server.mjs
    v2-server.mjs
    v2-tui.mjs
    rpc.mjs
    shared/
```

During dual support:

- V1 `1.18.29+` invokes `server()`.
- V2 invokes `setup()`.

The wrapper must not pretend V1 hooks or tools are automatically translated.

### V2 Server Plugin

- Register the Relay tool namespace through `ctx.tool.transform`.
- Use strict JSON Schema inputs and structured outputs.
- Use V2 session, event and permission domains.
- Maintain location-scoped discovery and cleanup.
- Expose typed RPC for the TUI plugin.
- Never infer a Herdr pane from server environment.
- Preserve Relay service authentication and exact-origin checks.

### V2 TUI Plugin

- Identify the current pane's selected root session.
- Correlate pane identity with Herdr's V2 integration.
- Show completion/review notifications in the correct pane.
- Present approve, reject and answer confirmation.
- Return structured decision evidence through RPC.
- Handle pane switching, reconnect, reload and cleanup without transferring
  authority to another TUI.

### Versioned Native Adapter

Implement `NativeOpenCodeV1` and `NativeOpenCodeV2` behind one Relay-facing
interface:

- verify exact session identity;
- capture an immutable snapshot;
- determine idle/running state;
- admit a prompt with caller-supplied message ID;
- observe only that prompt's terminal result;
- interrupt only owned execution;
- distinguish uncertainty from confirmed completion;
- preserve continuation across Relay restart.

Use `@opencode/client` for V2 wherever it exposes the required operation.

## Security Invariants

The migration is unacceptable if any weaken:

1. Exact conversation, never directory-only or server-only binding.
2. Exact pane for human authority on a shared server.
3. Current human source; notifications and worker prompts never authorise writes.
4. Persist intent before non-idempotent writes.
5. Never blindly replay uncertain writes.
6. Exact run, interaction, candidate and result digest for review.
7. Busy-session fencing before prompt delivery.
8. Native terminal proof rather than transport success.
9. Interruption only for verified dedicated runtimes.
10. Existing worker, bridge, operator and backend credential boundaries.

## Implementation Workstreams

### Package And Build

- Add exact compatible versions of `@opencode/plugin`, `@opencode/client`,
  `@opencode/schema` and `@opencode/protocol`.
- Retain the V1 dependency only during dual support.
- Export server and TUI entrypoints as a plugin directory/package.
- Add explicit major-version detection and refusal.

### Tool Port

- Port every `relay_*` tool through `ctx.tool.transform`.
- Translate Zod inputs to JSON Schema or shared Standard Schema.
- Preserve descriptions, strict fields and public result contracts.
- Add parity tests proving every V1 tool exists in V2.

### Human Confirmation And TUI

- Define typed server/TUI RPC.
- Implement exact-pane confirmation for task writes, delegation, schedules, reviews
  and answers.
- Implement toast/history without injecting model turns.
- Prove two TUI clients cannot consume each other's authority or notifications.

### Discovery And Enrolment

- Replace server-process `HERDR_PANE_ID` binding with pane-local evidence.
- Preserve standing grants, duplicate-chat refusal and unsettled-work fencing.
- Preserve epoch behaviour across plugin reload and service restart.

### Native Delivery And Managed Runtimes

- Port session creation, identity, active-state, message, prompt, wait and interrupt.
- Map V2 outcomes (`succeeded`, `failed`, `interrupted`) to Relay settlement.
- Preserve caller prompt IDs and prior-user evidence.
- Remove `--pure`; generate a private V2 location/config policy.
- Port provisioning, resume, cancellation and exact scheduled admission.

### Configuration And Other Plugins

- Produce a V2 config candidate without overwriting the V1 file.
- Convert Relay registration to package-directory `plugins` syntax.
- Port or disable Heddle.
- Remove obsolete Envoy from discovery.
- Verify LiteLLM models, images, tools, limits and variants.
- Reinstall Herdr OpenCode integration v13 after first V2 startup.

### Documentation And Evidence

- Add a V2 native contract.
- Keep V1 and V2 evidence separate.
- Make smoke scripts record the executable version rather than print constants.
- Update installation and model-gateway docs only after verification.

## Required Test Matrix

### Static And Unit

- Installed V2 package directory loads.
- Every Relay tool registers with a strict schema and accepted result shape.
- Cleanup stops timers, streams and RPC registrations once.
- V1 dual entrypoint still passes existing tests.
- Config normalisation preserves permissions, MCP, agents, providers and models.

### Server And TUI

- One server with two TUI panes on different sessions.
- Exact-pane mutation confirmation and completion toast.
- Pane switch during pending confirmation.
- TUI exit/reconnect with pending notification.
- Server reload while clients stay attached.
- Plugin disable/re-enable cleanup.

### Native Session

- Create/verify a session in an exact location.
- Admit one exact-ID prompt and observe terminal success.
- Detect concurrent foreign input.
- Reconcile a lost prompt response without replay.
- Reject replaced location, project or session.
- Interrupt owned execution and prove terminal interruption.
- Recover after Relay service restart.

### Relay Workflows

- Task reads and every human task mutation.
- Delegation with no-review and human-review policies.
- Candidate approve/reject/feedback.
- Clarification question/answer.
- Folder and managed-headless routines.
- Quiet no-action suppression.
- Task-board detail/review controls.

### Live Smokes

1. Disposable interactive bridge.
2. Two-pane shared-server identity test.
3. Dedicated managed V2 runtime.
4. Paperclip publication and completion.
5. Review accept and reject.
6. TWD inbox manual occurrence.
7. Owned-runtime cancellation.
8. Notification return to the originating TWD pane.

## Cutover Gates

- [ ] V2 server plugin loads every Relay tool.
- [ ] V2 TUI plugin loads in Herdr panes.
- [ ] Exact confirmation works with two clients on one server.
- [ ] Managed launch, prompt, settlement and interruption pass.
- [ ] Folder and exact routines pass.
- [ ] TWD inbox smoke does not prompt the active TWD chat.
- [ ] Heddle is ported or deliberately disabled.
- [ ] Legacy Envoy is removed from active discovery.
- [ ] Herdr integration reports current version.
- [ ] LiteLLM model, tool, media and context limits are verified.
- [ ] Full Relay suite passes apart from recorded unrelated failures.
- [ ] Rollback is rehearsed with preserved V1 config and binary.

## Proposed Cutover

1. Pause recurring jobs that could launch OpenCode runtimes.
2. Confirm all Relay-native runs are settled.
3. Back up V1 config, TUI config, auth state, plugins and executable path.
4. Install V2 under an isolated command/path and run the smoke matrix.
5. Start V2 once to migrate terminal-client preferences.
6. Install Herdr OpenCode integration v13.
7. Enable V2 Relay server and TUI plugins.
8. Verify tools, pane identity and notifications.
9. Run interactive and managed smokes.
10. Resume schedules only after success.
11. Keep V1 rollback artefacts until a scheduled occurrence completes.

## Rollback

1. Pause new scheduled work.
2. Settle or cancel V2-native Relay runs with exact evidence.
3. Stop V2 services and clients.
4. Restore V1 binary and V1 configuration.
5. Restore V1 Relay and Heddle registrations.
6. Verify the Herdr integration for V1.
7. Restart OpenCode and Relay services.
8. Verify enrolment, tools, managed launch and notifications.
9. Resume schedules only after a V1 smoke.

V1 and V2 share configuration locations. Native V2-only config must not overwrite
the last known-good V1 files before rollback is no longer required.

## Latest OpenCode 2 Additions

OpenCode `2.0.27` was latest during this assessment. Current highlights include:

- built-in `worktree_create`, `worktree_list` and `worktree_remove` tools;
- confirmation and `--yes` support for remote pairing;
- installable web application support;
- visible failures before or between model steps;
- automatic hiding/restoration of missing projects;
- 500,000-token ChatGPT OAuth input for supported GPT-6.1 models;
- Vertex AI routes for Interactions and Mistral;
- Google Cloud ADC/gcloud support for Vertex;
- faster, crash-tolerant snapshots and storage packing;
- safer working-tree diff and revert handling;
- improved transcript hyperlinks;
- shared service, typed clients, plugin RPC and dedicated CLI plugin APIs.

These are useful improvements. They do not remove the migration requirement. Port
Relay first, then upgrade the primary runtime.

## Recommendation

Treat OpenCode 2 support as a dedicated compatibility milestone. Do not hide it
behind path aliases or a few HTTP route conditionals. Shared-server pane authority is
architectural and Relay's security guarantees depend on handling it explicitly.

The first deliverable should be a V2 spike with:

1. one server plugin exposing a read-only Relay tool;
2. one pane-local TUI plugin displaying a toast;
3. typed RPC between them;
4. one managed session with exact prompt/settlement proof;
5. a two-pane test proving authority does not cross sessions.

Only after that spike passes should the complete workflow port begin.
