"""Start isolated native servers using local credentials without printing them."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import hashlib
import secrets

ROOT = Path('/tmp/opencode/retinue-native')
ROOT.mkdir(mode=0o700, exist_ok=True)
os.chmod(ROOT, 0o700)
processes = {}
for harness in ('opencode', 'hermes'):
    if len(sys.argv) > 1 and harness != sys.argv[1]:
        continue
    root = ROOT / harness
    root.mkdir(exist_ok=True)
    home = root / ('home-clean' if harness == 'hermes' else 'home')
    home.mkdir(exist_ok=True)
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TERM') if k in os.environ}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'),
               XDG_DATA_HOME=str(home / '.local/share'), XDG_STATE_HOME=str(home / '.local/state'),
               XDG_CACHE_HOME=str(home / '.cache'))
    if harness == 'opencode':
        auth = home / '.local/share/opencode/auth.json'
        auth.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile('/home/quintin/.local/share/opencode/auth.json', auth)
        os.chmod(auth, 0o600)
        config = home / '.config/opencode/opencode.json'
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(json.dumps({'$schema': 'https://opencode.ai/config.json',
            'model': 'github-copilot/gpt-6-astra', 'autoupdate': False, 'share': 'disabled',
            'permission': {'bash': 'allow', 'edit': 'deny', 'task': 'deny'}, 'plugin': []}))
        env.update(OPENCODE_PURE='1', OPENCODE_DISABLE_EXTERNAL_SKILLS='1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1')
        argv = ['/home/quintin/.nvm/versions/node/v24.18.0/bin/opencode', 'serve', '--hostname', '127.0.0.1', '--port', '17401', '--pure']
    else:
        hh = home / '.hermes'
        hh.mkdir(exist_ok=True)
        install_key = hashlib.sha256(b'/home/quintin/.hermes/hermes-agent').hexdigest()[:16]
        install_dir = hh / 'installs' / install_key
        install_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path('/home/quintin/.hermes/installs') / install_key / 'facts.json', install_dir / 'facts.json')
        generations = install_dir / 'environments'
        if not generations.exists():
            generations.symlink_to(Path('/home/quintin/.hermes/installs') / install_key / 'environments', target_is_directory=True)
        shutil.copyfile('/home/quintin/.hermes/auth.json', hh / 'auth.json')
        os.chmod(hh / 'auth.json', 0o600)
        (hh / 'config.yaml').write_text('model:\n  default: gpt-6-astra\n  provider: copilot\n  base_url: https://api.githubcopilot.com\nterminal:\n  backend: local\n  cwd: ' + str(root) + '\n')
        env.update(HERMES_HOME=str(hh), HERMES_RUNTIME_DIR='/home/quintin/.hermes/tools', HERMES_DISABLE_LAZY_INSTALLS='1', PYTHONPATH='/home/quintin/.hermes/hermes-agent', PYTHONUNBUFFERED='1')
        token_file = root / 'gateway-token'
        if not token_file.exists():
            token_file.write_text(secrets.token_hex(32))
            os.chmod(token_file, 0o600)
        env['HERMES_DASHBOARD_SESSION_TOKEN'] = token_file.read_text()
        argv = ['/home/quintin/.local/bin/hermes', 'serve', '--host', '127.0.0.1', '--port', '17402', '--skip-build', '--isolated']
    pidfile = root / 'pid'
    if pidfile.exists():
        try:
            os.kill(int(pidfile.read_text()), 0)
            raise RuntimeError(f'{harness} fixture already running')
        except ProcessLookupError:
            pass
    with open(root / 'stdout.log', 'ab') as out, open(root / 'stderr.log', 'ab') as err:
        proc = subprocess.Popen(argv, cwd=root, env=env, stdout=out, stderr=err, start_new_session=True)
    pidfile.write_text(str(proc.pid))
    processes[harness] = proc.pid
print(json.dumps(processes))
