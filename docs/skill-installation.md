# Native Relay skill installation and updates

RC7 development adds management of the shipped `herdr-relay` and `relay-work`
OpenCode skills. This is not yet a published RC7 feature. The packaged native
skills no longer describe legacy Paperclip commands as the native workflow.
Legacy provisioning uses the retained historical work protocol separately.

```bash
herdr-relay skills status
herdr-relay skills install --dry-run
herdr-relay skills install
```

Use `--config-dir /absolute/opencode-config` for a non-default OpenCode configuration
directory. The default honours `XDG_CONFIG_HOME`, then `~/.config/opencode`.
No backend credentials or running node are required.

- `status` and `install --dry-run` do not write files or restart anything.
- Installation manages only `skills/herdr-relay/SKILL.md`,
  `skills/relay-work/SKILL.md` and their private ownership receipts.
- Missing skills are installed. Identical existing content is safely adopted.
- A managed skill whose installed hash still matches its receipt can be updated.
  Its previous bytes are retained in a mode-0600 backup.
- Unmanaged differing content, local modifications, symlinks and invalid receipts
  are conflicts. A conflict prevents the whole pair from being updated. Other
  skills and extra files in these skill directories are never removed.
- When the operator explicitly wants to replace differing regular-file content:

  ```bash
  herdr-relay skills install --replace-modified
  ```

  This retains the existing bytes in private backups. It does not replace symlinks
  or bypass invalid management receipts. Inspect those conflicts separately.

## Automatic synchronisation

The RC7 `release install` CLI and `node install` synchronise skills using the safe
default rules. Their JSON includes the skill result. `skill_conflict` means the
skill files were preserved, not that the installed instructions are current.
It does not erase an otherwise successful CLI/service installation.

`release install --config-dir DIR` selects the OpenCode configuration directory
for its skill sync. Node installation uses the installing user's normal
OpenCode configuration directory, honouring `XDG_CONFIG_HOME`.

Older CLIs cannot run new installer code. On the first transition from RC6, activate
the new CLI, then run `herdr-relay skills install` once explicitly, or install the
node using that new CLI. Future CLI installations executed by the new installer
perform the same sync automatically. An `npm install --ignore-scripts` alone does
not run this installer. Service upgrade is not an implicit skill synchronisation.

## Running agent contexts

The installer never restarts OpenCode, human chats, nodes or active workers. Files
being current does not prove an existing model context reloaded those instructions.
Start a fresh context or use a supported OpenCode skill reload. Do not interrupt
work just to refresh documentation.
