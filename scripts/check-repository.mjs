import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = directory => existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (['node_modules', '__pycache__', '.git'].includes(entry.name)) return [];
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
}) : [];
const modules = ['src', 'scripts', 'packages/opencode-relay'].flatMap(name => walk(join(root, name)))
  .filter(path => /\.(mjs|tsx)$/.test(path) && !path.includes('/test/'));
const failures = [];
for (const path of modules) {
  const source = readFileSync(path, 'utf8');
  for (const match of source.matchAll(/^(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"](\.[^'"]+)['"]/gm)) {
    if (!existsSync(resolve(dirname(path), match[1]))) failures.push(`${relative(root, path)}: missing import ${match[1]}`);
  }
}
const documents = [join(root, 'README.md'), join(root, 'CHANGELOG.md'), ...['docs', 'skills', 'packages/opencode-relay'].flatMap(name => walk(join(root, name)))
  .filter(path => path.endsWith('.md') && !path.includes('/test/'))];
const slug = text => text.replace(/[`*_]/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
for (const path of documents) {
  if (!existsSync(path)) { failures.push(`Missing documentation ${relative(root, path)}`); continue; }
  const text = readFileSync(path, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|data:)/.test(href)) continue;
    const [name, anchor] = href.split('#'), target = name ? resolve(dirname(path), decodeURIComponent(name)) : path;
    if (!existsSync(target)) { failures.push(`${relative(root, path)}: missing link ${href}`); continue; }
    if (anchor && statSync(target).isFile() && target.endsWith('.md')) {
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => slug(match[1]));
      if (!headings.includes(decodeURIComponent(anchor))) failures.push(`${relative(root, path)}: missing heading ${href}`);
    }
  }
}
const retired = ['src/adapter.mjs', 'src/service.mjs', 'src/paperclip.mjs', 'src/paperclip-provider.mjs', 'src/provider-selection.mjs',
  'scripts/migrate-paperclip-tasks.mjs', 'docs/model-gateway.md', 'services/litellm/install.mjs',
  'services/litellm/compose.yaml', 'services/litellm/pyproject.toml', 'services/litellm', '.litellm'];
for (const name of retired) if (existsSync(join(root, name))) failures.push(`Retired integration returned: ${name}`);
for (const name of ['evaluation', 'docs/archive', 'docs/evidence']) if (walk(join(root, name)).length) failures.push(`Development journals/output returned: ${name}`);
assert.equal(failures.length, 0, failures.join('\n'));
console.log(JSON.stringify({ checkedModules: modules.length, checkedDocuments: documents.length, nativeOnly: true, brokenLinks: 0 }));
