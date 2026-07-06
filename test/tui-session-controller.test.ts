import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { TuiSessionController } from "../src/tui/session-controller.js";
import { WorkspaceManager, type ToolCaller } from "../src/workspace/manager.js";
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
    await controller.closeClients();
  });
});

describe("TuiSessionController clean", () => {
  it("returns an empty result when nothing is recorded", async () => {
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const controller = new TuiSessionController();
    await expect(controller.cleanCandidates()).resolves.toEqual([]);
    await expect(controller.clean({})).resolves.toEqual({ removed: [], skippedDirty: [], missing: [] });
    await controller.closeClients();
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
    expect(existsSync(worktreePath)).toBe(false);

    await expect(controller.cleanCandidates()).resolves.toEqual([]);
    await controller.closeClients();
  });
});

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
