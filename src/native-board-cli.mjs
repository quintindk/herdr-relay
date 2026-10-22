#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { nativeBackendClient } from './backend-client.mjs';
import { nativeBoard, boardLocalIdentity } from './native-board.mjs';
import { watchTaskBoardInk } from './task-board-ink.mjs';
import { requireValue } from './protocol.mjs';
import { NativeDecisionJournal } from './native-decision-journal.mjs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

try {
  const { values } = parseArgs({ options: { context: { type: 'string' }, json: { type: 'boolean' } } });
  const contextPath = values.context ?? process.env.RELAY_NATIVE_CONTEXT ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'herdr-relay-backend/owner.json');
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  const journal = new NativeDecisionJournal(join(dirname(resolve(contextPath)), 'native-board-decisions.sqlite'));
  const board = nativeBoard(nativeBackendClient({ ...context, url: context.url ?? 'http://127.0.0.1:3210' }), { decisionJournal: journal, ...boardLocalIdentity(context) });
  try {
    if (values.json) console.log(JSON.stringify(await board.read(), null, 2));
    else {
      requireValue(process.stdin.isTTY && process.stdout.isTTY, 'terminal_required', 'Interactive board requires a TTY, or use --json');
      await watchTaskBoardInk(board.read, { inspectTask: board.inspectTask, detailTask: board.detailTask,
        statusTask: board.statusTask, reviewTask: board.reviewTask, detailRoutine: board.detailRoutine, detailAgent: board.detailAgent,
        detailInbox: board.detailInbox, decideInbox: board.decideInbox, pendingDecisions: board.pendingDecisions });
    }
  } finally { journal.close(); }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'board_failed', message: error.message })); process.exitCode = 1;
}
