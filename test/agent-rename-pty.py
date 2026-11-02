"""Exercise the native rename through a disposable TUI, never the human's state."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
env = {**os.environ, "HOME": root, "XDG_STATE_HOME": root + "/state",
       "XDG_CONFIG_HOME": root + "/config", "TERM": "xterm-256color"}
process = subprocess.Popen([node, cli, "tui", "--context", context],
                           stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
output = bytearray()


def wait_for(text):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if text.encode() in output:
            return
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
    readable = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output).decode("utf-8", "replace")
    raise AssertionError(f"TUI did not show {text!r}: {readable[-3000:]!r}")


def send(data):
    output.clear()
    os.write(master, data)


try:
    wait_for("RELAY / TASKS")
    send(b"\t")
    wait_for("RELAY / AGENTS")
    wait_for("n rename")
    send(b"j")
    wait_for("Original")
    send(b"n")
    wait_for("Rename Relay agent")
    wait_for("Edit name")
    send(b"\x15")
    wait_for("Edit name (0/256)")
    send(b"PTY Documentation")
    wait_for("PTY Documentation")
    send(b"\r")
    wait_for("Confirm agent rename")
    send(b"\r")
    wait_for("Agent renamed to")
    send(b"q")
    process.wait(timeout=5)
    assert process.returncode == 0
    print(json.dumps({"confirmed": True, "realTuiKeyboard": True}))
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
