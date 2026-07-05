import { describe, expect, it } from "vitest";
import { TunnelManager, parseCloudflaredUrl, spawnFailureMessage } from "../src/tunnel/manager.js";

describe("TunnelManager", () => {
  it("parses trycloudflare URLs from cloudflared output", () => {
    expect(parseCloudflaredUrl("INFO https://example.trycloudflare.com is ready")).toBe(
      "https://example.trycloudflare.com",
    );
    expect(parseCloudflaredUrl("no tunnel yet")).toBeUndefined();
  });

  it("explains how to install cloudflared when the binary is missing", async () => {
    const manager = new TunnelManager({ binary: "ctc-test-missing-cloudflared" });
    await expect(manager.start("http://127.0.0.1:1")).rejects.toThrow(/not installed or not on PATH/);
    expect(manager.status().running).toBe(false);
  });

  it("keeps the plain failure message for non-ENOENT spawn errors", () => {
    const error = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    expect(spawnFailureMessage("cloudflared", error)).toBe("cloudflared failed to start: spawn EACCES");
  });

  it("starts a tunnel from any provider command and captures the public URL", async () => {
    const manager = new TunnelManager();
    const state = await manager.start("http://127.0.0.1:1", {
      provider: "wrangler",
      command: "bash",
      baseArgs: ["-c", "echo https://demo.trycloudflare.com; sleep 5"],
      startupTimeoutMs: 5000,
      label: "npx wrangler",
    });
    expect(state.running).toBe(true);
    expect(state.provider).toBe("wrangler");
    expect(state.publicUrl).toBe("https://demo.trycloudflare.com");
    await manager.stop();
    expect(manager.status().running).toBe(false);
  });
});
