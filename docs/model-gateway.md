# Local Model Gateway

The optional LiteLLM gateway is separate from Relay. It exposes an authenticated,
OpenAI-compatible API at `http://127.0.0.1:4000/v1`. Installing it does not change
existing worker model settings or expose the API to other machines.

## Install

Requirements: Linux, systemd user services, Node.js 24+ and `uv`. The pinned Python
3.12 environment and dependency hashes are in `services/litellm/uv.lock`.

```bash
node services/litellm/install.mjs
```

The installer creates a private `.litellm/` directory, generates a gateway key
once, synchronises the locked dependencies, and enables/restarts
`herdr-relay-litellm.service`. Re-running it preserves local configuration and
credentials. The checkout must remain at the same path while the service runs.
After moving it, run the installer again.

The first installation copies `services/litellm/config.example.yaml` when no local
configuration exists. This template has no models. Add provider/model definitions
to `.litellm/config.yaml` before using the gateway. Set provider environment
variables in `.litellm/service.env`, using one `NAME=value` per line, without
`export`. Keep `LITELLM_MASTER_KEY` in that file.

The whole `.litellm/` directory is ignored. Provider integration code, model lists,
catalogues, authentication material and local notes belong there, not in tracked
service files. Do not force-add it. Directory permissions are `0700`, and the
configuration and environment files are `0600`. The unit uses `UMask=0077`.
Local provider setup and any machine-specific adaptations should be documented in
`.litellm/README.md`, alongside the ignored configuration.

Boot-time startup requires lingering:

```bash
loginctl show-user "$USER" -p Linger
# If disabled, an administrator can enable it:
loginctl enable-linger "$USER"
```

On WSL this means startup when the Linux instance starts, not necessarily when
Windows boots. The service restarts on failure, with five start attempts per minute.
After correcting repeated startup failures, run `systemctl --user reset-failed
herdr-relay-litellm.service` before restarting.

## Operate

```bash
systemctl --user status herdr-relay-litellm.service
systemctl --user restart herdr-relay-litellm.service
journalctl --user -u herdr-relay-litellm.service -n 50 --no-pager
services/litellm/.venv/bin/python services/litellm/verify.py
# Optional: one small real inference request per configured model, consuming usage.
services/litellm/.venv/bin/python services/litellm/verify.py --inference
```

Clients use the base URL above and the `LITELLM_MASTER_KEY` from the private
environment file as their API key. Select an explicit model returned by
`GET /v1/models`. Responses-only models use `POST /v1/responses`. Other chat models
use `POST /v1/chat/completions`. Model availability does not imply that the
upstream provider accepts every API protocol.

Verification checks liveness, rejected missing/invalid credentials and the exact
configured model list. The optional inference check also checks actual generated
content for every model. Liveness alone does not verify upstream authentication.
Without a database, LiteLLM returns HTTP 400 (`no_db_connection`) for unknown keys
and HTTP 401 for missing keys. The verification accepts that specific rejection,
not arbitrary HTTP errors. Prisma is installed because LiteLLM 1.104.0's auth
error handler imports it unconditionally, even without a database connection.

By default there is no database or enabled admin UI. The optional dashboard setup
below adds PostgreSQL. The gateway never listens publicly. LiteLLM telemetry is
disabled, and model cost metadata comes from the pinned package rather than a
startup download. There are no automatic dependency or model-list updates.

## Admin Dashboard

The dashboard requires a database. To enable it with a dedicated, digest-pinned
PostgreSQL 17 container, install Docker with Compose and run:

```bash
node services/litellm/enable-admin.mjs
services/litellm/.venv/bin/python services/litellm/verify.py --admin
```

On initial setup, open <http://localhost:4000/ui/>. The bootstrap username is `admin`. The generated password
is `UI_PASSWORD` in `.litellm/service.env`, separate from the gateway API key.
To display only the dashboard password in your own terminal:

```bash
node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(readFileSync(".litellm/service.env", "utf8").split("\n").find(line => line.startsWith("UI_PASSWORD=")).slice(12))'
```

The enable script preserves existing credentials on repeat runs, starts the
database, generates the Prisma client, and restarts LiteLLM with UI login enabled.
It refuses to replace an unrelated database URL. The private environment file
overrides the unit's default `DISABLE_ADMIN_UI=True`. Initial database migrations
run on service startup, and migration failure prevents startup.

