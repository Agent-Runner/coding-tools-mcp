from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from coding_tools_mcp.breaker import RepeatFailureBreaker, argument_fingerprint
from coding_tools_mcp.server import Runtime


class ArgumentFingerprintTests(unittest.TestCase):
    def test_key_order_does_not_change_the_fingerprint(self) -> None:
        self.assertEqual(
            argument_fingerprint({"path": "a.txt", "start_line": 1}),
            argument_fingerprint({"start_line": 1, "path": "a.txt"}),
        )

    def test_a_different_value_is_a_different_call(self) -> None:
        self.assertNotEqual(
            argument_fingerprint({"path": "a.txt"}),
            argument_fingerprint({"path": "b.txt"}),
        )

    def test_varying_only_the_idempotency_key_does_not_dodge_the_breaker(self) -> None:
        self.assertEqual(
            argument_fingerprint({"patch": "p", "idempotency_key": "one"}),
            argument_fingerprint({"patch": "p", "idempotency_key": "two"}),
        )

    def test_unserializable_arguments_still_produce_a_fingerprint(self) -> None:
        self.assertIsInstance(argument_fingerprint({"value": object()}), str)


class RepeatFailureBreakerTests(unittest.TestCase):
    def test_the_third_identical_deterministic_failure_is_refused(self) -> None:
        breaker = RepeatFailureBreaker()
        self.assertIsNone(breaker.blocked_error_code("read_file", "fp"))
        breaker.record_failure("read_file", "fp", error_code="NOT_FOUND", retryable=False)
        self.assertIsNone(breaker.blocked_error_code("read_file", "fp"))
        breaker.record_failure("read_file", "fp", error_code="NOT_FOUND", retryable=False)
        self.assertEqual(breaker.blocked_error_code("read_file", "fp"), "NOT_FOUND")

    def test_a_retryable_failure_never_counts(self) -> None:
        breaker = RepeatFailureBreaker()
        for _ in range(5):
            breaker.record_failure("apply_patch", "fp", error_code="PATCH_CONFLICT", retryable=True)
        self.assertIsNone(breaker.blocked_error_code("apply_patch", "fp"))

    def test_a_success_with_the_same_arguments_clears_the_count(self) -> None:
        breaker = RepeatFailureBreaker()
        breaker.record_failure("read_file", "fp", error_code="NOT_FOUND", retryable=False)
        breaker.record_failure("read_file", "fp", error_code="NOT_FOUND", retryable=False)
        breaker.record_success("read_file", "fp")
        self.assertIsNone(breaker.blocked_error_code("read_file", "fp"))

    def test_different_arguments_have_their_own_budget(self) -> None:
        breaker = RepeatFailureBreaker()
        for _ in range(3):
            breaker.record_failure("read_file", "one", error_code="NOT_FOUND", retryable=False)
        self.assertIsNone(breaker.blocked_error_code("read_file", "two"))

    def test_the_entry_map_stays_bounded(self) -> None:
        breaker = RepeatFailureBreaker(capacity=4)
        for index in range(20):
            breaker.record_failure("read_file", f"fp{index}", error_code="NOT_FOUND", retryable=False)
        self.assertLessEqual(len(breaker._entries), 4)


class BreakerInRuntimeTests(unittest.TestCase):
    def call(self, runtime: Runtime, args: dict[str, object]) -> dict[str, object]:
        return runtime.call_tool("read_file", args)

    def test_a_verbatim_retry_loop_terminates_with_a_distinct_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime(Path(tmp), permission_mode="safe")
            try:
                args = {"path": "missing.txt"}
                first = self.call(runtime, args)
                second = self.call(runtime, args)
                third = self.call(runtime, args)
            finally:
                runtime.close()
        self.assertEqual(first["structuredContent"]["error"]["code"], "NOT_FOUND")
        # The second failure already warns that the next one will be refused.
        self.assertEqual(second["structuredContent"]["error"]["details"]["consecutive_identical_failures"], 2)
        self.assertEqual(third["structuredContent"]["error"]["code"], "REPEATED_CALL_BLOCKED")
        self.assertIs(third["structuredContent"]["error"]["retryable"], False)
        self.assertIn("REPEATED_CALL_BLOCKED", third["content"][0]["text"])

    def test_changing_the_arguments_is_never_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime(Path(tmp), permission_mode="safe")
            try:
                for _ in range(3):
                    self.call(runtime, {"path": "missing.txt"})
                other = self.call(runtime, {"path": "also-missing.txt"})
            finally:
                runtime.close()
        self.assertEqual(other["structuredContent"]["error"]["code"], "NOT_FOUND")

    def test_a_write_that_lands_makes_every_earlier_verdict_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime(Path(tmp), permission_mode="safe")
            try:
                self.call(runtime, {"path": "late.txt"})
                self.call(runtime, {"path": "late.txt"})
                self.assertEqual(
                    self.call(runtime, {"path": "late.txt"})["structuredContent"]["error"]["code"],
                    "REPEATED_CALL_BLOCKED",
                )
                created = runtime.call_tool(
                    "apply_patch",
                    {"patch": "*** Begin Patch\n*** Add File: late.txt\n+here\n*** End Patch\n"},
                )
                self.assertFalse(created["isError"])
                self.assertFalse(self.call(runtime, {"path": "late.txt"})["isError"])
            finally:
                runtime.close()

    def test_a_dry_run_changes_nothing_and_does_not_clear_the_breaker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Runtime(Path(tmp), permission_mode="safe")
            try:
                self.call(runtime, {"path": "late.txt"})
                self.call(runtime, {"path": "late.txt"})
                runtime.call_tool(
                    "apply_patch",
                    {
                        "patch": "*** Begin Patch\n*** Add File: other.txt\n+x\n*** End Patch\n",
                        "dry_run": True,
                    },
                )
                self.assertEqual(
                    self.call(runtime, {"path": "late.txt"})["structuredContent"]["error"]["code"],
                    "REPEATED_CALL_BLOCKED",
                )
            finally:
                runtime.close()

    def test_a_verbatim_patch_context_miss_counts_even_though_it_is_retryable(self) -> None:
        breaker = RepeatFailureBreaker()
        for _ in range(2):
            breaker.record_failure(
                "apply_patch", "fp", error_code="PATCH_CONTEXT_NOT_FOUND", retryable=True
            )
        self.assertEqual(breaker.blocked_error_code("apply_patch", "fp"), "PATCH_CONTEXT_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
