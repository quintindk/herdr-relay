#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const project = dirname(fileURLToPath(import.meta.url));
const local = resolve(project, '../../.litellm');
const environmentPath = resolve(local, 'service.env');
if (!existsSync(environmentPath)) throw new Error('Run install.mjs before enabling the dashboard');
process.umask(0o077);
const parse = path => Object.fromEntries(readFileSync(path, 'utf8').split('\n')
  .filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=');
    if (index < 1) throw new Error(`Invalid environment line in ${path}`);
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const environment = parse(environmentPath);
const databasePath = resolve(local, 'database.env');
if (!existsSync(databasePath)) {
  if (environment.DATABASE_URL) throw new Error('Existing DATABASE_URL found. Configure that database instead.');
  writeFileSync(databasePath, `POSTGRES_USER=litellm\nPOSTGRES_DB=litellm\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
}
const database = parse(databasePath);
const databaseUrl = `postgresql://litellm:${database.POSTGRES_PASSWORD}@127.0.0.1:5433/litellm`;
if (environment.DATABASE_URL && environment.DATABASE_URL !== databaseUrl) {
  throw new Error('Refusing to replace an existing database connection');
}
execFileSync('docker', ['compose', '-f', resolve(project, 'compose.yaml'), 'up', '-d', '--wait'], { stdio: 'inherit' });
execFileSync('uv', ['sync', '--frozen', '--no-dev', '--project', project], { stdio: 'inherit' });
const schema = resolve(project, '.venv/lib/python3.12/site-packages/litellm/proxy/schema.prisma');
execFileSync(resolve(project, '.venv/bin/python'), ['-m', 'prisma', 'generate', '--schema', schema], {
  env: { ...process.env, DATABASE_URL: databaseUrl, PATH: `${resolve(project, '.venv/bin')}:${process.env.PATH}` },
  stdio: 'inherit', timeout: 600_000,
});
environment.DATABASE_URL = databaseUrl;
environment.LITELLM_SALT_KEY ||= randomBytes(32).toString('hex');
const environmentLoginDisabled = execFileSync(resolve(project, '.venv/bin/python'), ['-c',
  'import sys,yaml; print(yaml.safe_load(open(sys.argv[1])).get("general_settings", {}).get("disable_env_credential_login") is True)',
  resolve(local, 'config.yaml')], { encoding: 'utf8' }).trim() === 'True';
if (environmentLoginDisabled) {
  delete environment.UI_USERNAME;
  delete environment.UI_PASSWORD;
} else {
  environment.UI_USERNAME ||= 'admin';
  environment.UI_PASSWORD ||= randomBytes(24).toString('base64url');
}
environment.DISABLE_ADMIN_UI = 'False';
environment.ENFORCE_PRISMA_MIGRATION_CHECK = 'true';
writeFileSync(environmentPath, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
execFileSync(process.execPath, [resolve(project, 'install.mjs')], { stdio: 'inherit', timeout: 600_000 });
console.log('Admin UI: http://localhost:4000/ui/');
console.log(environmentLoginDisabled
  ? 'Login: use your existing personal admin account. Environment credential login remains disabled.'
  : `Bootstrap login: UI_USERNAME and UI_PASSWORD in ${environmentPath}`);
