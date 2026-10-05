"""Run small, billable harness requests and verify per-key gateway attribution."""
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

project = Path(__file__).resolve().parent
started = datetime.now(timezone.utc).isoformat()
prompt = 'Do not use tools. Reply exactly gateway-ok.'
commands = {
    'opencode': ['opencode', 'run', '--pure', prompt],
    'hermes': ['hermes', 'chat', '--oneshot', '--ignore-rules', '--max-turns', '1',
               '--run-budget', '90', '-Q', '-q', prompt],
    'codex': ['codex', 'exec', '--strict-config', '--ephemeral', '--skip-git-repo-check',
              '--sandbox', 'read-only', prompt],
    'claude': ['claude', '-p', prompt, '--no-session-persistence', '--tools', ''],
    'copilot': [str(Path.home() / '.local/bin/copilot'), '--no-auto-update',
                '--disable-builtin-mcps', '--available-tools=', '-p', prompt],
}
with tempfile.TemporaryDirectory(prefix='litellm-harness-smoke-') as directory:
    for harness, command in commands.items():
        environment = dict(os.environ)
        if harness == 'opencode':
            # Disable configured MCPs for this test only; retain the actual provider defaults.
            config = json.loads((Path.home() / '.config/opencode/opencode.json').read_text())
            environment['OPENCODE_CONFIG_CONTENT'] = json.dumps({
                'mcp': {name: {'enabled': False} for name in config.get('mcp', {})}, 'permission': 'deny',
            })
        if harness == 'copilot':
            environment['COPILOT_OFFLINE'] = 'true'
        result = subprocess.run(command, cwd=directory, env=environment, input='',
                                text=True, capture_output=True, timeout=180)
        if result.returncode or 'gateway-ok' not in result.stdout:
            # Do not dump third-party CLI output: errors can echo credential headers.
            raise SystemExit(f'FAIL: {harness} exit={result.returncode}, inspect its local logs')
        print(f'PASS: {harness} generated gateway-ok', flush=True)

# Spend logs flush asynchronously. Read only aliases/models/status, never keys or prompts.
query = f'''SELECT DISTINCT v.key_alias
FROM "LiteLLM_SpendLogs" s JOIN "LiteLLM_VerificationToken" v ON s.api_key = v.token
WHERE s.status = 'success' AND s."startTime" >= '{started}'::timestamptz
AND v.key_alias IN ('local-opencode','local-hermes','local-codex','local-claude','local-copilot');'''
expected = {f'local-{name}' for name in commands}
for attempt in range(30):
    output = subprocess.check_output(['docker', 'compose', '-f', str(project / 'compose.yaml'),
                                      'exec', '-T', 'db', 'psql', '-U', 'litellm', '-d', 'litellm',
                                      '-At', '-c', query], text=True)
    observed = set(output.splitlines())
    if expected <= observed:
        break
    time.sleep(2)
else:
    raise SystemExit(f'Missing successful gateway attribution: {sorted(expected - observed)}')
print('PASS: all five distinct virtual keys have successful LiteLLM request records')
