# Backend and node topology

Relay has one public executable, `herdr-relay`, and two independently managed roles:

| Role | Responsibility | Current placement |
| --- | --- | --- |
| Backend | Durable tasks, messages, reviews, credentials and event history | Evo |
| Node | Local enrolled-agent delivery, journals and authorised scheduling | Evo and Surface |

Both roles use the same release package. They run as separate user services with
separate state, credentials and failure/restart boundaries. A node is a Relay
participant, not the nodejs runtime. Multiple enrolled workspace agents share one
node service. They do not each require a backend or SSH connection.

Nodes connect to the authenticated shared backend. Surface uses WSL2/systemd and
the existing HTTPS/Access endpoint. Its scoped credentials are not Evo's backend-root
credential. Offline work and uncertain publications stay in the node journal.

Use [installation and onboarding](installation-and-onboarding.md) for first join,
and [service upgrades](service-upgrades.md) for compatible maintenance afterwards.
An upgrade is not a reset, bootstrap, join or enrolment operation.

## Retired SSH transport

As of RC5, `herdr-relay-remote`, the SSH remote adapter, `adapter-stdio` framing and
the SSH smoke launcher are removed. Stale `relayNodeFile` configuration is rejected
with `legacy_remote_retired`, without reading its credential file, spawning SSH or
falling back to local execution.

Earlier SSH evidence is historical only. The local Paperclip compatibility adapter
and read-only task export/migration support are separate and have not been silently
deleted. This retirement does not modify Surface's Paperclip instance or its data.
