import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode, observe } from './opencode.mjs';
import { Hermes, observeHermes } from './hermes.mjs';
import { canonical, digest, requireValue } from './protocol.mjs';
import { ownedRuntime } from './runtimes.mjs';
import { reconcilePlacement } from './placement.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function workerContext(directory, socketPath, store, binding) {
  const parent = join(directory, 'workers');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, `${digest(binding.id)}.json`);
  const context = { socketPath, bindingId: binding.id, token: store.register(binding.config).token,
    credentialGeneration: binding.credentialGeneration ?? 0 };
  try { writeFileSync(path, `${JSON.stringify(context)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(readFileSync(path, 'utf8'));
    if (previous.token === context.token && previous.bindingId === binding.id && previous.socketPath === socketPath) return path;
    requireValue(previous.bindingId === binding.id && previous.socketPath === socketPath &&
      (previous.credentialGeneration ?? 0) < context.credentialGeneration,
    'context_conflict', 'Existing native worker context differs from binding', 409);
    const temporary = `${path}.next`;
    writeFileSync(temporary, `${JSON.stringify(context)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
  return path;
}

export function promptFor(run, context) {
  const cli = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./cli.mjs', import.meta.url)))} --context ${quote(context)}`;
  return `Herdr Relay work invocation ${run.id}. Continue in this existing conversation.\n` +
    `Use the Relay CLI below. Credentials are already in its context file. Do not read or print that file.\n` +
    `1. Read the assigned task: ${cli} work read ${quote(run.id)}\n` +
    `2. Acknowledge before doing the work: ${cli} work acknowledge ${quote(run.id)}\n` +
    `Read previous questions and answers with: ${cli} work interactions ${quote(run.id)}\n` +
    `If blocked on clarification, write a question file and run ${cli} work ask ${quote(run.id)} --key question-1 --question-file /absolute/path/question.md, then finish this turn without submitting.\n` +
    `3. Execute the task, write a summary file, then submit using:\n` +
    `${cli} work submit ${quote(run.id)} --key candidate-1 --summary-file /absolute/path/result.md --candidate YOUR_CANDIDATE_ID\n` +
    `Use the task's actual candidate identity. After submission stop editing and finish this turn. Submission is not acceptance.\n` +
    `work read reports relayReviewPolicy: human requires approval; none completes after verified publication/settlement; agent_decides requires a JSON submission with reviewDecision {mode: "none" or "human", reason: "why"}, via work submit RUN --file FILE. Honour any creator requirement; tool/action permissions remain separate. At delegation choose relayReviewPolicy explicitly on task create payloads.\n` +
    `If the task explicitly authorises delegation, create a child through task create, then work wait-child RUN --task CHILD_ID and finish without submitting. On continuation use task inspect RUN --task CHILD_ID for its result. Do not delegate otherwise.\n` +
    `If cancellation is reported, stop working and finish the turn without submitting.\n`;
}

export function supervise({ store, directory, socketPath, ready, interval = 250 }) {
  let stopped = false;
  let current = Promise.resolve();
  let timer;

  async function reconcile(id) {
    let run = store.run(id);
    const binding = store.binding(run.request.bindingId);
    if (!['opencode', 'hermes'].includes(binding.config.delivery) || run.nativeState === 'settled') return;
    const hermes = binding.config.delivery === 'hermes';
    const runtimeKey = (binding.config.opencode ?? binding.config.hermes)?.runtimeKey;
    const native = hermes ? new Hermes(binding.config) : new OpenCode(binding.config);
    try {
      // A terminal receipt already persisted by this observer survives native
      // replay-buffer eviction and coordinator restart. Backend publication may
      // still be pending, but must not erase verified native completion.
      if (run.native?.state === 'finished') {
        store.finishNative(id, run.native);
        return;
      }
      if (store.operation(`placement:${binding.id}`)) {
        const placement = await reconcilePlacement(store, binding.id);
        requireValue(placement.state === 'verified', 'placement_unresolved', 'Native placement requires reconciliation', 409);
      }
      if (runtimeKey) ownedRuntime(store, runtimeKey);
      if (!run.invocation) {
        if (!ready(id) || run.cancellationRequested) return;
        const snapshot = await native.snapshot();
        if (!snapshot.idle) { store.nativeStatus(id, { state: 'blocked', reason: 'native_busy' }); return; }
        const context = workerContext(directory, socketPath, store, binding);
        // Persist before POST. Even a crash immediately after this write leaves
        // uncertainty, never an instruction to send the same prompt again.
        const priorUserIds = hermes
          ? snapshot.session.messages.filter(message => message.role === 'user').map(message => message.row_id)
          : snapshot.messages.filter(message => message.info.role === 'user').map(message => message.info.id);
        run = store.beginNative(id, promptFor(run, context).trim(), priorUserIds, hermes ? snapshot.events.latest_seq : undefined);
        if (!run.invocation) return; // Cancelled while preflight was in flight.
        await native.send(run.invocation);
      }
      run = store.run(id);
      const observation = (hermes ? observeHermes : observe)(await native.snapshot(), run.invocation);
      store.nativeStatus(id, observation);
      if (runtimeKey && run.cancellationRequested &&
        observation.state === 'observed' && !run.interruption && run.native?.state !== 'conflict') {
        ownedRuntime(store, runtimeKey);
        store.interruptIntent(id);
        await native.interrupt();
        // The abort reply is not settlement. Observe the original message again.
      }
      if (observation.state === 'finished') store.finishNative(id, observation);
    } catch (error) {
      store.nativeStatus(id, { state: run.invocation ? 'uncertain' : 'blocked', reason: error.code ?? 'native_unavailable' });
    }
  }

  const tick = async () => {
    const runs = store.runs().filter(run => run.nativeState !== 'settled');
    // A disconnected native host must not serially stall every independent agent.
    // There is still at most one reconciliation per binding in this service.
    for (let offset = 0; offset < runs.length; offset += 8) {
      if (stopped) break;
      await Promise.all(runs.slice(offset, offset + 8).map(run => reconcile(run.id)));
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      current = tick().catch(error => {
        console.error(JSON.stringify({ code: error.code ?? 'native_reconciliation_failed' }));
      }).finally(schedule);
    }, interval);
  };
  schedule();
  return { close: async () => { stopped = true; clearTimeout(timer); await current; } };
}
