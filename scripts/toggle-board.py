"""Toggle the Relay task board in the invoking Herdr tab."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import socket
import uuid

PLUGIN = "quintindk.herdr-relay"
PLUGIN_ROOT = Path(__file__).resolve().parent.parent


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


def focus(pane_id):
    """Protocol 22 pane.focus targets an exact pane, unlike directional CLI focus."""
    request_id = str(uuid.uuid4())
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(15)
        connection.connect(os.environ["HERDR_SOCKET_PATH"])
        connection.sendall((json.dumps({"id": request_id, "method": "pane.focus",
                                        "params": {"pane_id": pane_id}}) + "\n").encode())
        with connection.makefile("rb") as stream:
            line = stream.readline(1024 * 1024)
        response = json.loads(line)
        if response.get("id") != request_id or "error" in response or "result" not in response:
            raise RuntimeError("Herdr focus was not confirmed")


def restore(return_to, board=None):
    panes = herdr("pane", "list")["panes"]
    if board and not any(p["pane_id"] == board and p.get("focused") for p in panes):
        return  # Do not steal focus if the human has already moved elsewhere.
    target = next((p for p in panes if all(p.get(k) == return_to.get(k)
                  for k in ("pane_id", "terminal_id", "tab_id"))), None)
    if target:
        focus(target["pane_id"])


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
        for pane in live:
            record = next(item for item in saved if item["pane_id"] == pane["pane_id"] and item["terminal_id"] == pane["terminal_id"])
            if record.get("return_to"):
                pane["return_to"] = record["return_to"]

        def save():
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps([
                {"pane_id": pane["pane_id"], "terminal_id": pane["terminal_id"],
                 **({"return_to": pane["return_to"]} if pane.get("return_to") else {})}
                for pane in live
            ]))
            temporary.replace(path)

        existing = [pane for pane in live if pane["tab_id"] == anchor["tab_id"]]
        if existing:
            for pane in existing:
                if pane.get("return_to"):
                    restore(pane["return_to"], pane["pane_id"])
                herdr("plugin", "pane", "close", pane["pane_id"])
                live.remove(pane)
                save()
            return
        layout = herdr("pane", "layout", "--pane", target)["layout"]
        if layout["zoomed"]:
            raise RuntimeError("Unzoom the pane before opening Relay tasks.")
        rect = next(pane["rect"] for pane in layout["panes"] if pane["pane_id"] == target)
        direction = "right" if rect["width"] >= 160 else "down"
        return_to = {key: anchor[key] for key in ("pane_id", "terminal_id", "tab_id")}
        opened = herdr(
            "plugin", "pane", "open", "--plugin", PLUGIN, "--entrypoint", "native-work",
            "--placement", "split", "--target-pane", target, "--direction", direction,
            "--cwd", str(PLUGIN_ROOT), "--focus", "--env", "RELAY_RETURN_PANE=" + json.dumps(return_to),
        )["plugin_pane"]["pane"]
        opened["return_to"] = return_to
        live.append(opened)
        try:
            save()
        except Exception:
            herdr("plugin", "pane", "close", opened["pane_id"])
            raise


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--restore"]:
            if os.environ.get("HERDR_ENV") == "1" and os.environ.get("RELAY_RETURN_PANE"):
                restore(json.loads(os.environ["RELAY_RETURN_PANE"]), os.environ.get("HERDR_PANE_ID"))
        elif not sys.argv[1:]:
            toggle()
        else:
            raise RuntimeError("Use no arguments or --restore")
    except (RuntimeError, OSError, ValueError, KeyError, StopIteration, subprocess.TimeoutExpired) as error:
        print(f"Relay tasks: {error}", file=sys.stderr)
        sys.exit(1)
