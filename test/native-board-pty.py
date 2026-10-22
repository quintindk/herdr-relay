"""Read-only native board PTY probe. Never controls an existing user terminal."""
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

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], "native", "board", "--context", sys.argv[3]],
                         stdin=slave, stdout=slave, stderr=slave,
                         # This child has a real disposable PTY. Ink otherwise suppresses
                         # interactive rendering when the test runner inherits CI=true.
                         env={**os.environ, "CI": "false", "CONTINUOUS_INTEGRATION": "false", "FORCE_COLOR": "1"})
os.close(slave)
data = bytearray()


def until(marker):
    deadline = time.monotonic() + 10
    while not (marker(data) if callable(marker) else marker in data):
        assert child.poll() is None, data.decode("utf-8", errors="replace")[-3000:]
        assert time.monotonic() < deadline, data.decode("utf-8", errors="replace")[-3000:]
        if select.select([master], [], [], 0.1)[0]:
            data.extend(os.read(master, 65536))


try:
    until(b"Schedule")
    time.sleep(0.2)
    for label in [b"Agents", b"Inbox", b"Schedule"]:
        data.clear()
        os.write(master, b"\t")
        until(lambda current: re.search(rb"\x1b\[7m(?:\x1b\[[0-9;]*m)* " + label, current))
    until(sys.argv[4].encode())
    assert b"Schedule" in data
    time.sleep(0.2)
    os.write(master, b"\r")
    until(sys.argv[5].encode())
    assert b"completed" in data
    os.write(master, b"q")
    time.sleep(0.2)
    os.write(master, b"q")
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data.extend(os.read(master, 65536))
            except OSError:
                break
    assert child.wait(timeout=1) == 0
    print(json.dumps({"cronVisible": True, "completedReceiptVisible": True, "cleanQuit": True}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
