import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { BackendClient } from "../src/proxy/client.js";

describe("BackendClient", () => {
  afterEach(() => {
    delete process.env.CTC_BACKEND_CONTROL_TIMEOUT_MS;
  });

  it("reports a missing stdio backend command without crashing", async () => {
    const client = new BackendClient({
      type: "stdio",
      command: ["ctc-definitely-not-a-real-backend-command"],
    });

    await expect(client.start()).rejects.toThrow(/stdio backend failed to start/);
    await client.close();
  });

  it("reports a backend that exits before speaking MCP instead of crashing on EPIPE", async () => {
    // false(1) quits without reading stdin; the initialize write races the
    // exit and used to surface as an uncaught EPIPE stream error.
    const falseBin = existsSync("/bin/false") ? "/bin/false" : "/usr/bin/false";
    const client = new BackendClient({ type: "stdio", command: [falseBin] });

    await expect(client.start()).rejects.toThrow(/stdio backend closed/);
    await client.close();
  });

  it("times out a backend that never answers instead of hanging forever", async () => {
    process.env.CTC_BACKEND_CONTROL_TIMEOUT_MS = "300";
    const client = new BackendClient({
      type: "stdio",
      command: [process.execPath, "test/fixtures/line-hang.mjs"],
    });

    await expect(client.start()).rejects.toThrow(/did not answer initialize within 300ms/);
    await client.close();
  });

  it("reconnects after a stdio backend process exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-backend-"));
    const marker = join(dir, "failed-once");
    const client = new BackendClient({
      type: "stdio",
      command: [process.execPath, "test/fixtures/line-backend.mjs", marker],
    });

    await client.start();
    expect(client.tools().map((tool) => tool.name)).toContain("server_info");
    await expect(client.callTool("unstable", {})).rejects.toThrow(/reconnecting in background/);

    const recovered = await eventually(async () => client.callTool("unstable", {}));
    expect(recovered.isError).toBe(false);
    expect(recovered.content[0]?.type).toBe("text");
    await client.close();
  });

  it("does not reconnect after close is called during a reconnect delay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-backend-"));
    const marker = join(dir, "failed-once");
    const client = new BackendClient({
      type: "stdio",
      command: [process.execPath, "test/fixtures/line-backend.mjs", marker],
    });

    await client.start();
    await expect(client.callTool("unstable", {})).rejects.toThrow(/reconnecting in background/);
    expect(client.status().reconnecting).toBe(true);

    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(client.status().reconnecting).toBe(false);
    expect(client.status().connected).toBe(false);
  });
});

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
