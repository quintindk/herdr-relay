"""Disposable native board keyboard probe. Only fixture backends may use it."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
child = subprocess.Popen([sys.argv[1], sys.argv[2], "native", "board", "--context", sys.argv[3]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
data = bytearray()


def until(marker):
    deadline = time.monotonic() + 10
    while marker not in data:
        assert child.poll() is None, data.decode(errors="replace")[-2500:]
        assert time.monotonic() < deadline, data.decode(errors="replace")[-2500:]
        if select.select([master], [], [], 0.1)[0]:
            data.extend(os.read(master, 65536))


def send(keys):
    data.clear()
    os.write(master, keys)


try:
    until(b"Inbox (1)")
    send(b"\t")
    time.sleep(0.2)
    send(b"\t")
    until(b"Which region?" if sys.argv[4] == "answer" else b"Prepared configuration")
    send(b"\r")
    until(b"Your answer" if sys.argv[4] == "answer" else b"Review reason")
    send(sys.argv[5].encode())
    until(sys.argv[5].encode())
    send(b"\r")
    until(b"Confirm this exact decision")
    send(b"\r")
    until(b"No decisions need your attention")
    send(b"q")
    deadline = time.monotonic() + 5
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data.extend(os.read(master, 65536))
            except OSError:
                break
    assert child.wait(timeout=1) == 0
    print(json.dumps({"action": sys.argv[4], "confirmed": True, "cleanQuit": True}))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
