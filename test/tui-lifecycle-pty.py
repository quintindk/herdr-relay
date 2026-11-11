"""Exercise human lifecycle controls against disposable backend state only."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, cli, context, root = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 34, 120, 0, 0))
env = {**os.environ, "HOME": root, "XDG_STATE_HOME": root + "/state",
       "XDG_CONFIG_HOME": root + "/config", "TERM": "xterm-256color",
       "CI": "false", "CONTINUOUS_INTEGRATION": "false", "FORCE_COLOR": "1"}
process = subprocess.Popen([node, cli, "tui", "--context", context],
                           stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
output = bytearray()


def interrupt(_signal, _frame):
    raise SystemExit(1)


signal.signal(signal.SIGTERM, interrupt)


def wait_for(text):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        readable = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output).decode("utf-8", "replace")
        if text in readable:
            return readable
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
    raise AssertionError(f"TUI did not show {text!r}: {readable[-3500:]!r}")


def send(data):
    output.clear()
    os.write(master, data)
    # Distinct keyboard events, not a paste containing several navigation keys.
    time.sleep(0.05)


try:
    wait_for("RELAY / TASKS")
    for view in ["AGENTS", "INBOX", "GRANTS", "SCHEDULE"]:
        send(b"\t")
        wait_for("RELAY / " + view)
    send(b"c")
    wait_for("Create cron schedule")
    wait_for("Name / ID")
    send(b"pty-job")
    wait_for("Name / ID: pty-job▏")
    for label in ["Cron (five fields): 0 9 * * *▏", "Timezone: Africa/Johannesburg▏", "Instructions (Shift+Enter for newline): ▏"]:
        send(b"\t")
        wait_for(label)
    send(b"Inspect the disposable fixture only")
    wait_for("Inspect the disposable fixture only")
    send(b"\r")
    wait_for("Confirm new cron schedule")
    send(b"\r")
    wait_for("Paused schedule created")
    wait_for("pty-job  [")
    send(b"x")
    wait_for("Delete schedule")
    wait_for("No change has been submitted.")
    send(b"\r")
    wait_for("Confirm: Delete schedule")
    send(b"\r")
    wait_for("Schedule deleted")
    wait_for("No schedules installed")
    for view in ["GRANTS", "INBOX", "AGENTS"]:
        send(b"\x1b[Z")
        wait_for("RELAY / " + view)
    send(b"j")
    wait_for("Archive me")
    send(b"\r")
    wait_for("Agent details")
    wait_for("x delete")
    send(b"x")
    wait_for("Delete inactive agent")
    for attempt in range(5):
        preview = wait_for("No change has been submitted.")
        if "Blocked:" not in preview:
            break
        time.sleep(0.05)
        send(b"r")
    else:
        raise AssertionError("Disposable node did not acknowledge the schedule cancellation")
    send(b"\r")
    wait_for("Confirm: Delete inactive agent")
    send(b"\r")
    wait_for("Inactive agent deleted")
    send(b"q")
    process.wait(timeout=5)
    assert process.returncode == 0
    print(json.dumps({"created": True, "deletedSchedule": True, "deletedAgent": True, "realTuiKeyboard": True}))
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
