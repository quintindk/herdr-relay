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

No database, public listener or admin UI is configured. LiteLLM telemetry is
disabled, and model cost metadata comes from the pinned package rather than a
startup download. There are no automatic dependency or model-list updates.

## Remove

```bash
systemctl --user disable --now herdr-relay-litellm.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/herdr-relay-litellm.service"
systemctl --user daemon-reload
```

This leaves the ignored credentials/configuration and virtual environment intact.
Delete those separately only when they are no longer needed.