PostgreSQL listens only on `127.0.0.1:5433` and stores data in the Docker volume
`herdr-relay-litellm_postgres-data`. Database credentials are in the ignored
`.litellm/database.env`. Back up the volume and private `LITELLM_SALT_KEY` together.
The database stores users, virtual keys and usage records. Treat it as private.
Do not use `docker compose down -v` unless you intend to erase that data.

Docker must be running before the gateway starts. On Docker Desktop, enable its
startup setting. If the gateway exhausted its startup retries while Docker was
unavailable, start Docker, then run:

```bash
docker compose -f services/litellm/compose.yaml up -d --wait
systemctl --user reset-failed herdr-relay-litellm.service
systemctl --user restart herdr-relay-litellm.service
```

The environment login is a single local administrator account. Before sharing
access, follow [LiteLLM's per-user account setup](https://docs.litellm.ai/docs/proxy/ui)
and disable environment credential login. Create a `proxy_admin` user, set their
password through an invitation, verify login, then set:

```yaml
general_settings:
  disable_env_credential_login: true
  trusted_proxy_ranges: []
```

Merge these into the existing settings rather than replacing the file. Remove
`UI_USERNAME` and `UI_PASSWORD` from the private environment and restart the
service. The enable script honours this setting on repeat runs and does not
recreate shared credentials. The master key continues to work for API access,
but cannot sign in to the dashboard.

With personal login enabled, `verify.py --admin` reads username/password from
the ignored `.litellm/admin-login.json` if present, otherwise prompts for them.
It verifies administrator access, wrong-password and master-key login rejection,
and the disabled warning flag. The current machine's login details are documented
in `.litellm/README.md`. Store the password in your password manager. If you change
it, update or remove the local verification credentials file.

Existing provider definitions remain
in the private YAML, not moved into the database by this installer.

## Coding Harnesses

The local setup supports OpenCode, Hermes, Codex CLI, Claude Code and GitHub
Copilot CLI. Each receives its own inference-only virtual key and non-admin
service user. No harness receives the master key or dashboard password.

### Install Missing Clients

These versions were verified on Linux ARM64 on 2026-10-05 with Node.js 24:

| Client | Verified version | Installation |
| --- | --- | --- |
| OpenCode | 1.18.27 | `npm install -g opencode-ai@1.18.27` |
| Codex CLI | 0.160.0 | `npm install -g @openai/codex@0.160.0` |
| Claude Code | 2.1.289 | `npm install -g @anthropic-ai/claude-code@2.1.289` |
| Copilot CLI | 1.0.91 | `npm install -g @github/copilot@1.0.91` |
| Hermes | 0.21.5+7075.g404ab00 | Official source installer, commit `404ab00de` |

Install only missing clients rather than replacing an existing managed install.
For Hermes, download and review the official installer before executing it:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o /tmp/hermes-install.sh
less /tmp/hermes-install.sh
bash /tmp/hermes-install.sh --commit 404ab00de --non-interactive --skip-browser --skip-computer-use
```

The skipped components are optional browser/computer-use tooling, not coding
tools. Hermes installs its own managed runtime and launcher in `~/.local/bin`.
The source installer also updates shell PATH. Run each client's `--version` to
verify installation. Follow the package manager's package-specific script
approval process if installation scripts are blocked; do not globally disable
script protections.

### Issue Keys And Configure

The gateway must have its database connected. Run from this checkout:

```bash
services/litellm/.venv/bin/python services/litellm/harness-keys.py
services/litellm/.venv/bin/python services/litellm/configure-harnesses.py
```

The first script creates `local-opencode`, `local-hermes`, `local-codex`,
`local-claude` and `local-copilot` keys, stored individually under
`~/.config/litellm/keys/`. The directory is `0700` and files are `0600`. Keys
are registered with `key_type: llm_api` and an explicit model allowlist. Claude
Code gets Claude models only; the others get the current gateway model list.
No expiration or monetary budget is imposed. These keys do not expire until
revoked, and upstream plan limits still apply. The script never prints tokens.

Repeat key provisioning reuses the same local tokens, reconciles registration
by SHA-256 hash, and checks model-list access and management-route rejection.
It does not silently replace revoked keys or broaden changed model allowlists.
New gateway models require an explicit key-allowlist update in the admin UI.

The configuration script changes user-level defaults, not just this repository.
It preserves unrelated configuration values and stores first-run backups under
the ignored `.litellm/harness-backups/`. YAML comments/formatting are normalised.
OpenCode must use JSON at `~/.config/opencode/opencode.json`; reconcile any separate
JSONC configuration before using the script. Restart existing harness sessions,
especially OpenCode, after applying configuration.

| Client | Configuration | Credential mechanism | Default / protocol |
| --- | --- | --- | --- |
| OpenCode | `~/.config/opencode/opencode.json` | `{file:.../opencode.key}` | `litellm/gpt-6-astra`, Responses |
| Hermes | `~/.hermes/config.yaml` | Provider `key_cmd` reads `hermes.key` | `gpt-6-astra`, `codex_responses` |
| Codex CLI | `~/.codex/config.toml` | Provider `auth.command` reads `codex.key` | `gpt-6-astra`, Responses |
| Claude Code | `~/.claude/settings.json` | `apiKeyHelper` reads `claude.key` | `claude-sonnet-5.5`, Anthropic Messages |
| Copilot CLI | `~/.local/bin/copilot` launcher | `COPILOT_PROVIDER_API_KEY_COMMAND` reads `copilot.key` | `gpt-6-astra`, Responses |

OpenCode lists all configured models, using `@ai-sdk/openai` for GPT Responses
and per-model `@ai-sdk/anthropic` for Claude Messages. Its small-model default is
`gpt-5.4-mini`. Claude Code's Opus/Sonnet/Haiku aliases map to the configured
Claude versions. Hermes' default provider is Responses-only; to use Claude's
native protocol, configure a separate named `anthropic_messages` provider.

Codex 0.160.0's discovery expects a Codex-specific catalogue, which the pinned
gateway does not return. The script disables remote catalogue discovery and
writes a local, gateway-filtered copy of `codex debug models --bundled` to
`~/.codex/litellm-models.json`. GPT-6 Astra is the default because that version
ships its native metadata. GPT-5.3-Codex inference works, but its metadata is
absent from this Codex release and selecting it produces a fallback warning.
Regenerate the local catalogue after updating Codex or gateway models.

Copilot's environment is scoped to its launcher rather than exported to every
process. Ensure `~/.local/bin` precedes npm's bin directory in PATH. New login
shells on this machine do so. In existing shells run `export PATH="$HOME/.local/bin:$PATH"`
and `hash -r`, then check `command -v copilot`. Directly invoking npm's underlying
binary bypasses this launcher. A pre-existing `~/.copilot/providers.json` registry
can override BYOK environment settings; the script refuses a non-empty registry
rather than silently ignoring it.

These are client defaults, not an enforced network policy. Existing upstream
logins are retained. Explicit CLI flags, project configurations and inherited
authentication environment variables can override client settings. Model calls
use LiteLLM; independent tools such as GitHub MCP and web search do not become
gateway traffic. Copilot BYOK does not require GitHub login, but GitHub-specific
features may still require it. Claude Code currently warns that gateway use
does not support its new free auto-mode classifier billing path.

### Verify And Maintain

```bash
services/litellm/.venv/bin/python services/litellm/verify-harnesses.py
```

This makes a small real request from each installed harness in a temporary
directory, then checks successful request attribution to all five keys in the
local database. It does not claim end-to-end tool execution coverage. Model
identity is checked through gateway records, not the model's self-description.
OpenCode MCPs/plugins and Copilot built-in MCPs are disabled for these tests only.
Normal tool approval/sandbox defaults are not relaxed in persistent settings.

View usage by key alias in the dashboard. To revoke one client, block/delete only
its `local-<client>` key. For rotation, generate a replacement with the same
inference permissions and model restrictions, securely replace its `.key` file,
then restart that client and revoke the old key. Command-backed clients cache
credentials briefly; a restart avoids ambiguity. Do not put tokens into this
document, shell history, CLI arguments, commits or issue reports. Backups and
session logs can contain private information even though config files use helpers.

Sources: [OpenCode providers](https://opencode.ai/docs/providers/#custom-provider),
[Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation/),
[Hermes custom providers](https://hermes-agent.nousresearch.com/docs/integrations/providers#named-custom-providers),
[Codex custom providers](https://developers.openai.com/codex/config-advanced#custom-model-providers),
[Claude Code gateways](https://code.claude.com/docs/en/llm-gateway-connect),
[Copilot BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models),
[LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys).

## Remove

```bash
systemctl --user disable --now herdr-relay-litellm.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/herdr-relay-litellm.service"
systemctl --user daemon-reload
```

This leaves the ignored credentials/configuration and virtual environment intact.
Delete those separately only when they are no longer needed.
If the dashboard database was installed, stop its container separately with
`docker compose -f services/litellm/compose.yaml down`. This preserves its volume.
