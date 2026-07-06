import type { ConductorEvent, ReviewCheckpointEvent, ServerStatusEvent, ToolCallEvent } from "../shared/types.js";
import { colorizeDiffLine, formatDuration, timeOf, truncate, wrapText } from "./format.js";
import { glyphs, palette } from "./theme.js";

/**
 * The transcript is an append-only log rendered through ink's <Static>, the
 * same model Claude Code uses: committed items flow into the terminal
 * scrollback and are never repainted, so only the small live region at the
 * bottom re-renders. This module is pure so it can be unit tested.
 */

export interface TranscriptSpan {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export interface BannerData {
  title: string;
  version: string;
  workspace: string;
  tips: string[];
}

export type TranscriptItem =
  | { key: string; kind: "lines"; lines: TranscriptSpan[][] }
  | { key: string; kind: "banner"; banner: BannerData };

export type NoteKind = "info" | "success" | "error" | "hint";

export interface SyncSessionInput {
  sessionId: string;
  label: string;
  events: ConductorEvent[];
  width: number;
  replayLimit?: number;
}

const DIFF_PREVIEW_LINES = 12;
const DEFAULT_REPLAY_LIMIT = 30;

export class TranscriptBuilder {
  private readonly cursors = new Map<string, number>();
  private counter = 0;
  private lastSessionId: string | undefined;

  banner(data: BannerData): TranscriptItem {
    return { key: this.nextKey("banner"), kind: "banner", banner: data };
  }

  note(text: string, kind: NoteKind = "info", width = 100): TranscriptItem {
    const marker: TranscriptSpan =
      kind === "success"
        ? { text: "✓ ", color: palette.ok }
        : kind === "error"
          ? { text: "✗ ", color: palette.error }
          : { text: `${glyphs.dot} `, dim: true };
    const body = wrapText(text, Math.max(20, width - 2));
    const lines = body.map((line, index): TranscriptSpan[] => [
      index === 0 ? marker : { text: "  " },
      { text: line, dim: kind === "hint" || kind === "info", color: kind === "error" ? palette.error : undefined },
    ]);
    return { key: this.nextKey("note"), kind: "lines", lines };
  }

  divider(label: string, width = 100): TranscriptItem {
    const prefix = `${glyphs.divider}${glyphs.divider} ${label} `;
    const fill = Math.max(2, Math.min(width, 100) - prefix.length);
    return {
      key: this.nextKey("div"),
      kind: "lines",
      lines: [[{ text: `${prefix}${glyphs.divider.repeat(fill)}`, dim: true }]],
    };
  }

  /**
   * Emit transcript items for events appended to a session log since the last
   * sync. The first sync of a session replays only the most recent
   * `replayLimit` events so attaching to a long-running session stays fast.
   */
  syncSession(input: SyncSessionInput): TranscriptItem[] {
    const { sessionId, label, events, width } = input;
    const replayLimit = input.replayLimit ?? DEFAULT_REPLAY_LIMIT;
    const items: TranscriptItem[] = [];
    if (this.lastSessionId !== sessionId) {
      items.push(this.divider(`session ${label}`, width));
      this.lastSessionId = sessionId;
    }
    const consumed = this.cursors.get(sessionId);
    const start = consumed ?? Math.max(0, events.length - replayLimit);
    if (consumed === undefined && start > 0) {
      items.push(this.note(`${String(start)} earlier events not shown; the full log lives in ~/.ctc/logs.`, "hint", width));
    }
    for (let index = start; index < events.length; index += 1) {
      const event = events[index];
      if (!event) continue;
      const item = this.eventItem(sessionId, index, event, events, width);
      if (item) items.push(item);
    }
    this.cursors.set(sessionId, events.length);
    return items;
  }

  private eventItem(
    sessionId: string,
    index: number,
    event: ConductorEvent,
    events: ConductorEvent[],
    width: number,
  ): TranscriptItem | undefined {
    const key = `${sessionId}:${String(index)}`;
    if (event.type === "tool_call") {
      // A successful show_changes is rendered by its richer review_checkpoint
      // sibling; keep the transcript free of the duplicate JSON summary.
      if (event.tool === "show_changes" && !event.error && hasCheckpointNear(events, index)) return undefined;
      return { key, kind: "lines", lines: toolCallLines(event, width) };
    }
    if (event.type === "permission_request") {
      if (event.state === "pending") {
        return {
          key,
          kind: "lines",
          lines: [
            [
              { text: `${glyphs.bullet} `, color: palette.warn },
              { text: "Permission requested ", bold: true },
              { text: truncate(event.argsSummary, Math.max(10, width - 24)), color: palette.warn },
            ],
          ],
        };
      }
      const color = event.state === "approved" ? palette.ok : palette.error;
      return {
        key,
        kind: "lines",
        lines: [[{ text: `  ${glyphs.result} `, dim: true }, { text: `permission ${event.state}`, color }]],
      };
    }
    if (event.type === "review_checkpoint") {
      return { key, kind: "lines", lines: checkpointLines(event, width) };
    }
    if (event.type === "server_status") {
      return { key, kind: "lines", lines: serverStatusLines(event, width) };
    }
    // session_started
    const mcpSummary = event.mcpServers?.length
      ? ` ${glyphs.dot} mcp ${String(event.mcpServers.filter((server) => server.state === "connected").length)}/${String(event.mcpServers.length)}`
      : "";
    return {
      key,
      kind: "lines",
      lines: [
        [
          {
            text: `${glyphs.dot} ${timeOf(event.ts)} session started ${glyphs.dot} owner ${event.owner ?? "stdio"} ${glyphs.dot} ${event.backendType} backend ${glyphs.dot} ${truncate(event.workspacePath, Math.max(10, width - 48))}${mcpSummary}`,
            dim: true,
          },
        ],
      ],
    };
  }

