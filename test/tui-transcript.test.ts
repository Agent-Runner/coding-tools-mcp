import { describe, expect, it } from "vitest";
import type { ConductorEvent, ReviewCheckpointEvent, ServerStatusEvent, ToolCallEvent } from "../src/shared/types.js";
import { TranscriptBuilder, type TranscriptItem } from "../src/tui/transcript.js";

function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    ts: "2026-07-03T12:00:01.000Z",
    sessionId: "session-a",
    type: "tool_call",
    tool: "read_file",
    argsSummary: '{"path":"src/app.ts"}',
    resultSummary: "ok",
    durationMs: 12,
    ...overrides,
  };
}

function checkpoint(overrides: Partial<ReviewCheckpointEvent> = {}): ReviewCheckpointEvent {
  return {
    ts: "2026-07-03T12:00:02.000Z",
    sessionId: "session-a",
    type: "review_checkpoint",
    since: "last_shown",
    base: "abc",
    snapshot: "def",
    statSummary: "1 file changed",
    diff: "+one\n-two",
    truncated: false,
    ...overrides,
  };
}

function itemText(item: TranscriptItem): string {
  if (item.kind !== "lines") return "";
  return item.lines.map((line) => line.map((span) => span.text).join("")).join("\n");
}

describe("TranscriptBuilder", () => {
  it("replays only the newest events on first attach and appends increments after", () => {
    const builder = new TranscriptBuilder();
    const events: ConductorEvent[] = [toolCall(), toolCall(), toolCall(), toolCall(), toolCall()];
    const first = builder.syncSession({ sessionId: "session-a", label: "api", events, width: 100, replayLimit: 2 });
    const texts = first.map(itemText);
    expect(texts[0]).toContain("session api");
    expect(texts[1]).toContain("3 earlier events not shown");
    // divider + hint + 2 replayed events
    expect(first).toHaveLength(4);

    const second = builder.syncSession({
      sessionId: "session-a",
      label: "api",
      events: [...events, toolCall({ tool: "write_file" })],
      width: 100,
      replayLimit: 2,
    });
    expect(second).toHaveLength(1);
    expect(second.map(itemText).join("\n")).toContain("write_file");
  });

  it("adds a divider when switching sessions and keeps per-session cursors", () => {
    const builder = new TranscriptBuilder();
    const a: ConductorEvent[] = [toolCall()];
    const b: ConductorEvent[] = [toolCall({ sessionId: "session-b", tool: "exec_command" })];
    builder.syncSession({ sessionId: "session-a", label: "api", events: a, width: 100 });
    const toB = builder.syncSession({ sessionId: "session-b", label: "web", events: b, width: 100 });
    expect(toB.map(itemText).join("\n")).toContain("session web");
    const backToA = builder.syncSession({ sessionId: "session-a", label: "api", events: a, width: 100 });
    // divider only; the single event was already consumed
    expect(backToA).toHaveLength(1);
    expect(backToA.map(itemText).join("\n")).toContain("session api");
  });

  it("renders tool errors and suppresses successful show_changes duplicates", () => {
    const builder = new TranscriptBuilder();
    const events: ConductorEvent[] = [
      checkpoint(),
      toolCall({ tool: "show_changes", resultSummary: "{...}" }),
      toolCall({ tool: "exec_command", error: "command failed", resultSummary: undefined }),
    ];
    const items = builder.syncSession({ sessionId: "session-a", label: "api", events, width: 100 });
    const text = items.map(itemText).join("\n");
    expect(text).toContain("1 file changed");
    expect(text).toContain("Error: command failed");
    // the successful show_changes tool_call is folded into the checkpoint card
    expect(text.match(/show_changes/gu)?.length).toBe(1);
  });

  it("keeps transcript keys unique across notes, dividers, and events", () => {
    const builder = new TranscriptBuilder();
    const items = [
      builder.note("hello", "info"),
      builder.note("done", "success"),
      builder.divider("session api"),
      ...builder.syncSession({ sessionId: "session-a", label: "api", events: [toolCall()], width: 100 }),
    ];
    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("marks notes by kind", () => {
    const builder = new TranscriptBuilder();
    expect(itemText(builder.note("saved", "success"))).toContain("✓ saved");
    expect(itemText(builder.note("boom", "error"))).toContain("✗ boom");
  });

  it("renders server_status transitions and the session_started mcp summary", () => {
    const builder = new TranscriptBuilder();
    const serverStatus = (overrides: Partial<ServerStatusEvent>): ServerStatusEvent => ({
      ts: "2026-07-03T12:00:03.000Z",
      sessionId: "session-a",
      type: "server_status",
      server: "github",
      state: "connected",
      ...overrides,
    });
    const events: ConductorEvent[] = [
      {
        ts: "2026-07-03T12:00:00.000Z",
        sessionId: "session-a",
        type: "session_started",
        workspacePath: "/repo/api",
        defaultMode: "direct",
        backendType: "stdio",
        backendStatus: { connected: true, reconnecting: false },
        logPath: "log.jsonl",
        mcpServers: [
          { name: "github", source: "profile", state: "connected", toolCount: 12 },
          { name: "docs", source: "workspace", state: "disabled", untrusted: true },
        ],
      },
      serverStatus({ toolCount: 12 }),
      serverStatus({ server: "playwright", state: "error", error: "spawn npx ENOENT" }),
      serverStatus({ server: "docs", state: "disabled", error: "not trusted" }),
    ];
    const text = builder
      .syncSession({ sessionId: "session-a", label: "api", events, width: 100 })
      .map(itemText)
      .join("\n");
    expect(text).toContain("mcp 1/2");
    expect(text).toContain("mcp github");
    expect(text).toContain("12 tools");
    expect(text).toContain("mcp playwright");
    expect(text).toContain("spawn npx ENOENT");
    expect(text).toContain("mcp docs disabled");
  });
});
