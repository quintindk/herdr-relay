import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const suite = String.raw`
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("toggle_board", sys.argv.pop(1))
board = importlib.util.module_from_spec(spec)
spec.loader.exec_module(board)


class ToggleBoardTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="relay-toggle-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.socket = str(self.directory / "fake.sock")
        self.enterContext(patch.dict(os.environ, {
            "HERDR_ENV": "1",
            "HERDR_PLUGIN_STATE_DIR": str(self.directory),
            "HERDR_SOCKET_PATH": self.socket,
            "HERDR_PANE_ID": "anchor-a",
        }, clear=True))
        self.enterContext(patch.object(board.subprocess, "run", side_effect=AssertionError(
            "Tests must not execute real Herdr controls")))
        self.enterContext(patch.object(board, "herdr", side_effect=self.herdr))
        session = hashlib.sha256(self.socket.encode()).hexdigest()[:16]
        self.state = self.directory / f"board-{session}.json"
        self.panes = {
            "anchor-a": self.pane("anchor-a", "terminal-a", "tab-a"),
            "anchor-b": self.pane("anchor-b", "terminal-b", "tab-b"),
            "unrelated": self.pane("unrelated", "terminal-u", "tab-a"),
            "other-board": self.pane("other-board", "terminal-other", "tab-b"),
        }
        self.other = self.identity(self.panes["other-board"])
        self.state.write_text(json.dumps([self.other]))
        self.calls = []
        self.width = 160
        self.zoomed = False
        self.sequence = 0
        self.open_response = None
        self.list_delay = 0
        self.peak_boards = 0

    def pane(self, pane_id, terminal_id, tab_id):
        return {"pane_id": pane_id, "terminal_id": terminal_id,
                "tab_id": tab_id, "cwd": f"/fake/{tab_id}/working directory"}

    def identity(self, pane):
        return {key: pane[key] for key in ("pane_id", "terminal_id")}

    def saved(self):
        return json.loads(self.state.read_text())

    def mutations(self):
        return [call for call in self.calls if call[:2] == ("plugin", "pane")]

    def herdr(self, *args):
        self.calls.append(args)
        if args[:2] == ("pane", "get"):
            self.assertEqual(len(args), 3)
            return {"pane": dict(self.panes[args[2]])}
        if args == ("pane", "list"):
            snapshot = [dict(pane) for pane in self.panes.values()]
            # Widen the race after taking the snapshot, without serialising the fake.
            time.sleep(self.list_delay)
            return {"panes": snapshot}
        if args[:2] == ("pane", "layout"):
            self.assertEqual(args[2], "--pane")
            self.assertIn(args[3], self.panes)
            return {"layout": {"zoomed": self.zoomed, "panes": [
                {"pane_id": pane_id, "rect": {"width": self.width, "height": 40}}
                for pane_id in self.panes
            ]}}
        if args[:3] == ("plugin", "pane", "open"):
            target = args[args.index("--target-pane") + 1]
            anchor = self.panes[target]
            self.assertEqual(args, (
                "plugin", "pane", "open", "--plugin", "quintindk.herdr-relay",
                "--entrypoint", "work", "--placement", "split", "--target-pane", target,
                "--direction", "right" if self.width >= 160 else "down",
                "--cwd", anchor["cwd"], "--no-focus",
            ))
            self.sequence += 1
            opened = self.pane(f"new-{self.sequence}", f"new-terminal-{self.sequence}",
                               anchor["tab_id"])
            self.panes[opened["pane_id"]] = opened
            self.peak_boards = max(self.peak_boards, sum(
                pane_id.startswith("new-") for pane_id in self.panes))
            if self.open_response is not None:
                return self.open_response
            return {"plugin_pane": {"pane": dict(opened)}}
        if args[:3] == ("plugin", "pane", "close"):
            self.assertEqual(len(args), 4)
            self.assertIn(args[3], self.panes)
            del self.panes[args[3]]
            return {}
        self.fail(f"Unexpected Herdr command: {args!r}")

    def test_open_close_open_preserves_unrelated_panes_and_other_tab(self):
        original = dict(self.panes)
        board.toggle()
        first = self.identity(self.panes["new-1"])
        self.assertEqual(self.saved(), [self.other, first])
        self.assertEqual(self.panes["new-1"]["tab_id"], "tab-a")
        board.toggle()
        self.assertEqual(self.panes, original)
        self.assertEqual(self.saved(), [self.other])
        board.toggle()
        self.assertEqual(self.saved(), [self.other, self.identity(self.panes["new-2"])])
        self.assertEqual([call[2] for call in self.mutations()], ["open", "close", "open"])
        self.assertEqual(self.mutations()[1], ("plugin", "pane", "close", "new-1"))
        self.assertEqual({key: self.panes[key] for key in original}, original)

    def test_reused_pane_or_terminal_id_is_not_closed(self):
        self.state.write_text(json.dumps([
            self.other,
            {"pane_id": "unrelated", "terminal_id": "old-terminal"},
            {"pane_id": "old-pane", "terminal_id": "terminal-a"},
            {"pane_id": "gone", "terminal_id": "gone-terminal"},
        ]))
        original = dict(self.panes)
        board.toggle()
        self.assertEqual([call[2] for call in self.mutations()], ["open"])
        self.assertEqual(self.saved(), [self.other, self.identity(self.panes["new-1"])])
        board.toggle()
        self.assertEqual(self.mutations()[-1], ("plugin", "pane", "close", "new-1"))
        self.assertEqual(self.panes, original)
        self.assertEqual(self.saved(), [self.other])

    def test_focused_context_overrides_environment_target(self):
        os.environ["HERDR_PLUGIN_CONTEXT_JSON"] = json.dumps({"focused_pane_id": "anchor-b"})
        board.toggle()
        self.assertEqual(self.calls[0], ("pane", "get", "anchor-b"))
        self.assertEqual(self.mutations(), [("plugin", "pane", "close", "other-board")])
        self.assertIn("unrelated", self.panes)
        self.assertEqual(self.saved(), [])
        board.toggle()
        opened = self.mutations()[-1]
        self.assertEqual(opened[opened.index("--target-pane") + 1], "anchor-b")
        self.assertEqual(self.panes["new-1"]["tab_id"], "tab-b")
        self.assertEqual(self.saved(), [self.identity(self.panes["new-1"])])

    def test_wide_splits_right_and_narrow_splits_down(self):
        for width, direction in ((240, "right"), (160, "right"), (159, "down"), (80, "down")):
            with self.subTest(width=width):
                self.width = width
                board.toggle()
                opened = self.mutations()[-1]
                self.assertEqual(opened[opened.index("--direction") + 1], direction)
                board.toggle()
                self.assertEqual(self.saved(), [self.other])

    def test_zoomed_layout_refuses_to_open(self):
        self.zoomed = True
        original = dict(self.panes)
        with self.assertRaisesRegex(RuntimeError, "Unzoom the pane"):
            board.toggle()
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.panes, original)
        self.assertEqual(self.saved(), [self.other])

    def test_missing_herdr_environment_refuses_before_commands_or_state(self):
        del os.environ["HERDR_ENV"]
        os.environ["HERDR_PLUGIN_STATE_DIR"] = str(self.directory / "must-not-exist")
        with self.assertRaisesRegex(RuntimeError, "Invoke this action from a Herdr pane"):
            board.toggle()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.directory / "must-not-exist").exists())
        self.assertEqual(self.saved(), [self.other])

    def test_concurrent_repeated_toggles_are_serialised_by_real_flock(self):
        original = dict(self.panes)
        self.list_delay = 0.01
        real_flock = board.fcntl.flock
        for iteration in range(10):
            with self.subTest(iteration=iteration):
                contention = threading.Barrier(2, timeout=5)

                def acquire(lock, operation):
                    self.assertEqual(operation, board.fcntl.LOCK_EX)
                    contention.wait()
                    return real_flock(lock, operation)

                self.calls.clear()
                with patch.object(board.fcntl, "flock", side_effect=acquire) as flock:
                    with ThreadPoolExecutor(max_workers=2) as executor:
                        futures = [executor.submit(board.toggle) for _ in range(2)]
                        for future in futures:
                            future.result(timeout=10)
                    self.assertEqual(flock.call_count, 2)
                mutations = self.mutations()
                self.assertEqual([call[2] for call in mutations], ["open", "close"])
                self.assertEqual(mutations[-1][-1], f"new-{iteration + 1}")
                self.assertEqual(self.panes, original)
                self.assertEqual(self.saved(), [self.other])
                self.assertEqual(self.peak_boards, 1)

    def test_unknown_open_response_does_not_guess_cleanup_target(self):
        original = dict(self.panes)
        for response in ({}, {"plugin_pane": {}}, {"unexpected": {"pane": original["unrelated"]}}):
            with self.subTest(response=response):
                self.open_response = response
                self.calls.clear()
                with self.assertRaises(KeyError):
                    board.toggle()
                self.assertEqual([call[2] for call in self.mutations()], ["open"])
                self.assertEqual(self.saved(), [self.other])
                self.assertEqual({key: self.panes[key] for key in original}, original)
                self.assertIn(f"new-{self.sequence}", self.panes)

    def test_save_failure_closes_only_the_pane_just_opened(self):
        original = dict(self.panes)
        for operation in ("write_text", "replace"):
            with self.subTest(operation=operation):
                self.calls.clear()
                with patch.object(Path, operation, side_effect=OSError("simulated save failure")):
                    with self.assertRaisesRegex(OSError, "simulated save failure"):
                        board.toggle()
                mutations = self.mutations()
                self.assertEqual([call[2] for call in mutations], ["open", "close"])
                self.assertEqual(mutations[-1], ("plugin", "pane", "close", f"new-{self.sequence}"))
                self.assertEqual(self.panes, original)
                self.assertEqual(self.saved(), [self.other])


unittest.main(verbosity=2)
`;

test('board toggle Python unittest suite uses fake Herdr controls', () => {
  const result = spawnSync('python3', ['-c', suite, fileURLToPath(new URL('../scripts/toggle-board.py', import.meta.url))], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
