# Inbox, source checkpoints and service installation

## Source events

Workers can publish receipt-only events independently of a Paperclip work run:

```bash
herdr-relay --context monitor.json event checkpoint --source inbox-fixture
herdr-relay --context monitor.json event record --file event.json
herdr-relay --context driver.json inbox list
herdr-relay --context driver.json inbox acknowledge EVENT_ID
```

```json
{
  "source": "inbox-fixture",
  "eventId": "message-123",
  "expectedCursor": null,
  "cursor": "page-1",
  "recipient": "daily-driver",
  "summary": "A customer requested a demo",
  "reference": "fixture://message/123"
}
```

The event and checkpoint commit atomically. Identical source-event retries return
the same receipt, changed retries conflict, and checkpoint updates compare the
previous cursor. Sender and recipient must belong to the same company. An event
does not automatically create a task. The receiving agent decides what needs work.
Inbox records are integration notifications, not a second task database.

The connector owns source access and scheduling. Production email/Teams connectors,
operating-window enforcement and scheduling lifecycle are not implemented yet.

## Herdr actions

The plugin provides service status, peer discovery and a work overview. The overview
separates delivery, native state, outcome, publication, questions and review:

```bash
herdr-relay view
herdr plugin action invoke --help
```

The `work` plugin pane refreshes the report, supports j/k selection and Enter for
details, and reconnects when Relay is unavailable. Open it with:

```bash
herdr plugin pane open --plugin synthswarm.herdr-relay --entrypoint work \
  --placement split --target-pane YOUR_PANE_ID --direction right --no-focus
```

The launcher resolves Node from `RELAY_NODE`, PATH or a local NVM installation.
Herdr's server PATH may differ from an interactive shell. The pane was opened,
its unavailable-service state inspected, and the temporary pane/link removed on
Herdr `0.9.3`. Runtime placement restoration remains pending.

## Linux user service

Generate a systemd user unit with absolute paths:

```bash
node src/cli.mjs service-unit --paperclip-url http://127.0.0.1:3100
```

Save the output as `~/.config/systemd/user/herdr-relay.service`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now herdr-relay.service
systemctl --user status herdr-relay.service
```

The service restarts on failure and survives closing a herdr pane. Its state uses
restricted permissions and remains separate from the UI. The generated paths point
to the current Node executable and checkout, so regenerate after moving either.
User-manager persistence across logout depends on the host's login/linger setup.

`node scripts/installation-smoke.mjs` validates the generated unit using the local
systemd parser without installing or starting it. macOS supervision is pending.
