"""Stop only recorded evaluation process groups and remove copied credentials."""
import json
import os
from pathlib import Path
import signal
import time

root = Path('/tmp/opencode/retinue-native')
for harness in ('opencode', 'hermes'):
    pidfile = root / harness / 'pid'
    if pidfile.exists():
        pid = int(pidfile.read_text())
        try:
            os.killpg(pid, signal.SIGTERM)
            for _ in range(30):
                try:
                    os.killpg(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            else:
                os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        pidfile.unlink()
    removed = []
    for pattern in ('**/auth.json', '**/binding.json', '**/openrig-binding.json', 'gateway-token'):
        for path in (root / harness).glob(pattern):
            path.unlink()
            removed.append(str(path.relative_to(root)))
    print(json.dumps({'harness': harness, 'stopped': True, 'credentialFilesRemoved': removed}))
