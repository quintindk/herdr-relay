# Installation and onboarding

This guide is for a **new native installation**. Existing RC4 installations must
use [service upgrades](service-upgrades.md), not bootstrap/reset or re-enrolment.
Examples target 0.2.1 once it is published. Until then use an actual published
version from [GitHub releases](https://github.com/quintindk/herdr-relay/releases).

## Requirements

Use the intended Linux/WSL2 account, Node.js 24+, npm, Git and working user-systemd.
Keep state in the Linux home filesystem, not `/mnt/c`. OpenCode agents need an
installed, authenticated OpenCode V2 service. Release checks cover 2.1.0 and 2.1.2.
Herdr 0.9.3+ is needed for interactive pane provisioning and the panel shortcut.

Do not upgrade/restart OpenCode merely to install Relay. Follow the official
[V2 configuration guide](https://opencode.ai/v2/docs/config) for its own setup.
Credential, agent, model, MCP and permission configuration remain independent.

## 1. Activate the same release on each host

Download the package, `SHA256SUMS` and verification report from the trusted release.
The report must identify the exact source/tag, clean source, supported-host checks
and a successful zero-vulnerability production audit.

```sh
umask 077
sha256sum -c SHA256SUMS
npm install --global --omit=dev --ignore-scripts /absolute/download/herdr-relay-0.2.1.tgz
herdr-relay release install --version 0.2.1
herdr-relay --version
```

Use a user-owned npm installation without sudo. `release install` activates the
versioned CLI and safely synchronises managed skills. It does not upgrade existing
services or authorise live configuration changes. A checkout/npm link is not a
published release installation.

## 2. Install a fresh backend

On the backend host:

```sh
herdr-relay backend install --dry-run
herdr-relay backend install
herdr-relay backend status
```

Defaults are loopback port 3210 and
`~/.local/state/herdr-relay-backend/{backend.sqlite,owner.json}`. The user service
is `herdr-relay-backend.service`. Existing state is reused, never silently cleared.
Keep the root owner credential on this host. Back up existing installations before
explicit maintenance; do not install a fresh backend over an identity mismatch.

## 3. Establish authenticated ingress for remote nodes

Loopback nodes may use `http://127.0.0.1:3210`. Remote nodes need the configured
authenticated HTTPS ingress. Do not expose unauthenticated non-loopback HTTP.
For Cloudflare Access, verify all authentication combinations before joining:

```sh
herdr-relay backend ingress-check --url https://relay.example.com \
  --context "$HOME/.local/state/herdr-relay-backend/owner.json" \
  --access /private/existing-access.env
```

Unauthenticated and actor-only calls must be blocked by Access. Access-only reaches
Relay but is rejected there. Access plus the actor must succeed. Relay's own 401 is
not proof that Access enforced its policy. See [security](security.md).

## 4. Bootstrap each node once

On the backend host, create a private bundle for each host, including a node on the
backend machine if wanted:

```sh
herdr-relay node bootstrap \
  --context "$HOME/.local/state/herdr-relay-backend/owner.json" \
  --key workstation-node-v1 --name Workstation \
  --url http://127.0.0.1:3210 --local-user \
  --output /private/Workstation.bundle.json
```

For a remote host use its reachable HTTPS URL and the configured transport/access
file. Select `--local-user` deliberately, or use explicit `--root /absolute/folder`
arguments for a narrower node/workspace scope. Paths belong to the destination
host, not necessarily the backend host.

Each bundle contains distinct node-daemon and scoped human/operator credentials,
the backend instance and transport settings, **not the backend-root credential**.
Transfer only that node's bundle using an existing private mechanism. Keep it mode
`0600`. The same key/request reconciles the original bundle; changed payloads conflict.

## 5. Join and start the node

On its destination host:

```sh
herdr-relay node join --bundle /private/Workstation.bundle.json
herdr-relay native node install \
  --config "$HOME/.local/state/herdr-relay-native/node.json"
herdr-relay plugin install
herdr-relay doctor
```

Join defaults to `~/.local/state/herdr-relay-native/` and writes private `node.json`
and `operator.json` files. It refuses incompatible existing state rather than
deleting a journal. The node service name includes the actual generated node ID.
Plugin installation preserves unrelated preferences and retains backups.

On WSL2, systemd and the user manager must be available. A stopped WSL instance
cannot execute local cron ticks; schedules do not automatically fail over. User
lingering is an explicit OS administration choice, not a Relay installation effect.

## 6. Enrol and use receiving chats

Use `/relay-enrol` in an intended OpenCode workspace. It creates a durable
workspace/role agent and attaches the exact receiving chat. Use `/relay-attach` for
a replacement chat rather than creating another agent. Enrolment alone does not
dispatch work, change model permissions or grant provisioning authority.

```sh
herdr-relay tui
herdr-relay node status
herdr-relay doctor
```

Verify distinct node identities, the expected shared backend instance and actual
receiving-chat state. Directory presence is advisory, not execution admission.
See [receiving chats](native-receivers.md) and [the board](task-board.md).

## 7. Optional Herdr panel

Link the **installed release directory** through Herdr, not a moving checkout:

```sh
herdr plugin link /absolute/installed/herdr-relay
herdr-relay plugin shortcut --dry-run
herdr-relay plugin shortcut
herdr server reload-config
```

The installer requires Python 3.11+, refuses a conflicting `prefix+t` binding and
preserves other keys. The shortcut opens/focuses the native board and restores the
original pane when closed. No OpenCode restart is required.
