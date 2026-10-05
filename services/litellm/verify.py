"""Verify the local gateway. --inference consumes usage for every configured model."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--inference', action='store_true')
args = parser.parse_args()
local = Path(__file__).resolve().parents[2] / '.litellm'
config = yaml.safe_load((local / 'config.yaml').read_text())
environment = dict(line.split('=', 1) for line in (local / 'service.env').read_text().splitlines()
                   if line and not line.startswith('#'))
base = 'http://127.0.0.1:4000'
headers = {'Authorization': 'Bearer ' + environment['LITELLM_MASTER_KEY']}
with httpx.Client(base_url=base, timeout=15) as client:
    client.get('/health/liveliness').raise_for_status()
    unauthenticated = client.get('/v1/models')
    assert unauthenticated.status_code in (401, 403), f'Missing-key request returned {unauthenticated.status_code}'
    invalid = client.get('/v1/models', headers={'Authorization': 'Bearer invalid'})
    # Database-free LiteLLM rejects unknown keys with no_db_connection (400).
    assert invalid.status_code in (401, 403) or (
        invalid.status_code == 400 and invalid.json().get('error', {}).get('type') == 'no_db_connection'
    ), f'Invalid-key request returned {invalid.status_code}'
    response = client.get('/v1/models', headers=headers)
    response.raise_for_status()
    expected = {model['model_name'] for model in config['model_list']}
    actual = {model['id'] for model in response.json()['data']}
    assert actual == expected, f'Unexpected model list: {actual ^ expected}'
    assert expected, 'No models configured'
    print(f'PASS: liveness, required authentication, and {len(expected)} configured models')


def infer(model):
    name = model['model_name']
    if model.get('model_info', {}).get('mode') == 'responses':
        route = '/v1/responses'
        body = {'model': name, 'input': 'Reply with exactly OK.', 'max_output_tokens': 128}
    else:
        route = '/v1/chat/completions'
        body = {'model': name, 'messages': [{'role': 'user', 'content': 'Reply with exactly OK.'}],
                'max_tokens': 128}
    try:
        with httpx.Client(base_url=base, timeout=150) as client:
            response = client.post(route, headers=headers, json=body)
        if not response.is_success:
            # Upstream error bodies can contain sensitive request details.
            print(f'FAIL: {name} {route} HTTP {response.status_code}')
            return False
        payload = response.json()
        if route.endswith('/responses'):
            text = ''.join(part.get('text', '') for item in payload.get('output', [])
                           for part in item.get('content', []) if isinstance(part, dict))
        else:
            text = payload['choices'][0]['message'].get('content', '')
        if not text or 'OK' not in text.upper():
            print(f'FAIL: {name} response did not contain OK')
            return False
        print(f'PASS: {name} {route}')
        return True
    except (httpx.HTTPError, KeyError, ValueError) as error:
        print(f'FAIL: {name} {type(error).__name__}')
        return False


if args.inference:
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(infer, config['model_list']))
    if not all(results):
        raise SystemExit(1)
