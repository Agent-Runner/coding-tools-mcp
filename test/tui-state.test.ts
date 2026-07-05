import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApprovalRequest } from "../src/shared/approvals.js";
import type { ConductorEvent } from "../src/shared/types.js";
import { deriveMcpServers, listTuiSessions, loadTuiSnapshot } from "../src/tui/state.js";

describe("TUI session state", () => {
  it("loads attached v1 sessions from JSONL logs", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-tui-home-"));
    process.env.CTC_HOME = home;
    await mkdir(join(home, "logs"), { recursive: true });

    await writeSessionLog(home, "session-a", "/repo/api", "direct");
    await writeSessionLog(home, "session-b", "/repo/web", "worktree");
    await createApprovalRequest("session-b", "{\"permission\":\"network\"}", { permission: "network" });

    const sessions = await listTuiSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(expect.arrayContaining(["session-a", "session-b"]));
    expect(sessions.find((session) => session.sessionId === "session-b")?.pendingApprovalCount).toBe(1);

    const snapshot = await loadTuiSnapshot({ requestedSessionId: "session-b", initialWorkspacePath: "/repo/web" });
    expect(snapshot.sessionId).toBe("session-b");
    expect(snapshot.session?.workspacePath).toBe("/repo/web");
    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.allPendingApprovals).toHaveLength(1);
  });

  it("keeps server_status events when parsing logs and derives per-server rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-tui-home-"));
    process.env.CTC_HOME = home;
    await mkdir(join(home, "logs"), { recursive: true });
    const sessionId = "session-mcp";
    const lines = [
      {
        ts: "2026-07-03T12:00:00.000Z",
        sessionId,
        type: "session_started",
        workspacePath: "/repo/api",
        defaultMode: "direct",
        backendType: "stdio",
        backendStatus: { connected: true, reconnecting: false },
        logPath: join(home, "logs", `${sessionId}.jsonl`),
        mcpServers: [{ name: "github", source: "profile", state: "connected", toolCount: 12 }],
      },
      { ts: "2026-07-03T12:00:05.000Z", sessionId, type: "server_status", server: "github", state: "disconnected", error: "closed" },
    ];
    await writeFile(
      join(home, "logs", `${sessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const snapshot = await loadTuiSnapshot({ requestedSessionId: sessionId });
    expect(snapshot.events.some((event) => event.type === "server_status")).toBe(true);
    expect(snapshot.mcpServers).toEqual([
      expect.objectContaining({ name: "github", state: "disconnected", source: "profile", lastError: "closed" }),
    ]);
  });
});

describe("deriveMcpServers", () => {
  it("seeds from the session_started summary and folds later transitions", () => {
    const events: ConductorEvent[] = [
      {
        ts: "1",
        sessionId: "s",
        type: "server_status",
        server: "stale",
        state: "connected",
      },
      {
        ts: "2",
        sessionId: "s",
        type: "session_started",
        workspacePath: "/w",
        defaultMode: "direct",
        backendType: "stdio",
        backendStatus: { connected: true, reconnecting: false },
        logPath: "l",
        mcpServers: [
          { name: "github", source: "profile", state: "connected", toolCount: 3 },
          { name: "docs", source: "workspace", state: "disabled", untrusted: true },
        ],
      },
      { ts: "3", sessionId: "s", type: "server_status", server: "github", state: "error", error: "boom" },
      { ts: "4", sessionId: "s", type: "server_status", server: "github", state: "connected", toolCount: 4 },
      { ts: "5", sessionId: "s", type: "server_status", server: "docs", state: "connected", toolCount: 1 },
    ];
    const servers = deriveMcpServers(events);
    expect(servers.find((server) => server.name === "stale")).toBeUndefined();
    expect(servers.find((server) => server.name === "github")).toMatchObject({ state: "connected", toolCount: 4 });
    expect(servers.find((server) => server.name === "docs")).toMatchObject({ state: "connected", toolCount: 1 });
  });
});

async function writeSessionLog(home: string, sessionId: string, workspacePath: string, defaultMode: "direct" | "worktree") {
  const sessionStarted = {
    ts: "2026-07-03T12:00:00.000Z",
    sessionId,
    type: "session_started",
    workspacePath,
    defaultMode,
    backendType: "stdio",
    backendStatus: { connected: true, reconnecting: false },
    logPath: join(home, "logs", `${sessionId}.jsonl`),
  };
  const toolCall = {
    ts: "2026-07-03T12:00:01.000Z",
    sessionId,
    type: "tool_call",
    tool: "read_file",
    argsSummary: "src/app.ts",
    resultSummary: "ok",
    durationMs: 12,
  };
  await writeFile(join(home, "logs", `${sessionId}.jsonl`), `${JSON.stringify(sessionStarted)}\n${JSON.stringify(toolCall)}\n`, "utf8");
}
