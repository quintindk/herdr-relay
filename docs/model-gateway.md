# Optional local model gateway

The repository's `services/litellm/` helpers are independent infrastructure, not a
Relay task provider or a requirement for the native product. They are repository-
only tools and are not installed with the Relay release package. Relay's release
tests do not certify a gateway deployment or its upstream model connections.

Existing private `.litellm/` configuration, keys, databases, volumes and systemd
units are not changed by repository cleanup or Relay upgrades.

## Gateway installation and operation

The standalone installer needs Linux, user-systemd, Node.js 24+ and `uv`. It uses
the pinned Python environment in `services/litellm/uv.lock`:

```sh
node services/litellm/install.mjs
systemctl --user status herdr-relay-litellm.service
journalctl --user -u herdr-relay-litellm.service -n 50 --no-pager
services/litellm/.venv/bin/python services/litellm/verify.py
```

The installer is an explicit live gateway administration action, not part of
`herdr-relay plugin install`. It creates private `.litellm/` files, preserves
existing keys/configuration and enables/restarts its own service. The checkout
path must remain valid while that gateway service references it.

The API is loopback-only at `http://127.0.0.1:4000/v1`. The example configuration
has no models. Provider credentials and machine-specific model definitions belong
in ignored private configuration, not tracked examples. Keep directories mode
`0700` and credential/configuration files mode `0600`.

The optional dashboard helper `services/litellm/enable-admin.mjs` configures a
separate PostgreSQL-backed gateway UI. Its credentials, salt and database volume
must be backed up together. Never remove the Docker volume as part of a Relay
cleanup. Read its settings and retained backups before a gateway-specific change.

## Current clients

Configure an installed client's current supported provider/authentication interface
separately. Do not copy historical V1 provider fields, model lists or default-
changing harness scripts into OpenCode V2 configuration. Relay does not require
every coding client to share one gateway or model.

For OpenCode V2, use the [official configuration guide](https://opencode.ai/v2/docs/config)
and the configured connection's authentication flow. Valid configuration changes
reload without restarting OpenCode. A gateway responding successfully does not
prove model authentication, tool execution, Relay enrolment or business coverage.

Use the native [authenticated headless setup](headless-authenticated-setup.md) when
an explicitly approved Relay job should reuse an existing authorised connection.
That flow does not copy a provider credential store or change gateway defaults.
