"""Exercise Inbox list previews and direct read against fixture backends only."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

node, cli, context, root, kind = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 120, 0, 0))
child = subprocess.Popen([node, cli, "tui", "--context", context], stdin=slave, stdout=slave, stderr=slave,
                         env={**os.environ, "HOME": root, "XDG_STATE_HOME": root + "/state",
                              "XDG_CONFIG_HOME": root + "/config", "TERM": "xterm-256color",
                              "CI": "false", "CONTINUOUS_INTEGRATION": "false", "FORCE_COLOR": "1"})
os.close(slave)
output = bytearray()


def readable():
    return re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output).decode("utf-8", "replace")


def until(marker):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        text = readable()
        if marker in text:
            return text
        if select.select([master], [], [], 0.05)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output.extend(chunk)
    raise AssertionError(f"TUI did not show {marker!r}: {readable()[-3500:]!r}")


def send(keys):
    output.clear()
    os.write(master, keys)
    time.sleep(0.05)


try:
    until("RELAY / TASKS")
    send(b"\t")
    until("RELAY / AGENTS")
    send(b"\t")
    until("RELAY / INBOX")
    until("KEEP_QUESTION_OPEN")
    send(b"m")
    until("Select an informational result or reminder")
    send(b"/")
    until("Enter apply")
    send(b"preview-job" if kind == "result" else b"REMINDER_ENTRY")
    send(b"\r")
    if kind == "result":
        text = until("PREVIEW_05...")
        assert "PREVIEW_01" in text
        assert "PREVIEW_06" not in text and "PREVIEW_40" not in text
        send(b"\r")
        until("Mark result read")
        send(b"\x1b[F")
        until("PREVIEW_40")
        send(b"\x1b")
        until("m mark read")
    else:
        until("REMINDER_ENTRY")
    send(b"m")
    text = until("Result marked read" if kind == "result" else "Reminder marked read")
    assert "Confirm this exact decision" not in text
    assert "Enter confirm" not in text
    send(b"q")
    child.wait(timeout=5)
    assert child.returncode == 0
    print(json.dumps({"kind": kind, "directReadWithoutConfirmation": True, "realTuiKeyboard": True}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
