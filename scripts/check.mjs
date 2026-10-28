import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const compiled = spawnSync(process.execPath, ['scripts/build-tui.mjs', '--check'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const repository = spawnSync(process.execPath, ['scripts/check-repository.mjs'], { stdio: 'inherit' });
if (repository.status !== 0) process.exit(repository.status ?? 1);

for (const directory of ['src', 'scripts', 'test', 'packages/opencode-relay', 'packages/opencode-relay/test']) {
  for (const file of readdirSync(directory).filter(file => file.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
