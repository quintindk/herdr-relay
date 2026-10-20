#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { nativeBackendClient } from './backend-client.mjs';
import { nativeBoard } from './native-board.mjs';
import { watchTaskBoardInk } from './task-board-ink.mjs';
import { requireValue } from './protocol.mjs';

try {
  const { values } = parseArgs({ options: { context: { type: 'string' }, json: { type: 'boolean' } } });
  requireValue(values.context, 'invalid_request', 'Explicit native owner context required');
  const context = JSON.parse(readFileSync(values.context, 'utf8'));
  const board = nativeBoard(nativeBackendClient({ ...context, url: context.url ?? 'http://127.0.0.1:3210' }));
  if (values.json) console.log(JSON.stringify(await board.read(), null, 2));
  else {
    requireValue(process.stdin.isTTY && process.stdout.isTTY, 'terminal_required', 'Interactive board requires a TTY, or use --json');
    await watchTaskBoardInk(board.read, { inspectTask: board.inspectTask, detailTask: board.detailTask,
      statusTask: board.statusTask, reviewTask: board.reviewTask });
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'board_failed', message: error.message })); process.exitCode = 1;
}
