# Local Paperclip Service

Installed and verified on Linux ARM64 on 2026-10-05:

- Paperclip `2026.1001.0`, matching Relay's pinned integration baseline.
- Dashboard/API: <http://localhost:3100>, listening only on `127.0.0.1`.
- User service: `paperclipai.service`, enabled with user lingering.
- Embedded PostgreSQL, independent of LiteLLM's Docker database.
- Managed CLI: `~/.local/bin/paperclipai`.
- Private instance data: `~/.paperclip/instances/default/`.

## Install

Requires Node.js 24.11+ and a working systemd user manager. Run as the normal
user, not root. Install the pinned bootstrap CLI, then its managed per-user copy:

```bash
npm install -g paperclipai@2026.1001.0
paperclipai install --version 2026.1001.0 --yes
PAPERCLIP_NO_BROWSER=1 "$HOME/.local/bin/paperclipai" onboard --yes --install-service
"$HOME/.local/bin/paperclipai" service status --json
loginctl show-user "$USER" -p Linger
```

Onboarding creates configuration, secrets, storage and the database, then hands
startup to systemd. Re-running onboarding preserves an existing valid config.
To repair/re-register the unit, use `paperclipai service install`. Enable lingering
with `paperclipai service install --enable-linger` if needed.

The managed store pins the release under `~/.paperclip/cli/installs/`. Its shim
records the Node path, so rerun the managed installer after removing or relocating
that Node installation. Ensure `~/.local/bin` is first in PATH so `paperclipai`
uses the managed copy rather than the npm bootstrap copy.

On WSL, service startup occurs when the Linux instance starts. This does not
guarantee that Windows starts the instance automatically.

## Access And Agents

The instance uses `local_trusted` mode. There is no dashboard password: local
access is trusted. Do not expose port 3100 on the LAN or through a tunnel without
first switching to authenticated mode and reviewing the deployment configuration.

The dashboard initially opens at organisation onboarding. Paperclip installation
alone does not create an organisation, agent, task or automatic work schedule.

On this machine Relay was subsequently installed as `herdr-relay.service`, its
`herdr_relay` external adapter was installed from this checkout, and organisation
`Default` was created using `herdr-relay company provision`. The company ID is
recorded in Relay's `company:default` operation. The
[Herdr observer](herdr-agent-registration.md) is now enabled for all workspaces
in the local default session and registers detected native conversations as
paused, observation-only agents. No work schedules or new harness runtimes are
created by registration. See [organisation bootstrap](agent-provisioning.md#organisation-bootstrap).

The operator backend context is
`~/.local/state/herdr-relay/backend-context.json` with `{"localTrusted":true}`.
Relay permits this unauthenticated board mode only for a loopback backend. The
coordinator still requires its own operator/worker credentials on the private
Unix socket. The CLI is linked from this checkout with `npm link`.

```bash
herdr-relay status
herdr-relay operation inspect company:default
systemctl --user status herdr-relay.service
```

The optional Herdr UI plugin requires Herdr 0.9.3+. Both the client and running
server are now on 0.9.3, and `quintindk.herdr-relay` is linked and enabled.
Its launcher successfully reports Relay health. For another installation:

```bash
herdr plugin link /absolute/path/herdr-relay --enabled
```

The coding harnesses are configured separately to use the
[local LiteLLM gateway](model-gateway.md#coding-harnesses). When creating Paperclip
agents, select the appropriate local adapter and gateway model. The service's
PATH can differ from a terminal. Prefer exact executable paths for Hermes and
the Copilot gateway launcher, such as `~/.local/bin/hermes` and
`~/.local/bin/copilot` expanded to absolute paths in adapter configuration.
No Paperclip agent execution has been verified as part of this service install.

## Operate

```bash
paperclipai service status --json
paperclipai service logs --lines 100
paperclipai service restart --expected-version 2026.1001.0 --json
paperclipai doctor
curl --fail http://127.0.0.1:3100/api/health
```

Use Paperclip's restart command rather than a blunt systemd restart when agents
are active. It coordinates run handover. `service restart --wait` drains active
runs instead. The native unit restarts on process failure and is managed by the
Paperclip CLI; do not maintain a competing unit in this repository.

Doctor currently reports the already-running service's port 3100 as occupied.
This is expected when service status and `/api/health` identify the correct
instance. All other checks passed on this installation.

## Backups

Create a database backup while the service is stable, not concurrently with a
restart:

```bash
paperclipai db:backup --json
```

Backups are compressed SQL under
`~/.paperclip/instances/default/data/backups/`, with 30-day retention configured
by default. The initial backup succeeded. `/api/health` reports backup freshness
and failures. A database dump is not a complete instance backup: also preserve
configuration, `.env`, `secrets/master.key` and `data/storage/` securely. Losing
the encryption key prevents recovery of locally encrypted secrets.

All instance data remains outside the repository. Never commit its secrets,
database, logs or backups.

## Remove

```bash
paperclipai service uninstall
```

This stops/removes the user service but preserves the managed CLI and instance
data. Review `paperclipai uninstall --help` before removing the CLI itself.

Sources: [installation](https://docs.paperclip.ing/guides/getting-started/installation/),
[service management](https://docs.paperclip.ing/reference/cli/service/),
[setup and backup commands](https://docs.paperclip.ing/reference/cli/setup-commands/).
