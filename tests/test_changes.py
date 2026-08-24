from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from coding_tools_mcp.changes import apply_line_edits, content_lines, parse_changes, split_lines
from coding_tools_mcp.errors import ToolFailure
from coding_tools_mcp.patching import content_revision
from coding_tools_mcp.server import Runtime


def edit(**fields: object) -> dict[str, object]:
    return dict(fields)


class LineSemanticsTests(unittest.TestCase):
    """The line model has to be the one read_file reports, exactly."""

    def test_empty_content_is_zero_lines_not_one_blank_line(self) -> None:
        # "".split("\n") is [""], which would leave a stray blank line behind
        # every emptied range.
        self.assertEqual(content_lines(""), [])
        self.assertEqual(content_lines("a"), ["a"])

    def test_a_trailing_newline_adds_a_blank_line(self) -> None:
        self.assertEqual(content_lines("a\n"), ["a", ""])

    def test_line_counting_matches_read_file(self) -> None:
        self.assertEqual(split_lines("a\nb\n"), (["a", "b"], True))
        self.assertEqual(split_lines("a\nb"), (["a", "b"], False))
        self.assertEqual(split_lines(""), ([], False))


class LineEditTests(unittest.TestCase):
    def apply(self, text: str, raw_edits: list[dict[str, object]]) -> str:
        change = parse_changes(
            [{"action": "edit", "path": "f.txt", "revision": "r", "edits": raw_edits}]
        )[0]
        return apply_line_edits(text, change.edits, "f.txt").content

    def test_replace_a_range(self) -> None:
        result = self.apply(
            "a\nb\nc\n", [edit(op="replace", start_line=2, end_line=2, content="B")]
        )
        self.assertEqual(result, "a\nB\nc\n")

    def test_replace_with_empty_content_deletes_the_range(self) -> None:
        result = self.apply("a\nb\nc\n", [edit(op="replace", start_line=2, end_line=2, content="")])
        self.assertEqual(result, "a\nc\n")

    def test_end_line_defaults_to_start_line(self) -> None:
        self.assertEqual(self.apply("a\nb\n", [edit(op="replace", start_line=1, content="A")]), "A\nb\n")

    def test_insert_after_zero_writes_at_the_beginning(self) -> None:
        self.assertEqual(self.apply("a\n", [edit(op="insert_after", line=0, content="z")]), "z\na\n")

    def test_insert_before_past_the_last_line_appends(self) -> None:
        self.assertEqual(self.apply("a\nb\n", [edit(op="insert_before", line=3, content="c")]), "a\nb\nc\n")

    def test_insert_after_the_last_line_appends(self) -> None:
        self.assertEqual(self.apply("a\nb\n", [edit(op="insert_after", line=2, content="c")]), "a\nb\nc\n")

    def test_delete_removes_the_range(self) -> None:
        self.assertEqual(self.apply("a\nb\nc\n", [edit(op="delete", start_line=1, end_line=2)]), "c\n")

    def test_every_edit_addresses_the_file_as_read(self) -> None:
        # Both edits name original line numbers; the caller does not have to
        # predict how the first one shifts the second.
        result = self.apply(
            "a\nb\nc\nd\n",
            [
                edit(op="replace", start_line=1, end_line=1, content="one\ntwo\nthree"),
                edit(op="replace", start_line=4, end_line=4, content="D"),
            ],
        )
        self.assertEqual(result, "one\ntwo\nthree\nb\nc\nD\n")

    def test_a_file_with_no_trailing_newline_keeps_none(self) -> None:
        self.assertEqual(self.apply("a\nb", [edit(op="replace", start_line=1, content="A")]), "A\nb")

    def test_crlf_and_bom_survive(self) -> None:
        result = self.apply("\ufeffa\r\nb\r\n", [edit(op="replace", start_line=2, content="B")])
        self.assertEqual(result, "\ufeffa\r\nB\r\n")

    def test_deleting_every_line_leaves_an_empty_file(self) -> None:
        self.assertEqual(self.apply("a\nb\n", [edit(op="delete", start_line=1, end_line=2)]), "")

    def test_overlapping_edits_are_refused(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            self.apply(
                "a\nb\nc\n",
                [
                    edit(op="replace", start_line=1, end_line=2, content="x"),
                    edit(op="replace", start_line=2, end_line=3, content="y"),
                ],
            )
        self.assertEqual(raised.exception.code, "PATCH_HUNKS_OVERLAP")

    def test_two_insertions_at_one_point_are_refused(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            self.apply(
                "a\nb\n",
                [
                    edit(op="insert_after", line=1, content="x"),
                    edit(op="insert_before", line=2, content="y"),
                ],
            )
        self.assertEqual(raised.exception.code, "PATCH_HUNKS_OVERLAP")

    def test_an_edit_past_the_end_names_the_real_line_count(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            self.apply("a\nb\n", [edit(op="replace", start_line=9, content="x")])
        self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(raised.exception.details["total_lines"], 2)

    def test_changed_ranges_name_the_new_line_numbers(self) -> None:
        change = parse_changes(
            [
                {
                    "action": "edit",
                    "path": "f.txt",
                    "revision": "r",
                    "edits": [edit(op="insert_after", line=1, content="x\ny")],
                }
            ]
        )[0]
        outcome = apply_line_edits("a\nb\n", change.edits, "f.txt")
        self.assertEqual(
            outcome.changed_ranges,
            [{"start_line": 2, "end_line": 3, "added_lines": 2, "removed_lines": 0}],
        )


class ChangeParsingTests(unittest.TestCase):
    def test_an_empty_array_fails_like_an_empty_patch(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            parse_changes([])
        self.assertEqual(raised.exception.code, "PATCH_FAILED")
        self.assertEqual(raised.exception.message, "No files were modified.")

    def test_create_rejects_a_revision(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            parse_changes([{"action": "create", "path": "a.txt", "content": "x", "revision": "r"}])
        self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")

    def test_two_changes_to_one_path_are_refused(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            parse_changes(
                [
                    {"action": "write", "path": "a.txt", "content": "x", "revision": "r"},
                    {"action": "delete", "path": "a.txt", "revision": "r"},
                ]
            )
        self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")
        self.assertIn("apply_patch", raised.exception.message)

    def test_a_destination_that_collides_with_another_change_is_refused(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            parse_changes(
                [
                    {"action": "create", "path": "a.txt", "content": "x"},
                    {"action": "move", "path": "b.txt", "destination": "a.txt", "revision": "r"},
                ]
            )
        self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")

    def test_fields_that_do_not_belong_to_an_action_are_refused(self) -> None:
        for change in (
            {"action": "delete", "path": "a.txt", "revision": "r", "content": "x"},
            {"action": "edit", "path": "a.txt", "revision": "r", "content": "x"},
            {"action": "write", "path": "a.txt", "content": "x", "destination": "b.txt"},
        ):
            with self.subTest(change=change), self.assertRaises(ToolFailure) as raised:
                parse_changes([change])
            self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")


class ApplyChangesRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.workspace = Path(self._tmp.name)
        (self.workspace / "a.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
        self.runtime = Runtime(self.workspace, permission_mode="safe")

    def tearDown(self) -> None:
        self.runtime.close()
        self._tmp.cleanup()

    def revision(self, name: str) -> str:
        return content_revision((self.workspace / name).read_text(encoding="utf-8"))

    def test_an_edit_needs_the_revision_and_applies_with_it(self) -> None:
        change = {
            "action": "edit",
            "path": "a.txt",
            "edits": [edit(op="replace", start_line=2, content="BETA")],
        }
        with self.assertRaises(ToolFailure) as raised:
            self.runtime.apply_changes({"changes": [change]})
        self.assertEqual(raised.exception.code, "REVISION_REQUIRED")
        self.assertEqual(raised.exception.details["current_revision"], self.revision("a.txt"))

        payload = self.runtime.apply_changes({"changes": [{**change, "revision": self.revision("a.txt")}]})
        self.assertEqual((self.workspace / "a.txt").read_text(encoding="utf-8"), "alpha\nBETA\ngamma\n")
        evidence = payload["affected_files"][0]
        self.assertEqual(evidence["operation"], "edit")
        self.assertEqual(evidence["revision"], self.revision("a.txt"))
        self.assertEqual(evidence["total_lines"], 3)

    def test_a_stale_revision_is_refused_with_the_current_one(self) -> None:
        stale = self.revision("a.txt")
        (self.workspace / "a.txt").write_text("alpha\nbeta\ndelta\n", encoding="utf-8")
        with self.assertRaises(ToolFailure) as raised:
            self.runtime.apply_changes(
                {
                    "changes": [
                        {
                            "action": "edit",
                            "path": "a.txt",
                            "revision": stale,
                            "edits": [edit(op="replace", start_line=1, content="A")],
                        }
                    ]
                }
            )
        self.assertEqual(raised.exception.code, "REVISION_MISMATCH")
        self.assertEqual(raised.exception.details["current_revision"], self.revision("a.txt"))
        self.assertEqual((self.workspace / "a.txt").read_text(encoding="utf-8"), "alpha\nbeta\ndelta\n")

    def test_the_revision_read_file_publishes_is_the_one_apply_changes_takes(self) -> None:
        published = self.runtime.read_file({"path": "a.txt"})["revision"]
        self.runtime.apply_changes(
            {
                "changes": [
                    {
                        "action": "edit",
                        "path": "a.txt",
                        "revision": published,
                        "edits": [edit(op="delete", start_line=1)],
                    }
                ]
            }
        )
        self.assertEqual((self.workspace / "a.txt").read_text(encoding="utf-8"), "beta\ngamma\n")

    def test_create_refuses_an_existing_path_and_write_replaces_it(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            self.runtime.apply_changes({"changes": [{"action": "create", "path": "a.txt", "content": "x"}]})
        self.assertEqual(raised.exception.code, "PATCH_FAILED")

        self.runtime.apply_changes(
            {"changes": [{"action": "write", "path": "a.txt", "revision": self.revision("a.txt"), "content": "x\n"}]}
        )
        self.assertEqual((self.workspace / "a.txt").read_text(encoding="utf-8"), "x\n")

    def test_write_creates_a_missing_file_without_a_revision(self) -> None:
        payload = self.runtime.apply_changes(
            {"changes": [{"action": "write", "path": "new.txt", "content": "hello\n"}]}
        )
        self.assertEqual((self.workspace / "new.txt").read_text(encoding="utf-8"), "hello\n")
        self.assertEqual(payload["affected_files"][0]["operation"], "create")

    def test_write_over_an_existing_file_still_needs_the_revision(self) -> None:
        with self.assertRaises(ToolFailure) as raised:
            self.runtime.apply_changes({"changes": [{"action": "write", "path": "a.txt", "content": "x"}]})
        self.assertEqual(raised.exception.code, "REVISION_REQUIRED")

    def test_move_and_copy(self) -> None:
        self.runtime.apply_changes(
            {
                "changes": [
                    {
                        "action": "copy",
                        "path": "a.txt",
                        "revision": self.revision("a.txt"),
                        "destination": "copy.txt",
                    }
                ]
            }
        )
        self.assertTrue((self.workspace / "a.txt").exists())
        self.assertEqual((self.workspace / "copy.txt").read_text(encoding="utf-8"), "alpha\nbeta\ngamma\n")

        self.runtime.apply_changes(
            {
                "changes": [
                    {
                        "action": "move",
                        "path": "a.txt",
                        "revision": self.revision("a.txt"),
                        "destination": "moved.txt",
                    }
                ]
            }
        )
        self.assertFalse((self.workspace / "a.txt").exists())
        self.assertEqual((self.workspace / "moved.txt").read_text(encoding="utf-8"), "alpha\nbeta\ngamma\n")

    def test_a_move_onto_an_existing_path_is_refused(self) -> None:
        (self.workspace / "b.txt").write_text("other\n", encoding="utf-8")
        with self.assertRaises(ToolFailure) as raised:
            self.runtime.apply_changes(
                {
                    "changes": [
                        {
                            "action": "move",
                            "path": "a.txt",
                            "revision": self.revision("a.txt"),
                            "destination": "b.txt",
                        }
                    ]
                }
            )
        self.assertEqual(raised.exception.code, "PATCH_FAILED")

    def test_delete_removes_the_file(self) -> None:
        self.runtime.apply_changes(
            {"changes": [{"action": "delete", "path": "a.txt", "revision": self.revision("a.txt")}]}
        )
        self.assertFalse((self.workspace / "a.txt").exists())

    def test_a_dry_run_changes_nothing(self) -> None:
        payload = self.runtime.apply_changes(
            {
                "dry_run": True,
                "changes": [
                    {
                        "action": "edit",
                        "path": "a.txt",
                        "revision": self.revision("a.txt"),
                        "edits": [edit(op="replace", start_line=1, content="A")],
                    }
                ],
            }
        )
        self.assertIs(payload["dry_run"], True)
        self.assertEqual((self.workspace / "a.txt").read_text(encoding="utf-8"), "alpha\nbeta\ngamma\n")

    def test_a_no_op_change_reports_already_applied_and_does_not_rewrite(self) -> None:
        before = (self.workspace / "a.txt").stat().st_mtime_ns
        payload = self.runtime.apply_changes(
            {
                "changes": [
                    {
                        "action": "write",
                        "path": "a.txt",
                        "revision": self.revision("a.txt"),
                        "content": "alpha\nbeta\ngamma\n",
                    }
                ]
            }
        )
        self.assertIs(payload["already_applied"], True)
        self.assertEqual(payload["affected_files"][0]["operation"], "unchanged")
        self.assertEqual((self.workspace / "a.txt").stat().st_mtime_ns, before)

    def test_one_rejected_change_leaves_the_others_untouched(self) -> None:
        with self.assertRaises(ToolFailure):
            self.runtime.apply_changes(
                {
                    "changes": [
                        {"action": "create", "path": "first.txt", "content": "one\n"},
                        {"action": "edit", "path": "a.txt", "revision": "stale", "edits": [edit(op="delete", start_line=1)]},
                    ]
                }
            )
        self.assertFalse((self.workspace / "first.txt").exists())

    def test_paths_outside_the_workspace_are_refused_before_staging(self) -> None:
        for path in ("../escape.txt", "/etc/passwd"):
            with self.subTest(path=path), self.assertRaises(ToolFailure):
                self.runtime.apply_changes({"changes": [{"action": "create", "path": path, "content": "x"}]})

    def test_the_model_text_reports_the_new_revision(self) -> None:
        result = self.runtime.call_tool(
            "apply_changes",
            {
                "changes": [
                    {
                        "action": "edit",
                        "path": "a.txt",
                        "revision": self.revision("a.txt"),
                        "edits": [edit(op="replace", start_line=1, content="A")],
                    }
                ]
            },
        )
        text = result["content"][0]["text"]
        self.assertIn("Changes applied", text)
        self.assertIn(f"revision={self.revision('a.txt')}", text)

    def test_an_idempotency_key_replays_instead_of_reapplying(self) -> None:
        request = {
            "changes": [{"action": "create", "path": "new.txt", "content": "x\n"}],
            "idempotency_key": "k1",
        }
        first = self.runtime.call_tool("apply_changes", request)
        self.assertFalse(first["isError"])
        second = self.runtime.call_tool("apply_changes", request)
        self.assertFalse(second["isError"])
        self.assertIs(second["structuredContent"]["idempotent_replay"], True)


if __name__ == "__main__":
    unittest.main()
