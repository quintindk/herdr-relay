"""Explicit, conflict-aware installation of the native Relay toggle binding."""
import argparse
import json
import os
from pathlib import Path
import stat
import sys
import tomllib
import uuid

BINDING = {"key": "prefix+t", "type": "plugin_action", "command": "quintindk.herdr-relay.toggle", "description": "Toggle Relay TUI"}


def install(path, dry_run=False):
    path = Path(path).expanduser().absolute()
    if path.is_symlink():
        raise ValueError("Select the real Herdr configuration file, not a symlink")
    source = path.read_bytes().decode() if path.exists() else ""
    keys = tomllib.loads(source).get("keys", {})
    if not isinstance(keys, dict):
        raise ValueError("Herdr keys must be a table")
    commands = keys.get("command", [])
    if not isinstance(commands, list) or not all(isinstance(item, dict) for item in commands):
        raise ValueError("Herdr keys.command must be an array of tables")
    matches = [item for item in commands if item.get("key") == BINDING["key"]]
    if len(matches) > 1 or any(item.get("type") != BINDING["type"] or item.get("command") != BINDING["command"] for item in matches):
        raise ValueError("prefix+t already has another binding. Existing preferences were not changed")
    if matches:
        return {"state": "existing", "path": str(path), "binding": BINDING, "changed": False}
    after = source + ("" if source.endswith("\n") else "\n") + "\n[[keys.command]]\n" + "".join(f"{key} = {json.dumps(value)}\n" for key, value in BINDING.items())
    tomllib.loads(after)
    result = {"state": "shortcut_preview" if dry_run else "installed", "path": str(path), "binding": BINDING, "changed": not dry_run,
              "instruction": "Link the installed Relay Herdr plugin, then run herdr server reload-config. No OpenCode restart is required."}
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
        if path.exists():
            backup = path.with_name(path.name + ".relay-backup-" + str(uuid.uuid4()))
            with backup.open("xb") as stream:
                os.chmod(backup, mode)
                stream.write(source.encode())
            result["backup"] = str(backup)
        temporary = path.with_name(path.name + ".relay-" + str(uuid.uuid4()))
        with temporary.open("x") as stream:
            os.chmod(temporary, mode)
            stream.write(after)
            stream.flush()
            os.fsync(stream.fileno())
        if (path.read_bytes().decode() if path.exists() else "") != source:
            temporary.unlink()
            raise ValueError("Herdr configuration changed during installation; inspect and retry")
        temporary.replace(path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--herdr-config", default=os.environ.get("HERDR_CONFIG_PATH", str(Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "herdr/config.toml")))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.herdr_config, args.dry_run)))
    except (OSError, ValueError) as error:
        print(json.dumps({"state": "refused", "error": str(error)}), file=sys.stderr)
        sys.exit(1)
