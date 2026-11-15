"""Read an owner message through the actual native TUI. Fixture state only."""
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

node, cli, context, root = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 120, 0, 0))
child = subprocess.Popen([node, cli, "tui", "--context", context], stdin=slave, stdout=slave, stderr=slave,
                         env={**os.environ, "HOME": root, "XDG_STATE_HOME": root + "/state", "XDG_CONFIG_HOME": root + "/config",
                              "TERM": "xterm-256color", "CI": "false", "CONTINUOUS_INTEGRATION": "false", "FORCE_COLOR": "1"})
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
    text = until("OWNER_BODY_05...")
    assert "OWNER_BODY_06" not in text and "OWNER_BODY_40" not in text
    assert "Owner message sender" in text
    send(b"\r")
    until("Mark message read")
    send(b"\x1b[F")
    until("OWNER_BODY_40")
    send(b"\x1b")
    until("m mark read")
    send(b"m")
    text = until("Message marked read")
    assert "Confirm this exact decision" not in text and "Enter confirm" not in text
    send(b"q")
    child.wait(timeout=5)
    assert child.returncode == 0
    print(json.dumps({"directReadWithoutConfirmation": True, "realTuiKeyboard": True}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
