import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerPool } from "../src/proxy/pool.js";
import type { ExtraServerStatus, ResolvedMcpServer } from "../src/shared/types.js";

const FIXTURE = "test/fixtures/line-extra.mjs";

function stdioServer(name: string, fixtureArgs: string[], overrides: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name,
    source: "profile",
    transport: { type: "stdio", command: process.execPath, args: [FIXTURE, ...fixtureArgs] },
    enabled: true,
    ...overrides,
  };
}

const pools: McpServerPool[] = [];

function trackedPool(servers: ResolvedMcpServer[], hooks?: ConstructorParameters<typeof McpServerPool>[1]): McpServerPool {
  const pool = new McpServerPool(servers, hooks);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe("McpServerPool", () => {
  it("aggregates multiple servers with prefixed tools and routes calls to the owner", async () => {
    const pool = trackedPool([
      stdioServer("alpha", ["--tools", "echo", "--label", "alpha"]),
      stdioServer("beta", ["--tools", "search", "--label", "beta"]),
    ]);
    await pool.start();

    expect(pool.statuses().map((status) => [status.name, status.state])).toEqual([
      ["alpha", "connected"],
      ["beta", "connected"],
    ]);
    expect(pool.tools().map((tool) => tool.name)).toEqual(["alpha__echo", "beta__search"]);

    expect(pool.resolve("alpha__echo")).toEqual({ server: "alpha", tool: "echo" });
    expect(pool.resolve("unprefixed")).toBeUndefined();

    const result = await pool.callTool("beta", "search", {});
    expect(result.content).toEqual([{ type: "text", text: "beta:search:ok" }]);
  });

  it("resolves prefixed names against the longest matching server name", () => {
    const pool = trackedPool([
      stdioServer("a", [], { enabled: false }),
      stdioServer("a__b", [], { enabled: false }),
    ]);
    expect(pool.resolve("a__b__x")).toEqual({ server: "a__b", tool: "x" });
    expect(pool.resolve("a__x")).toEqual({ server: "a", tool: "x" });
    expect(pool.resolve("a__")).toBeUndefined();
  });

  it("resolves a colliding exposed name to the same server the tool list shows", async () => {
    // a's tool `b__x` and a__b's tool `x` both expose as `a__b__x`; naive
    // longest-prefix parsing would call a__b while the list showed a's tool.
    const pool = trackedPool([
      stdioServer("a", ["--tools", "b__x", "--label", "a"]),
      stdioServer("a__b", ["--tools", "x", "--label", "a__b"]),
    ]);
    await pool.start();

    expect(pool.tools().map((tool) => tool.name)).toEqual(["a__b__x", "a__b__x"]);
    expect(pool.resolve("a__b__x")).toEqual({ server: "a", tool: "b__x" });
    expect(pool.entries().map((entry) => [entry.name, entry.server])).toEqual([
      ["a__b__x", "a"],
      ["a__b__x", "a__b"],
    ]);

    const winner = pool.resolve("a__b__x");
    const result = await pool.callTool(winner?.server ?? "", winner?.tool ?? "", {});
    expect(result.content).toEqual([{ type: "text", text: "a:b__x:ok" }]);
  });

  it("keeps healthy siblings serving when one server fails to start", async () => {
    const pool = trackedPool([
      stdioServer("alpha", ["--tools", "echo", "--label", "alpha"]),
      stdioServer("broken", [], { transport: { type: "stdio", command: "ctc-definitely-not-a-real-mcp-server" } }),
    ]);
    await pool.start(); // must not throw

    const byName = new Map(pool.statuses().map((status) => [status.name, status]));
    expect(byName.get("alpha")?.state).toBe("connected");
    expect(byName.get("broken")?.state).toBe("error");
    expect(byName.get("broken")?.lastError).toBeTruthy();
    expect(pool.tools().map((tool) => tool.name)).toEqual(["alpha__echo"]);
  });

  it("reconnects in the background after a server crash and emits transitions only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-extra-"));
    const marker = join(dir, "failed-once");
    const seen: ExtraServerStatus[] = [];
    const pool = trackedPool(
      [stdioServer("alpha", ["--tools", "echo", "--label", "alpha", "--crash-marker", marker])],
      { onStatus: (status) => seen.push(status) },
    );
    await pool.start();

    await expect(pool.callTool("alpha", "echo", {})).rejects.toThrow(/reconnecting in background/);
    const recovered = await eventually(async () => pool.callTool("alpha", "echo", {}));
    expect(recovered.content).toEqual([{ type: "text", text: "alpha:echo:ok" }]);

    expect(seen.map((status) => status.state)).toEqual(["connected", "disconnected", "connected"]);
  });

  it("supports manual reconnect", async () => {
    const pool = trackedPool([stdioServer("alpha", ["--tools", "echo", "--label", "alpha"])]);
    await pool.start();
    const status = await pool.reconnect("alpha");
    expect(status.state).toBe("connected");
    expect(status.toolCount).toBe(1);
  });

  it("signals tool changes when only a description/schema changes, and stays quiet otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-extra-"));
    const changed: string[] = [];
    const pool = trackedPool(
      [
        stdioServer("stable", ["--tools", "echo", "--label", "stable"]),
        stdioServer("mutating", ["--tools", "echo", "--label", "mutating", "--rev-file", join(dir, "rev")]),
      ],
      { onToolsChanged: (server) => changed.push(server) },
    );
    await pool.start();

    // Reconnect re-lists; identical definitions must not re-broadcast.
    changed.length = 0;
    await pool.reconnect("stable");
    expect(changed).toEqual([]);

    // Same tool names but a revved description is still a tool-list change.
    await pool.reconnect("mutating");
    expect(changed).toEqual(["mutating"]);
  });

  it("disable hides tools and re-enable reconnects", async () => {
    const pool = trackedPool([stdioServer("alpha", ["--tools", "echo", "--label", "alpha"])]);
    await pool.start();

    const disabled = await pool.setEnabled("alpha", false);
    expect(disabled.state).toBe("disabled");
    expect(pool.tools()).toEqual([]);
    await expect(pool.callTool("alpha", "echo", {})).rejects.toThrow(/disabled/);

    const enabled = await pool.setEnabled("alpha", true);
    expect(enabled.state).toBe("connected");
    expect(pool.tools().map((tool) => tool.name)).toEqual(["alpha__echo"]);
  });

  it("filters and blocks per-server denied tools", async () => {
    const pool = trackedPool([stdioServer("alpha", ["--tools", "echo,search", "--label", "alpha"], { deny: ["search"] })]);
    await pool.start();
    expect(pool.tools().map((tool) => tool.name)).toEqual(["alpha__echo"]);
    await expect(pool.callTool("alpha", "search", {})).rejects.toThrow(/denied/);
  });

  it("keeps untrusted servers disabled until trust is granted", async () => {
    const pool = trackedPool([
      stdioServer("docs", ["--tools", "echo", "--label", "docs"], {
        source: "workspace",
        enabled: false,
        untrusted: true,
      }),
    ]);
    await pool.start();
    expect(pool.statuses()[0]).toMatchObject({ state: "disabled", untrusted: true });

    await expect(pool.setEnabled("docs", true)).rejects.toThrow(/untrusted/);

    const trusted = await pool.trust("docs");
    expect(trusted.state).toBe("connected");
    expect(pool.tools().map((tool) => tool.name)).toEqual(["docs__echo"]);
  });

  it("injects configured env values into stdio servers", async () => {
    process.env.CTC_TEST_POOL_ENV = "yes";
    try {
      const pool = trackedPool([
        stdioServer("needy", ["--tools", "echo", "--label", "needy", "--require-env", "NEED_ME"], {
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [FIXTURE, "--tools", "echo", "--label", "needy", "--require-env", "NEED_ME"],
            env: { NEED_ME: "env:CTC_TEST_POOL_ENV" },
          },
        }),
        stdioServer("bare", ["--tools", "echo", "--label", "bare", "--require-env", "NEED_ME"]),
      ]);
      await pool.start();
      const byName = new Map(pool.statuses().map((status) => [status.name, status]));
      expect(byName.get("needy")?.state).toBe("connected");
      expect(byName.get("bare")?.state).toBe("error");
    } finally {
      delete process.env.CTC_TEST_POOL_ENV;
    }
  });

  it("stops reconnecting after close", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-extra-"));
    const marker = join(dir, "failed-once");
    const pool = trackedPool([stdioServer("alpha", ["--tools", "echo", "--label", "alpha", "--crash-marker", marker])]);
    await pool.start();
    await expect(pool.callTool("alpha", "echo", {})).rejects.toThrow(/reconnecting/);
    await pool.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(pool.statuses()[0]?.state).not.toBe("connected");
  });
});

async function eventually<T>(operation: () => Promise<T>, timeoutMs = 5000): Promise<T> {
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
