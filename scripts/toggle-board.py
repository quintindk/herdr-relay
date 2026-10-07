"""Toggle the Relay task board in the invoking Herdr tab."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

PLUGIN = "quintindk.herdr-relay"


def herdr(*args):
    process = subprocess.run(
        [os.environ.get("HERDR_BIN_PATH", "herdr"), *args],
        capture_output=True, text=True, timeout=15, check=False,
    )
    if process.returncode:
        raise RuntimeError("Herdr command failed: " + " ".join(args[:3]))
    response = json.loads(process.stdout)
    if "error" in response:
        raise RuntimeError(response["error"].get("code", "herdr_error"))
    return response["result"]


def toggle():
    if os.environ.get("HERDR_ENV") != "1":
        raise RuntimeError("Invoke this action from a Herdr pane.")
    state_dir = Path(os.environ["HERDR_PLUGIN_STATE_DIR"])
    state_dir.mkdir(parents=True, exist_ok=True)
    session = hashlib.sha256(os.environ["HERDR_SOCKET_PATH"].encode()).hexdigest()[:16]
    path = state_dir / f"board-{session}.json"
    # Stable advisory lock serialises repeated shortcuts, including across processes.
    with (state_dir / f"board-{session}.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        context = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
        target = context.get("focused_pane_id") or os.environ.get("HERDR_PANE_ID")
        if not target:
            raise RuntimeError("No invoking pane available.")
        anchor = herdr("pane", "get", target)["pane"]
        panes = herdr("pane", "list")["panes"]
        saved = json.loads(path.read_text()) if path.exists() else []
        live = [pane for pane in panes if any(
            item["pane_id"] == pane["pane_id"] and item["terminal_id"] == pane["terminal_id"]
            for item in saved
        )]

        def save():
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps([
                {"pane_id": pane["pane_id"], "terminal_id": pane["terminal_id"]}
                for pane in live
            ]))
            temporary.replace(path)

        existing = [pane for pane in live if pane["tab_id"] == anchor["tab_id"]]
        if existing:
            for pane in existing:
                herdr("plugin", "pane", "close", pane["pane_id"])
                live.remove(pane)
                save()
            return
        layout = herdr("pane", "layout", "--pane", target)["layout"]
        if layout["zoomed"]:
            raise RuntimeError("Unzoom the pane before opening Relay tasks.")
        rect = next(pane["rect"] for pane in layout["panes"] if pane["pane_id"] == target)
        direction = "right" if rect["width"] >= 160 else "down"
        opened = herdr(
            "plugin", "pane", "open", "--plugin", PLUGIN, "--entrypoint", "work",
            "--placement", "split", "--target-pane", target, "--direction", direction,
            "--cwd", anchor["cwd"], "--no-focus",
        )["plugin_pane"]["pane"]
        live.append(opened)
        try:
            save()
        except Exception:
            herdr("plugin", "pane", "close", opened["pane_id"])
            raise


if __name__ == "__main__":
    try:
        toggle()
    except (RuntimeError, OSError, ValueError, KeyError, StopIteration, subprocess.TimeoutExpired) as error:
        print(f"Relay tasks: {error}", file=sys.stderr)
        sys.exit(1)