  private nextKey(prefix: string): string {
    this.counter += 1;
    return `${prefix}:${String(this.counter)}`;
  }
}

function toolCallLines(event: ToolCallEvent, width: number): TranscriptSpan[][] {
  const argsBudget = Math.max(10, width - event.tool.length - 4);
  const head: TranscriptSpan[] = [
    { text: `${glyphs.bullet} `, color: event.error ? palette.error : palette.ok },
    { text: event.tool, bold: true },
    { text: ` ${truncate(event.argsSummary, argsBudget)}` },
  ];
  const lines: TranscriptSpan[][] = [head];
  if (event.error) {
    const body = wrapText(`Error: ${event.error}`, Math.max(20, width - 4)).slice(0, 3);
    for (const [index, line] of body.entries()) {
      lines.push([{ text: index === 0 ? `  ${glyphs.result} ` : "    ", dim: true }, { text: line, color: palette.error }]);
    }
  } else {
    const summary = event.resultSummary ? truncate(event.resultSummary, Math.max(10, width - 16)) : "done";
    lines.push([
      { text: `  ${glyphs.result} `, dim: true },
      { text: `${summary} `, dim: true },
      { text: `(${formatDuration(event.durationMs)})`, dim: true },
    ]);
  }
  return lines;
}

function checkpointLines(event: ReviewCheckpointEvent, width: number): TranscriptSpan[][] {
  const lines: TranscriptSpan[][] = [
    [
      { text: `${glyphs.bullet} `, color: palette.accent },
      { text: "show_changes", bold: true },
      { text: ` ${glyphs.dot} since ${event.since.replace("_", "-")}`, dim: true },
    ],
    [{ text: `  ${glyphs.result} `, dim: true }, { text: event.statSummary || "no changes", bold: true }],
  ];
  const body = event.diff?.trimEnd();
  if (body) {
    const all = body.split("\n");
    for (const raw of all.slice(0, DIFF_PREVIEW_LINES)) {
      const styled = colorizeDiffLine(truncate(raw, Math.max(20, width - 4)));
      lines.push([{ text: "    " }, { text: styled.text, color: styled.color, bold: styled.bold }]);
    }
    const hidden = all.length - DIFF_PREVIEW_LINES;
    if (hidden > 0 || event.truncated) {
      const more = hidden > 0 ? `${String(hidden)} more lines` : "diff truncated";
      lines.push([{ text: `    … ${more} ${glyphs.dot} /diff to view`, dim: true }]);
    }
  }
  return lines;
}

function serverStatusLines(event: ServerStatusEvent, width: number): TranscriptSpan[][] {
  if (event.state === "connected") {
    const tools = event.toolCount !== undefined ? ` ${glyphs.dot} ${String(event.toolCount)} tools` : "";
    return [
      [
        { text: `${glyphs.bullet} `, color: palette.ok },
        { text: `mcp ${event.server}`, bold: true },
        { text: ` connected${tools}`, dim: true },
      ],
    ];
  }
  if (event.state === "disabled") {
    const reason = event.error ? ` ${glyphs.dot} ${event.error}` : "";
    return [[{ text: `${glyphs.dot} mcp ${event.server} disabled${reason}`, dim: true }]];
  }
  const lines: TranscriptSpan[][] = [
    [
      { text: `${glyphs.bullet} `, color: palette.error },
      { text: `mcp ${event.server}`, bold: true },
      { text: ` ${event.state}`, color: palette.error },
    ],
  ];
  if (event.error) {
    lines.push([
      { text: `  ${glyphs.result} `, dim: true },
      { text: truncate(event.error, Math.max(20, width - 6)), color: palette.error },
    ]);
  }
  return lines;
}

function hasCheckpointNear(events: ConductorEvent[], index: number): boolean {
  for (const offset of [-1, -2, 1, 2]) {
    if (events[index + offset]?.type === "review_checkpoint") return true;
  }
  return false;
}
