"""Read-only native board PTY probe. Never controls an existing user terminal."""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 150, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], "native", "board", "--context", sys.argv[3]],
                         stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
data = bytearray()


def until(marker):
    deadline = time.monotonic() + 10
    while marker not in data:
        assert child.poll() is None, data.decode("utf-8", errors="replace")[-3000:]
        assert time.monotonic() < deadline, data.decode("utf-8", errors="replace")[-3000:]
        if select.select([master], [], [], 0.1)[0]:
            data.extend(os.read(master, 65536))


try:
    until(sys.argv[4].encode())
    assert b"CRON" in data
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
