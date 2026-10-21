"""Disposable TUI driver. Configuration arrives over stdin, not command arguments."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

config = json.loads(sys.stdin.readline())
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
child = subprocess.Popen(config["args"], cwd=config["cwd"], env=config["env"],
                         stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = bytearray()
try:
    deadline = time.monotonic() + config.get("timeoutSeconds", 45)
    sent = False
    next_attempt = time.monotonic() + 5
    notified = False
    decision_sent = False
    inbox_steps = set()
    while child.poll() is None and time.monotonic() < deadline:
        if config.get("passiveUntil") and os.path.exists(config["passiveUntil"]):
            break
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output.extend(chunk)
            if len(output) > 200000:
                del output[:-100000]
            if b"\x1b[6n" in chunk:
                os.write(master, b"\x1b[1;1R")
        if time.monotonic() >= next_attempt and os.path.exists(config["evidenceFile"]):
            command = b"/relay-reminders" if config.get("reminder") else b"/relay-reviews" if config.get("review") else b"/relay-decisions" if config.get("proposals") else b"/relay-questions" if config.get("inbox") else b"/relay-spike-confirm" if config.get("decision") else b"/relay-spike"
            os.write(master, b"\x15" + command)
            time.sleep(0.5)
            os.write(master, b"\r")
            sent = True
            next_attempt = time.monotonic() + 5
        if sent and os.path.exists(config["evidenceFile"]):
            with open(config["evidenceFile"], encoding="utf-8") as handle:
                evidence = handle.read()
                if config.get("inbox"):
                    for step, keys in [("inbox_select", b"\r"), ("inbox_answer", b"South Africa North\r"), ("inbox_confirm", b"\r")]:
                         if ('"type":"' + step + '"') in evidence and step not in inbox_steps:
                            if step == 'inbox_confirm' and config.get('confirmationGate') and not os.path.exists(config['confirmationGate']):
                                continue
                            time.sleep(0.5)
                            os.write(master, keys)
                            inbox_steps.add(step)
                            next_attempt = deadline
                if config.get("proposals"):
                    for step in ["proposal_select", "proposal_confirm"]:
                        if ('"type":"' + step + '"') in evidence and step not in inbox_steps:
                            time.sleep(0.5)
                            os.write(master, b"\r")
                            inbox_steps.add(step)
                            next_attempt = deadline
                if config.get("review"):
                    for step, keys in [("inbox_select", b"\r"), ("review_choice", b"\r"), ("review_reason", b"Fixture review verified\r"), ("inbox_confirm", b"\r")]:
                        if ('"type":"' + step + '"') in evidence and step not in inbox_steps:
                            time.sleep(0.5)
                            os.write(master, keys)
                            inbox_steps.add(step)
                            next_attempt = deadline
                if config.get("decision") and '"type":"decision_displayed"' in evidence and not decision_sent:
                    time.sleep(0.5)
                    os.write(master, b"\r")
                    decision_sent = True
                    next_attempt = deadline
                done = '"type":"human_decision_refused"' if config.get('expectRefused') else '"type":"human_decision"' if config.get("inbox") or config.get("proposals") or config.get("review") else '"type":"decision"' if config.get("decision") else '"type":"notification"'
                if done in evidence:
                    notified = True
                    if not config.get("passiveUntil"):
                        break
                    next_attempt = deadline
    # Only surface terminal output on failure, with credentials redacted.
    if not notified:
        text = output.decode("utf-8", errors="replace")
        for secret in config.get("redact", []):
            text = text.replace(secret, "[redacted]")
        print(text[-6000:], file=sys.stderr)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
    os.close(master)
