import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { WorkspaceManager, closeWorkspaceSession, mergeWorkspaceSession, type ToolCaller } from "../src/workspace/manager.js";
import { createGitRepo, git } from "./git-fixtures.js";

describe("WorkspaceManager", () => {
  it("opens an isolated worktree and leaves the source tree untouched", async () => {
    const repo = await createGitRepo("ctc-workspace-repo-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const backend = new FakeBackend(repo);
    const manager = new WorkspaceManager({
      backend,
      sessionId: "session-worktree",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    expect(opened.workspace.mode).toBe("worktree");
    expect(opened.workspace.activePath).not.toBe(repo);
    expect(backend.cwd).toBe(".ctc/worktrees/session-worktree");

    await writeFile(join(opened.workspace.activePath, "a.txt"), "worktree change\n", "utf8");
    await writeFile(join(opened.workspace.activePath, "new.txt"), "new file\n", "utf8");
    await expect(readFile(join(repo, "a.txt"), "utf8")).resolves.toBe("base\n");
    // The in-repo worktree is hidden from source-repo status via info/exclude.
    await expect(git(repo, ["status", "--porcelain=v1"])).resolves.toBe("");

    const blocked = await manager.close();
    expect(blocked.closed).toBe(false);
    expect(blocked.dirty).toBe(true);

    const closed = await manager.close({ force: true });
    expect(closed.closed).toBe(true);
    expect(existsSync(opened.workspace.activePath)).toBe(false);
    expect(backend.cwd).toBe(".");
  });

  it("opens a direct workspace by pointing the backend at the workspace-relative root", async () => {
    const repo = await createGitRepo("ctc-workspace-direct-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const backend = new FakeBackend(repo);
    const manager = new WorkspaceManager({
      backend,
      sessionId: "session-direct",
      defaultWorkspacePath: repo,
      defaultMode: "direct",
    });

    const opened = await manager.open({});
    expect(opened.workspace.mode).toBe("direct");
    expect(backend.cwd).toBe(".");
    await manager.close();
  });

  it("rejects workspace paths outside the backend workspace root", async () => {
    const repo = await createGitRepo("ctc-workspace-outside-");
    const otherRoot = await createGitRepo("ctc-workspace-other-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(otherRoot),
      sessionId: "session-outside",
      defaultWorkspacePath: repo,
      defaultMode: "direct",
    });

    await expect(manager.open({})).rejects.toThrow(/outside the backend workspace root/);
  });

  it("rolls back a worktree when the backend cwd update fails", async () => {
    const repo = await createGitRepo("ctc-workspace-rollback-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(repo, true),
      sessionId: "session-rollback",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    await expect(manager.open({})).rejects.toThrow(/set_default_cwd failed/);
    expect(manager.current()).toBeUndefined();
  });

  it("refuses to merge a worktree into a dirty source repository", async () => {
    const repo = await createGitRepo("ctc-workspace-dirty-merge-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(repo),
      sessionId: "session-dirty-merge",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    await writeFile(join(opened.workspace.activePath, "new.txt"), "worktree change\n", "utf8");
    await writeFile(join(repo, "source-dirty.txt"), "source dirty\n", "utf8");

    await expect(mergeWorkspaceSession("session-dirty-merge")).rejects.toThrow(/target repository has uncommitted changes/);
    await manager.close({ force: true });
  });

  it("merges clean worktree changes into the source repository", async () => {
    const repo = await createGitRepo("ctc-workspace-merge-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(repo),
      sessionId: "session-merge",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    await writeFile(join(opened.workspace.activePath, "a.txt"), "worktree change\n", "utf8");

    const merged = await mergeWorkspaceSession("session-merge");
    expect(merged.applied).toBe(true);
    await expect(readFile(join(repo, "a.txt"), "utf8")).resolves.toBe("worktree change\n");
    await manager.close({ force: true });
  });

  it("closes a recorded worktree session by id", async () => {
    const repo = await createGitRepo("ctc-workspace-close-by-id-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const manager = new WorkspaceManager({
      backend: new FakeBackend(repo),
      sessionId: "session-close-by-id",
      defaultWorkspacePath: repo,
      defaultMode: "worktree",
    });

    const opened = await manager.open({});
    await writeFile(join(opened.workspace.activePath, "new.txt"), "dirty\n", "utf8");

    const blocked = await closeWorkspaceSession("session-close-by-id");
    expect(blocked.closed).toBe(false);
    expect(blocked.dirty).toBe(true);

    const closed = await closeWorkspaceSession("session-close-by-id", { force: true });
    expect(closed.closed).toBe(true);
    expect(existsSync(opened.workspace.activePath)).toBe(false);
  });
});

/**
 * Mirrors the coding-tools-mcp path contract: paths are workspace-relative and
 * absolute paths are denied outright.
 */
class FakeBackend implements ToolCaller {
  cwd?: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly failSetCwd = false,
  ) {}

  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === "get_default_cwd") {
      return Promise.resolve(jsonResult({ workspace: this.workspaceRoot, default_cwd: this.cwd ?? "." }));
    }
    if (name !== "set_default_cwd") throw new Error(`Unexpected tool ${name}`);
    const path = String(args.path);
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
      return Promise.resolve(errorResult({ code: "ABSOLUTE_PATH_DENIED", message: "Absolute paths are denied." }));
    }
    if (this.failSetCwd) {
      return Promise.resolve({ content: [{ type: "text", text: "set_default_cwd failed" }], isError: true });
    }
    this.cwd = path;
    return Promise.resolve({ content: [{ type: "text", text: "ok" }], isError: false });
  }
}

function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function errorResult(error: { code: string; message: string }): CallToolResult {
  const payload = { ok: false, error };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}
