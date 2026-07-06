import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { TuiSessionController, type ConductorRuntimeLike } from "../src/tui/session-controller.js";
import { WorkspaceManager, type ToolCaller } from "../src/workspace/manager.js";
import type { ExtraServerStatus, WorkspaceState } from "../src/shared/types.js";
import { createGitRepo } from "./git-fixtures.js";

describe("TuiSessionController tunnel guard", () => {
  it("refuses to start a tunnel when no live session is registered", async () => {
    const controller = new TuiSessionController();
    await expect(
      controller.startTunnel({
        provider: "cloudflared",
        command: "cloudflared-not-a-real-binary",
        baseArgs: ["tunnel", "--url"],
        startupTimeoutMs: 1000,
        label: "cloudflared",
      }),
    ).rejects.toThrow(/No live session to expose/);
    await controller.shutdown();
  });
});

describe("TuiSessionController single-session lifecycle", () => {
  it("hosts exactly one session and rejects a second create", async () => {
    const { controller, runtimes, repo } = await fakeControllerSetup();
    const first = await controller.create({ path: repo });
    expect(controller.activeSessionId()).toBe(first.sessionId);
    await expect(controller.create({ path: repo })).rejects.toThrow(/already live/);
    expect(runtimes).toHaveLength(1);
    await controller.shutdown();
  });

  it("replace closes the old session, stops its runtime, and opens a fresh one", async () => {
    const { controller, runtimes, repo } = await fakeControllerSetup();
    const first = await controller.create({ path: repo });
    const second = await controller.replace({ path: repo });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(controller.activeSessionId()).toBe(second.sessionId);
    expect(runtimes[0]?.calls).toContain("close_workspace");
    expect(runtimes[0]?.stopped).toBe(true);
    expect(runtimes[1]?.stopped).toBe(false);
    await controller.shutdown();
  });

  it("replace aborts on a dirty-blocked close and keeps the session live", async () => {
    const { controller, runtimes, repo } = await fakeControllerSetup();
    const first = await controller.create({ path: repo });
    const firstRuntime = runtimes[0];
    if (!firstRuntime) throw new Error("expected a runtime");
    firstRuntime.closeResult = { closed: false, dirty: true, message: "Worktree has uncommitted changes." };
    await expect(controller.replace({ path: repo })).rejects.toThrow(/\/close --force/);
    expect(controller.activeSessionId()).toBe(first.sessionId);
    expect(firstRuntime.stopped).toBe(false);
    firstRuntime.closeResult = undefined;
    await controller.shutdown();
  });

  it("shutdown stamps the workspace closed, stops the runtime, and clears the session", async () => {
    const { controller, runtimes, repo } = await fakeControllerSetup();
    await controller.create({ path: repo });
    await controller.shutdown();
    expect(runtimes[0]?.calls).toContain("close_workspace");
    expect(runtimes[0]?.stopped).toBe(true);
    expect(controller.activeSessionId()).toBeUndefined();
  });

  it("shutdown still stops the runtime when close_workspace fails", async () => {
    const { controller, runtimes, repo } = await fakeControllerSetup();
    await controller.create({ path: repo });
    const runtime = runtimes[0];
    if (!runtime) throw new Error("expected a runtime");
    runtime.failClose = true;
    await controller.shutdown();
    expect(runtime.stopped).toBe(true);
    expect(controller.activeSessionId()).toBeUndefined();
  });
});

describe("TuiSessionController clean", () => {
  it("returns an empty result when nothing is recorded", async () => {
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const controller = new TuiSessionController();
    await expect(controller.cleanCandidates()).resolves.toEqual([]);
    await expect(controller.clean({})).resolves.toEqual({ removed: [], skippedDirty: [], missing: [], prunedRecords: [] });
    await controller.shutdown();
  });

  it("skips dirty worktrees unless forced and closes their records", async () => {
    const repo = await createGitRepo("ctc-clean-repo-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(repo),
      sessionId: "session-clean",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });
    const opened = await manager.open({});
    const worktreePath = opened.workspace.activePath;

    const controller = new TuiSessionController();
    await expect(controller.cleanCandidates()).resolves.toEqual(["session-clean"]);

    await writeFile(join(worktreePath, "a.txt"), "dirty change\n", "utf8");
    const cautious = await controller.clean({});
    expect(cautious.skippedDirty).toEqual(["session-clean"]);
    expect(cautious.removed).toEqual([]);
    expect(existsSync(worktreePath)).toBe(true);

    const forced = await controller.clean({ force: true });
    expect(forced.removed).toEqual(["session-clean"]);
    expect(forced.prunedRecords).toContain("session-clean");
    expect(existsSync(worktreePath)).toBe(false);

    await expect(controller.cleanCandidates()).resolves.toEqual([]);
    await controller.shutdown();
  });
});

async function fakeControllerSetup(): Promise<{ controller: TuiSessionController; runtimes: FakeRuntime[]; repo: string }> {
  process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
  const repo = await mkdtemp(join(tmpdir(), "ctc-fake-repo-"));
  const runtimes: FakeRuntime[] = [];
  const controller = new TuiSessionController((options) => {
    const runtime = new FakeRuntime(options.sessionId, options.workspacePath);
    runtimes.push(runtime);
    return runtime;
  });
  return { controller, runtimes, repo };
}

/** Records lifecycle calls; canned structured results for open/close. */
class FakeRuntime implements ConductorRuntimeLike {
  readonly calls: string[] = [];
  stopped = false;
  failClose = false;
  closeResult: { closed: boolean; dirty?: boolean; message: string } | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly workspacePath: string,
  ) {}

  start(): Promise<void> {
    this.calls.push("start");
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.calls.push("stop");
    return Promise.resolve();
  }

  callTool(name: string): Promise<CallToolResult> {
    this.calls.push(name);
    if (name === "open_workspace") {
      const workspace: WorkspaceState = {
        sessionId: this.sessionId,
        mode: "direct",
        sourcePath: this.workspacePath,
        activePath: this.workspacePath,
        openedAt: new Date().toISOString(),
      };
      return Promise.resolve(jsonResult({ workspace }));
    }
    if (name === "close_workspace") {
      if (this.failClose) return Promise.reject(new Error("backend hung"));
      return Promise.resolve(jsonResult(this.closeResult ?? { closed: true, message: "Workspace closed." }));
    }
    throw new Error(`Unexpected tool ${name}`);
  }

  createServer(): Server {
    return new Server({ name: "fake", version: "0" }, { capabilities: {} });
  }

  mcpStatuses(): ExtraServerStatus[] {
    return [];
  }

  setMcpEnabled(): Promise<ExtraServerStatus> {
    return Promise.reject(new Error("not implemented"));
  }

  reconnectMcp(): Promise<ExtraServerStatus> {
    return Promise.reject(new Error("not implemented"));
  }

  trustMcp(): Promise<ExtraServerStatus> {
    return Promise.reject(new Error("not implemented"));
  }
}

function jsonResult(payload: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

/** Mirrors the coding-tools-mcp path contract used by workspace-manager tests. */
class FakeBackend implements ToolCaller {
  cwd?: string;

  constructor(private readonly workspaceRoot: string) {}

  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === "get_default_cwd") {
      const payload = { workspace: this.workspaceRoot, default_cwd: this.cwd ?? "." };
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      });
    }
    if (name !== "set_default_cwd") throw new Error(`Unexpected tool ${name}`);
    this.cwd = String(args.path);
    return Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false });
  }
}
