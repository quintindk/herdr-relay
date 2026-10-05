"""Configure installed local harnesses for this gateway, preserving unrelated settings."""
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import tomlkit
import yaml

os.umask(0o077)
home = Path.home()
local = Path(__file__).resolve().parents[2] / '.litellm'
keys = home / '.config/litellm/keys'
backups = local / 'harness-backups'
backups.mkdir(exist_ok=True, mode=0o700)
models = yaml.safe_load((local / 'config.yaml').read_text())['model_list']
ids = {model['model_name'] for model in models}
for model in ('gpt-6-astra', 'gpt-5.4-mini', 'claude-sonnet-5.5', 'claude-opus-5.5', 'claude-haiku-4.5'):
    if model not in ids:
        raise SystemExit(f'Required default model is absent: {model}')
for harness in ('opencode', 'hermes', 'codex', 'claude', 'copilot'):
    if not (keys / f'{harness}.key').exists():
        raise SystemExit('Run harness-keys.py first')


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = backups / str(path.relative_to(home)).replace('/', '__')
    if path.exists() and not backup.exists():
        shutil.copyfile(path, backup)
        backup.chmod(0o600)
    path.write_text(text)
    path.chmod(mode)


def load_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


for executable in ('opencode', 'hermes', 'codex', 'claude', 'copilot'):
    if not shutil.which(executable):
        raise SystemExit(f'Install {executable} before configuring the harnesses')
registry = home / '.copilot/providers.json'
if registry.exists() and any(load_json(registry).get(name) for name in ('providers', 'models')):
    raise SystemExit('Existing Copilot provider registry takes precedence; reconcile it before configuring BYOK')


opencode_path = home / '.config/opencode/opencode.json'
opencode = load_json(opencode_path)
opencode['$schema'] = 'https://opencode.ai/config.json'
opencode['model'] = 'litellm/gpt-6-astra'
opencode['small_model'] = 'litellm/gpt-5.4-mini'
definitions = {}
for entry in models:
    name = entry['model_name']
    info = entry.get('model_info', {})
    definitions[name] = {
        'name': name, 'tool_call': True, 'attachment': info.get('supports_vision', False),
        'limit': {'context': info['max_input_tokens'], 'output': info['max_output_tokens']},
        'provider': {'npm': '@ai-sdk/anthropic' if name.startswith('claude-') else '@ai-sdk/openai'},
    }
opencode.setdefault('provider', {})['litellm'] = {
    'npm': '@ai-sdk/openai', 'name': 'Local LiteLLM',
    'options': {'baseURL': 'http://127.0.0.1:4000/v1', 'apiKey': f'{{file:{keys / "opencode.key"}}}'},
    'models': definitions,
}
write(opencode_path, json.dumps(opencode, indent=2) + '\n')

codex_path = home / '.codex/config.toml'
codex = tomlkit.parse(codex_path.read_text()) if codex_path.exists() else tomlkit.document()
codex['model'] = 'gpt-6-astra'
codex['model_provider'] = 'litellm'
codex['web_search'] = 'disabled'
codex.setdefault('features', {})['api_key_model_discovery'] = False
# The pinned gateway does not serve Codex's catalogue format. Retain native model
# metadata locally rather than substituting generic tool and context defaults.
catalogue = json.loads(subprocess.check_output(['codex', 'debug', 'models', '--bundled'], text=True))
catalogue['models'] = [model for model in catalogue['models'] if model['slug'] in ids]
assert any(model['slug'] == codex['model'] for model in catalogue['models'])
catalogue_path = home / '.codex/litellm-models.json'
write(catalogue_path, json.dumps(catalogue, indent=2) + '\n')
codex['model_catalog_json'] = str(catalogue_path)
codex.setdefault('model_providers', {})['litellm'] = {
    'name': 'Local LiteLLM', 'base_url': 'http://127.0.0.1:4000/v1', 'wire_api': 'responses',
    'auth': {'command': '/bin/cat', 'args': [str(keys / 'codex.key')],
             'timeout_ms': 5000, 'refresh_interval_ms': 300000},
}
write(codex_path, tomlkit.dumps(codex))

claude_path = home / '.claude/settings.json'
claude = load_json(claude_path)
claude['model'] = 'claude-sonnet-5.5'
claude['apiKeyHelper'] = '/bin/cat ' + shlex.quote(str(keys / 'claude.key'))
claude.setdefault('env', {}).update({
    'ANTHROPIC_BASE_URL': 'http://127.0.0.1:4000',
    'ANTHROPIC_DEFAULT_OPUS_MODEL': 'claude-opus-5.5',
    'ANTHROPIC_DEFAULT_SONNET_MODEL': 'claude-sonnet-5.5',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL': 'claude-haiku-4.5',
})
write(claude_path, json.dumps(claude, indent=2) + '\n')

hermes_path = home / '.hermes/config.yaml'
hermes = yaml.safe_load(hermes_path.read_text()) if hermes_path.exists() else {}
hermes.setdefault('model', {}).update({'default': 'gpt-6-astra', 'provider': 'custom:litellm',
                                      'base_url': 'http://127.0.0.1:4000/v1'})
hermes.setdefault('providers', {})['litellm'] = {
    'api': 'http://127.0.0.1:4000/v1', 'transport': 'codex_responses',
    'key_cmd': '/bin/cat ' + shlex.quote(str(keys / 'hermes.key')),
    'default_model': 'gpt-6-astra', 'context_length': 1050000,
}
write(hermes_path, yaml.safe_dump(hermes, sort_keys=False))

# Copilot's supported BYOK environment is scoped to this launcher, not every shell process.
copilot_wrapper = home / '.local/bin/copilot'
resolved = shutil.which('copilot')
if not resolved:
    raise SystemExit('Install Copilot CLI before configuring it')
if Path(resolved) == copilot_wrapper:
    candidates = [Path(directory) / 'copilot' for directory in os.environ['PATH'].split(os.pathsep)
                  if Path(directory) / 'copilot' != copilot_wrapper]
    resolved = next((str(path) for path in candidates if path.is_file()), None)
    if not resolved:
        raise SystemExit('Cannot locate installed Copilot CLI behind launcher')
write(copilot_wrapper, f'''#!/bin/sh
# Herdr Relay LiteLLM launcher. No embedded credentials.
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:4000/v1
export COPILOT_PROVIDER_WIRE_API=responses
export COPILOT_PROVIDER_API_KEY_COMMAND={shlex.quote('/bin/cat ' + shlex.quote(str(keys / 'copilot.key')))}
export COPILOT_MODEL="${{COPILOT_MODEL:-gpt-6-astra}}"
unset COPILOT_PROVIDER_API_KEY COPILOT_PROVIDER_BEARER_TOKEN
exec {shlex.quote(resolved)} "$@"
''', mode=0o700)
print('Configured five harnesses. Credentials remain in ~/.config/litellm/keys/.')
print('Ensure ~/.local/bin precedes the npm bin directory in PATH for the Copilot launcher.')
print('Restart OpenCode and other existing harness sessions to load the new defaults.')
