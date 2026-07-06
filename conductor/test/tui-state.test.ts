import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApprovalRequest } from "../src/shared/approvals.js";
import type { ConductorEvent } from "../src/shared/types.js";
import { deriveMcpServers, latestSessionLogId, loadTuiSnapshot } from "../src/tui/state.js";

describe("TUI session state", () => {
  it("loads only the requested session's log and approvals", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-tui-home-"));
    process.env.CTC_HOME = home;
    await mkdir(join(home, "logs"), { recursive: true });

    await writeSessionLog(home, "session-a", "/repo/api", "direct");
    await writeSessionLog(home, "session-b", "/repo/web", "worktree");
    await createApprovalRequest("session-b", "{\"permission\":\"network\"}", { permission: "network" });

    const snapshot = await loadTuiSnapshot({ requestedSessionId: "session-b", initialWorkspacePath: "/repo/web" });
    expect(snapshot.sessionId).toBe("session-b");
    expect(snapshot.session?.workspacePath).toBe("/repo/web");
    expect(snapshot.events.every((event) => event.sessionId === "session-b")).toBe(true);
    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.label).toBe("web");

    const other = await loadTuiSnapshot({ requestedSessionId: "session-a" });
    expect(other.pendingApprovals).toHaveLength(0);
  });

  it("returns an empty snapshot without a requested session id", async () => {
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-tui-home-"));
    const snapshot = await loadTuiSnapshot({ initialWorkspacePath: "/repo" });
    expect(snapshot.sessionId).toBeUndefined();
    expect(snapshot.events).toEqual([]);
    expect(snapshot.pendingApprovals).toEqual([]);
  });

  it("latestSessionLogId picks the newest log by mtime", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-tui-home-"));
    process.env.CTC_HOME = home;
    await mkdir(join(home, "logs"), { recursive: true });
    await expect(latestSessionLogId()).resolves.toBeUndefined();

    await writeSessionLog(home, "session-old", "/repo/api", "direct");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeSessionLog(home, "session-new", "/repo/web", "direct");
    await expect(latestSessionLogId()).resolves.toBe("session-new");
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

  it("restores droppedTools from the baseline and keeps them only while connected", () => {
    const startedAt = (mcpServers: object[]): ConductorEvent => ({
      ts: "1",
      sessionId: "s",
      type: "session_started",
      workspacePath: "/w",
      defaultMode: "direct",
      backendType: "stdio",
      backendStatus: { connected: true, reconnecting: false },
      logPath: "l",
      mcpServers: mcpServers as never,
    });
    const baseline = startedAt([
      { name: "github", source: "profile", state: "connected", toolCount: 3, droppedTools: ["github__ping"] },
    ]);

    // Startup-time drops survive the session_started baseline.
    expect(deriveMcpServers([baseline])[0]?.droppedTools).toEqual(["github__ping"]);

    // Disconnect/error/disabled clear the list — it only describes a live connection.
    expect(
      deriveMcpServers([
        baseline,
        { ts: "2", sessionId: "s", type: "server_status", server: "github", state: "disconnected", error: "closed" },
      ])[0]?.droppedTools,
    ).toBeUndefined();

    // A reconnect without drops resets to an empty list instead of reviving the old one.
    expect(
      deriveMcpServers([
        baseline,
        { ts: "2", sessionId: "s", type: "server_status", server: "github", state: "disconnected", error: "closed" },
        { ts: "3", sessionId: "s", type: "server_status", server: "github", state: "connected", toolCount: 3 },
      ])[0]?.droppedTools,
    ).toEqual([]);

    // A connected update that reports drops replaces the baseline's list.
    expect(
      deriveMcpServers([
        baseline,
        { ts: "2", sessionId: "s", type: "server_status", server: "github", state: "connected", toolCount: 3, droppedTools: ["github__echo"] },
      ])[0]?.droppedTools,
    ).toEqual(["github__echo"]);
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
