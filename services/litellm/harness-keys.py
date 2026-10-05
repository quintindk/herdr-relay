"""Provision one inference-only virtual key per local coding harness. Never print keys."""
import hashlib
import json
import os
import secrets
from pathlib import Path

import httpx
import yaml

os.umask(0o077)
local = Path(__file__).resolve().parents[2] / '.litellm'
environment = dict(line.split('=', 1) for line in (local / 'service.env').read_text().splitlines()
                   if line and not line.startswith('#'))
models = [entry['model_name'] for entry in yaml.safe_load((local / 'config.yaml').read_text())['model_list']]
assert models, 'Configure gateway models first'
keys = Path.home() / '.config/litellm/keys'
keys.mkdir(parents=True, exist_ok=True, mode=0o700)
keys.chmod(0o700)
admin = {'Authorization': 'Bearer ' + environment['LITELLM_MASTER_KEY']}
with httpx.Client(base_url='http://127.0.0.1:4000', timeout=30) as client:
    for harness in ('opencode', 'hermes', 'codex', 'claude', 'copilot'):
        path = keys / f'{harness}.key'
        if not path.exists():
            # Persist before registration so an uncertain POST can be reconciled by hash.
            with path.open('x') as file:
                file.write('sk-' + secrets.token_hex(32))
        path.chmod(0o600)
        key = path.read_text().strip()
        key_hash = hashlib.sha256(key.encode()).hexdigest()
        allowed = [model for model in models if model.startswith('claude-')] if harness == 'claude' else models
        assert allowed, f'No models available for {harness}'
        info = client.get('/key/info', headers=admin, params={'key': key_hash})
        if info.status_code == 404:
            user_id = f'harness-{harness}'
            user = client.get('/user/info', headers=admin, params={'user_id': user_id})
            if user.status_code != 404:
                user.raise_for_status()
            if user.status_code == 404 or not user.json().get('user_info'):
                created = client.post('/user/new', headers=admin, json={
                    'user_id': user_id, 'user_alias': f'Local {harness} harness',
                    'user_role': 'internal_user', 'auto_create_key': False, 'send_invite_email': False,
                })
                created.raise_for_status()
            response = client.post('/key/generate', headers=admin, json={
                'key': key, 'key_alias': f'local-{harness}', 'user_id': user_id,
                'key_type': 'llm_api', 'models': allowed, 'metadata': {'harness': harness},
            })
            response.raise_for_status()
            info = client.get('/key/info', headers=admin, params={'key': key_hash})
        info.raise_for_status()
        details = info.json()['info']
        assert details.get('key_alias') == f'local-{harness}', 'Unexpected existing key owner'
        assert details.get('status', 'active') == 'active', f'{harness} key is not active; investigate before replacing it'
        assert not details.get('blocked'), f'{harness} key is blocked; investigate rather than replacing it'
        assert set(details['models']) == set(allowed), f'{harness} key model allowlist has changed'
        headers = {'Authorization': 'Bearer ' + key}
        listed = client.get('/v1/models', headers=headers)
        listed.raise_for_status()
        assert {item['id'] for item in listed.json()['data']} == set(allowed)
        denied = client.get('/user/list', headers=headers)
        assert denied.status_code in (401, 403), f'{harness} key can access management routes'
        print(f'PASS: {harness} key, {len(allowed)} allowed models, administrative access denied')
