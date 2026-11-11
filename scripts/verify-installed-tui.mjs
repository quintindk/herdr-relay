// Real host TUI against a production-only installed package, not checkout imports.
import assert from 'node:assert/strict';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const { values } = parseArgs({ options: { package: { type: 'string' }, binary: { type: 'string' } } });
assert.ok(values.package, '--package must be a production-installed herdr-relay directory');
const installed = resolve(values.package), binary = resolve(values.binary ?? process.env.RELAY_V2_BINARY ?? 'packages/opencode-relay/node_modules/.bin/opencode2');
const { launchOwnedV2 } = await import(pathToFileURL(join(installed, 'packages/opencode-relay/owned-runtime.mjs')));
const root = mkdtempSync('/tmp/opencode/relay-installed-tui-'), workspace = join(root, 'workspace'), clientHome = join(root, 'client');
mkdirSync(workspace); mkdirSync(join(clientHome, '.config/opencode'), { recursive: true });
const plugin = join(installed, 'packages/opencode-relay'), evidenceFile = join(root, 'evidence.jsonl'), outputFile = join(root, 'screen.txt');
writeFileSync(join(clientHome, '.config/opencode/cli.json'), JSON.stringify({ plugins: [{ package: plugin, options: { evidenceFile } }] }), { mode: 0o600 });
let runtime;
try {
  runtime = await launchOwnedV2({ directory: join(root, 'runtime'), workspace, executable: binary,
    config: { plugins: [{ package: plugin }], compaction: { auto: false } } });
  const info = await runtime.client.server.info();
  const session = await runtime.client.session.create({ location: { directory: workspace }, title: 'Installed Relay terminal verification' });
  const password = JSON.parse(readFileSync(join(root, 'runtime/auth.json'))).password;
  const driver = fileURLToPath(new URL('../packages/opencode-relay/pty-client.py', import.meta.url));
  const terminal = async (args, options = {}) => {
    const child = spawn('python3', [driver], { stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stdout.resume(); child.stderr.on('data', chunk => { diagnostics += chunk; });
    child.stdin.end(JSON.stringify({ args, cwd: workspace,
      env: { PATH: process.env.PATH, HOME: clientHome, XDG_CONFIG_HOME: join(clientHome, '.config'), XDG_DATA_HOME: join(clientHome, '.local/share'),
        XDG_STATE_HOME: join(clientHome, '.local/state'), TERM: 'xterm-256color', OPENCODE_PASSWORD: password },
      columns: 180, evidenceFile, outputFile, timeoutSeconds: 30, redact: [password], ...options }));
    const [code] = await once(child, 'exit'); assert.equal(code, 0, diagnostics);
  };
  const homeOutput = join(root, 'home-screen.txt');
  await terminal([binary, '--server', runtime.descriptor.origin, workspace], { outputFile: homeOutput,
    passiveEvent: { type: 'status_clock_rendered', slot: 'home.footer.status' }, outputField: 'time' });
  assert.ok(existsSync(evidenceFile), `Installed Home plugin did not produce evidence. Inspect private fixture ${root}`);
  const homeEvents = readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const homeClock = homeEvents.find(event => event.type === 'status_clock_rendered' && event.slot === 'home.footer.status');
  assert.ok(homeClock && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(homeClock.time), 'Installed Home status bar did not mount the HH:mm clock');
  assert.ok(stripVTControlCharacters(readFileSync(homeOutput, 'utf8')).includes(homeClock.time), 'Installed Home status bar did not render the current time');
  assert.equal(homeEvents.some(event => event.type === 'status_clock_rendered' && event.slot === 'prompt.footer.status'), false,
    'Home must not render a duplicate clock beneath its prompt');
  await terminal([binary, '--server', runtime.descriptor.origin, '--session', session.id, workspace]);
  assert.ok(existsSync(evidenceFile), `Installed terminal plugin did not produce evidence. Inspect private fixture ${root}`);
  const events = readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const type of ['loaded', 'attachment_sidebar_rendered', 'rpc', 'notification']) assert.ok(events.some(event => event.type === type && event.sessionId === session.id), `Missing ${type}`);
  assert.ok(events.some(event => event.type === 'attachment_sidebar' && event.sessionId === session.id && event.state === 'not_attached'));
  assert.equal(events.some(event => event.type === 'attachment_sidebar_unavailable'), false);
  const log = readFileSync(join(clientHome, '.local/share/opencode/log/opencode.log'), 'utf8');
  assert.equal(log.includes('plugin operation failed'), false, log.split('\n').filter(line => line.includes('plugin operation failed')).join('\n'));
  const screen = stripVTControlCharacters(readFileSync(outputFile, 'utf8'));
  const clock = events.find(event => event.type === 'status_clock_rendered' && event.slot === 'prompt.footer.status');
  assert.ok(clock && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock.time), 'Installed status bar did not mount the HH:mm clock');
  assert.ok(screen.includes(clock.time), 'Installed status bar did not render the current time');
  assert.equal(events.some(event => event.type === 'status_clock_unavailable'), false);
  assert.ok(screen.includes('◆') && screen.includes('○'), 'Installed sidebar did not render the compact status icons');
  assert.ok(screen.includes('Relay'), 'Installed sidebar did not render Relay text');
  assert.ok(screen.includes('Not attached to this chat') && screen.includes('Use /relay-attach'), 'Installed sidebar did not render the resolved attachment label and command');
  console.log(JSON.stringify({ passed: true, package: installed, runtime: info.version, productionPackageTuiLoaded: true,
    sidebarMounted: true, statusClockMounted: true, homeStatusClockMounted: true, scopedStatusReceived: true,
    runtimeCommandAndNotification: true, pluginLoadErrors: 0,
    userServiceTouched: false, userCredentialsCopied: false, fixture: root }, null, 2));
} finally { await runtime?.stop(); }
