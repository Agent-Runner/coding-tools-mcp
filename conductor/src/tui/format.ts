import type { ReviewCheckpointEvent } from "../shared/types.js";
import type { DisplayLine } from "./theme.js";
import { palette } from "./theme.js";

export function timeOf(ts: string): string {
  return ts.slice(11, 19);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(Math.round(seconds % 60))}s`;
}

export function formatElapsedSeconds(startedAtMs: number, nowMs = Date.now()): string {
  return `${String(Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)))}s`;
}

/** Word-aware wrap that falls back to hard splits for unbroken runs. */
export function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  if (!value) return [""];
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      if (word.length > safeWidth) {
        if (current) {
          lines.push(current);
          current = "";
        }
        for (let index = 0; index < word.length; index += safeWidth) {
          const chunk = word.slice(index, index + safeWidth);
          if (chunk.length === safeWidth) lines.push(chunk);
          else current = chunk;
        }
        continue;
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= safeWidth) current = `${current} ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines.length ? lines : [""];
}

export function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function colorizeDiffLine(raw: string): DisplayLine {
  if (raw.startsWith("+++") || raw.startsWith("---")) return { text: raw, bold: true };
  if (raw.startsWith("@@")) return { text: raw, color: palette.accent };
  if (raw.startsWith("+")) return { text: raw, color: palette.ok };
  if (raw.startsWith("-")) return { text: raw, color: palette.error };
  if (raw.startsWith("diff ")) return { text: raw, bold: true, color: palette.warn };
  return { text: raw };
}

export function diffDisplayLines(checkpoint: ReviewCheckpointEvent | undefined): DisplayLine[] {
  if (!checkpoint) return [{ text: "No review checkpoint recorded yet.", dim: true }];
  const lines: DisplayLine[] = [{ text: checkpoint.statSummary, bold: true }];
  const body = checkpoint.diff?.trimEnd();
  if (!body) {
    lines.push({ text: "No diff body recorded for the latest checkpoint.", dim: true });
    return lines;
  }
  for (const raw of body.split("\n")) lines.push(colorizeDiffLine(raw));
  if (checkpoint.truncated) lines.push({ text: "… diff truncated by the review checkpoint limit.", dim: true });
  return lines;
}

export function textDisplayLines(text: string): DisplayLine[] {
  return text.split("\n").map((line) => ({ text: line }));
}
