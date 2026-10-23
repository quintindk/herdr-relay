import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireValue } from '../../src/protocol.mjs';
import { nativeCliInvocation } from '../../src/native-cli-surface.mjs';
import { humanSource } from './human-proposals.mjs';
import { workerConnection, workerContextPath } from './worker-context.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));
const sensitive = /^(?:token|password|secret|clientSecret|apiKey|authorization|accessToken|refreshToken|operatorToken|nodeToken)$/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : redact(item)]));
  return value;
}

export function cliBridgeOutput(text) {
  try { return JSON.stringify(redact(JSON.parse(text))); }
  catch { return text.replace(/(["']?(?:token|password|secret|clientSecret|apiKey|accessToken|refreshToken|operatorToken|nodeToken)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,}]+)/gi, '$1"[redacted]"'); }
}

// Invoke the installed CLI itself. There is deliberately no second command or
// mutation implementation, and no per-operation bridge allowlist to drift.
export async function runRelayCli({ args, directory, sessionId, operatorContextFile, workerContextFile, nodeConfigFile, payload, timeout = 120000, signal }, { run = execute } = {}) {
  requireValue(Array.isArray(args) && args.length > 0 && args.every(arg => typeof arg === 'string' && !arg.includes('\0')),
    'invalid_request', 'CLI arguments must be an array of strings, not a shell command');
  requireValue(nativeCliInvocation(args),
    'legacy_cli_not_supported', 'Use the native CLI: task/execution commands start with native. Retired Paperclip commands are not a fallback');
  let scratch;
  const substitutions = { '{operator}': operatorContextFile, '{worker}': workerContextFile, '{node-config}': nodeConfigFile, '{session}': sessionId };
  if (payload !== undefined) {
    requireValue(args.includes('{payload}'), 'invalid_request', 'Use {payload} as the argument for --file');
    scratch = mkdtempSync('/tmp/opencode/relay-cli-');
    substitutions['{payload}'] = join(scratch, 'payload.json');
    writeFileSync(substitutions['{payload}'], JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
  }
  let argv;
  try {
    argv = args.map(arg => {
      if (!Object.hasOwn(substitutions, arg)) return arg;
      requireValue(substitutions[arg], 'cli_context_unavailable', `Configured ${arg} is unavailable`);
      return substitutions[arg];
    });
    // The bridge uses the configured local operator, not a model-selected owner
    // credential. Commands needing backend-root authority still fail in the CLI.
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--context' || argv[i].startsWith('--context=')) {
      const selected = argv[i] === '--context' ? argv[++i] : argv[i].slice('--context='.length);
      requireValue(selected && [operatorContextFile, workerContextFile].filter(Boolean).some(path => resolve(directory, selected) === resolve(path)),
        'cli_context_mismatch', 'CLI context must be the configured local operator or exact-session worker');
    }
  } catch (error) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
  let result;
  try {
    // Inside the packaged OpenCode host, process.execPath is opencode.exe, not
    // node. Match the Relay executable's /usr/bin/env node interpreter instead.
    result = await run('node', [cli, ...argv], { cwd: directory, timeout, signal, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, RELAY_CONTEXT: '', RELAY_NATIVE_CONTEXT: operatorContextFile ?? '', OPENCODE_SESSION_ID: sessionId ?? '' } });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    return { exitCode: 0, stdout: cliBridgeOutput(result.stdout ?? ''), stderr: cliBridgeOutput(result.stderr ?? ''), effectsUncertain: false };
  } catch (error) {
    // A failed/timed-out CLI may have committed effects. Keep its payload for
    // exact-key reconciliation. Never retry or pretend the operation did nothing.
    return { exitCode: typeof error.code === 'number' ? error.code : null, transportError: typeof error.code === 'string' ? error.code : null, signal: error.signal ?? null,
      stdout: cliBridgeOutput(error.stdout ?? ''), stderr: cliBridgeOutput(error.stderr ?? ''), effectsUncertain: true,
      ...(scratch ? { retainedPayloadFile: substitutions['{payload}'] } : {}) };
  }
}

export async function interactiveCliSource(ctx, context, connection = workerConnection) {
  const worker = connection(ctx.options, context.sessionID);
  requireValue(!worker.headlessSetupId, 'interactive_cli_required', 'Headless jobs retain their own granted tools');
  const session = await ctx.session.get({ sessionID: context.sessionID });
  requireValue(!session.metadata?.relayHeadlessSetup && session.location?.directory === ctx.location.directory,
    'interactive_cli_required', 'CLI bridge belongs to this interactive location');
  const messages = await ctx.session.context({ sessionID: context.sessionID });
  const callIndex = messages.findIndex(message => message.id === context.messageID);
  requireValue(callIndex >= 0, 'human_source_required', 'Native tool message must belong to this chat');
  const triggers = messages.filter(message => ['user', 'synthetic', 'shell'].includes(message.type));
  const source = humanSource(triggers.at(-1));
  requireValue(messages.findIndex(message => message.id === source.id) <= callIndex,
    'human_source_changed', 'A newer input arrived after this tool invocation');
  return source;
}

export function registerCliBridge(editor, ctx, dependencies = {}) {
  const run = dependencies.runCli ?? runRelayCli;
  editor.add({ name: 'relay_cli_help', description: 'Read the installed native Relay CLI command reference, including tasks, execution hand-off, node administration, skills, upgrades and headless commands. A CLI method is not a new permission grant.', options: { codemode: false },
    input: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const sections = await Promise.all([['native', '--help'], ['upgrade', '--help'], ['headless', '--help']].map(args => run({ args, directory: ctx.location.directory })));
      return { content: JSON.stringify({ sections, transport: 'installed_cli_argv', terminalCommands: 'TTY-only commands retain their CLI terminal requirement. Use documented JSON/dry-run modes for tool calls.' }) };
    } });
  editor.add({ name: 'relay_cli', description: 'Run any supported native Relay CLI command using the configured local operator and the same CLI implementation/permissions. Interactive human requests need no active execution. Supply argv, not shell text. Task commands start with native, e.g. ["native","task","create","--key","KEY","--file","{payload}"]. Optional payload supplies that private JSON file. Tokens {operator}, {worker}, {node-config}, {session} resolve internally. Lifecycle/upgrade/provisioning actions still require the human request. Headless jobs cannot use this bridge. Inspect non-zero/uncertain results and reconcile the original key rather than retrying effects blindly.', options: { codemode: false },
    input: { type: 'object', properties: { args: { type: 'array', minItems: 1, items: { type: 'string' } }, payload: { type: 'object', additionalProperties: true }, timeout: { type: 'integer', minimum: 0 } }, required: ['args'], additionalProperties: false },
    async execute(input, context) {
      const source = await interactiveCliSource(ctx, context, dependencies.connection);
      await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, action: 'relay_cli', resources: [input.args.join(' ')],
        source: { type: 'tool', messageID: context.messageID, id: context.id } });
      const current = await interactiveCliSource(ctx, context, dependencies.connection);
      requireValue(JSON.stringify(current) === JSON.stringify(source), 'human_source_changed', 'Human input changed during permission evaluation');
      const directory = ctx.options.workerDirectory ? resolve(ctx.options.workerDirectory) : ctx.options.workerContextFile ? dirname(resolve(ctx.options.workerContextFile)) : undefined;
      requireValue(directory, 'cli_context_unavailable', 'Joined node directory is required');
      const result = await run({ ...input, signal: context.signal, directory: ctx.location.directory, sessionId: context.sessionID,
        operatorContextFile: join(directory, 'operator.json'), nodeConfigFile: join(directory, 'node.json'),
        workerContextFile: dependencies.workerContextPath?.(ctx.options, context.sessionID) ?? workerContextPath(ctx.options, context.sessionID) });
      return { content: JSON.stringify(result) };
    } });
}
