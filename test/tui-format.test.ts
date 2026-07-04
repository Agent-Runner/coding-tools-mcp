import { describe, expect, it } from "vitest";
import { colorizeDiffLine, diffDisplayLines, formatDuration, truncate, wrapText } from "../src/tui/format.js";
import type { ReviewCheckpointEvent } from "../src/shared/types.js";

describe("TUI formatting helpers", () => {
  it("formats durations across magnitudes", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(15_000)).toBe("15s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });

  it("truncates long values with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  it("wraps text on word boundaries and hard-splits unbroken runs", () => {
    expect(wrapText("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
    expect(wrapText("x".repeat(20), 8)).toEqual(["xxxxxxxx", "xxxxxxxx", "xxxx"]);
    expect(wrapText("", 8)).toEqual([""]);
  });

  it("colorizes unified diff lines", () => {
    expect(colorizeDiffLine("+added").color).toBe("green");
    expect(colorizeDiffLine("-removed").color).toBe("red");
    expect(colorizeDiffLine("@@ -1 +1 @@").color).toBe("cyan");
    expect(colorizeDiffLine("+++ b/file").bold).toBe(true);
    expect(colorizeDiffLine("diff --git a b").color).toBe("yellow");
    expect(colorizeDiffLine("context").color).toBeUndefined();
  });

  it("renders checkpoint diffs with stat header and truncation note", () => {
    expect(diffDisplayLines(undefined)[0]?.text).toMatch(/No review checkpoint/u);
    const checkpoint: ReviewCheckpointEvent = {
      ts: "2026-07-03T12:00:00.000Z",
      sessionId: "s",
      type: "review_checkpoint",
      since: "last_shown",
      base: "abc",
      snapshot: "def",
      statSummary: "1 file changed",
      diff: "diff --git a b\n+new line",
      truncated: true,
    };
    const lines = diffDisplayLines(checkpoint);
    expect(lines[0]).toEqual({ text: "1 file changed", bold: true });
    expect(lines.at(-1)?.text).toMatch(/truncated/u);
  });
});
