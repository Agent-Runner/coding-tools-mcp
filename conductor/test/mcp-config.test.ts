import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpServerConfigSchema,
  mcpServerFingerprint,
  mergeMcpServers,
  normalizeMcpTransport,
  readWorkspaceMcpServers,
  resolveConfigValue,
  resolveConfigValueMap,
} from "../src/profiles/mcp.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ctc-mcp-config-"));
}

async function writeWorkspaceMcp(root: string, content: string): Promise<void> {
  await mkdir(join(root, ".ctc"), { recursive: true });
  await writeFile(join(root, ".ctc", "mcp.json"), content, "utf8");
}

describe("mcpServerConfigSchema", () => {
  it("accepts stdio and http shapes and strips unknown keys", () => {
    const stdio = mcpServerConfigSchema.parse({
      command: "npx",
      args: ["@playwright/mcp@latest"],
      env: { TOKEN: "env:PW_TOKEN" },
      futureField: true,
    });
    expect(stdio).toEqual({ command: "npx", args: ["@playwright/mcp@latest"], env: { TOKEN: "env:PW_TOKEN" } });
    const http = mcpServerConfigSchema.parse({ type: "http", url: "https://example.com/mcp", headers: { A: "b" } });
    expect(http.url).toBe("https://example.com/mcp");
  });

  it("rejects invalid field types", () => {
    expect(() => mcpServerConfigSchema.parse({ command: 42 })).toThrow();
    expect(() => mcpServerConfigSchema.parse({ url: "not a url" })).toThrow();
  });
});

describe("normalizeMcpTransport", () => {
  it("normalizes by shape and validates declared type", () => {
    expect(normalizeMcpTransport("a", { command: "cmd" })).toEqual({ type: "stdio", command: "cmd" });
    expect(normalizeMcpTransport("a", { url: "https://x/mcp" })).toEqual({ type: "http", url: "https://x/mcp" });
    expect(() => normalizeMcpTransport("a", { command: "cmd", url: "https://x/mcp" })).toThrow(/not both/);
    expect(() => normalizeMcpTransport("a", {})).toThrow(/must set/);
    expect(() => normalizeMcpTransport("a", { type: "stdio", url: "https://x/mcp" })).toThrow(/type stdio/);
    expect(() => normalizeMcpTransport("a", { type: "http", command: "cmd" })).toThrow(/type http/);
  });
});

describe("readWorkspaceMcpServers", () => {
  it("returns empty for a missing file", async () => {
    const root = await tempWorkspace();
    await expect(readWorkspaceMcpServers(root)).resolves.toEqual({ servers: {}, issues: [] });
  });

  it("reports a file-level issue for invalid JSON instead of throwing", async () => {
    const root = await tempWorkspace();
    await writeWorkspaceMcp(root, "{ nope");
    const result = await readWorkspaceMcpServers(root);
    expect(result.servers).toEqual({});
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toMatch(/not valid JSON/);
  });

  it("drops invalid entries and bad names with per-entry issues", async () => {
    const root = await tempWorkspace();
    await writeWorkspaceMcp(
      root,
      JSON.stringify({
        mcpServers: {
          good: { command: "node" },
          "bad name!": { command: "node" },
          broken: { command: 42 },
        },
      }),
    );
    const result = await readWorkspaceMcpServers(root);
    expect(Object.keys(result.servers)).toEqual(["good"]);
    expect(result.issues.map((issue) => issue.name).sort()).toEqual(["bad name!", "broken"]);
  });
});

describe("mergeMcpServers", () => {
  it("prefers profile entries wholesale and keeps profile-then-workspace order", () => {
    const merged = mergeMcpServers({
      profileServers: { github: { command: "profile-github" }, zeta: { command: "zeta" } },
      workspaceServers: { alpha: { command: "alpha" }, github: { command: "workspace-github" } },
      trustAllWorkspace: true,
    });
    expect(merged.issues).toEqual([]);
    expect(merged.servers.map((server) => server.name)).toEqual(["github", "zeta", "alpha"]);
    const github = merged.servers[0];
    expect(github?.source).toBe("profile");
    expect(github?.transport).toEqual({ type: "stdio", command: "profile-github" });
  });

  it("marks workspace servers untrusted until the fingerprint matches", () => {
    const entry = { command: "node", args: ["server.mjs"] };
    const untrusted = mergeMcpServers({ workspaceServers: { alpha: entry } });
    expect(untrusted.servers[0]).toMatchObject({ name: "alpha", enabled: false, untrusted: true });

    const trusted = mergeMcpServers({
      workspaceServers: { alpha: entry },
      trustedWorkspaceMcp: { alpha: mcpServerFingerprint(entry) },
    });
    expect(trusted.servers[0]).toMatchObject({ name: "alpha", enabled: true });
    expect(trusted.servers[0]?.untrusted).toBeUndefined();

    const changed = mergeMcpServers({
      workspaceServers: { alpha: { ...entry, args: ["evil.mjs"] } },
      trustedWorkspaceMcp: { alpha: mcpServerFingerprint(entry) },
    });
    expect(changed.servers[0]).toMatchObject({ enabled: false, untrusted: true });
  });

  it("keeps disabled:true servers disabled even when trusted", () => {
    const merged = mergeMcpServers({ profileServers: { alpha: { command: "node", disabled: true } } });
    expect(merged.servers[0]).toMatchObject({ enabled: false });
    expect(merged.servers[0]?.untrusted).toBeUndefined();
  });

  it("converts normalize failures into issues and drops the entry", () => {
    const merged = mergeMcpServers({
      profileServers: { both: { command: "cmd", url: "https://x/mcp" }, ok: { command: "cmd" } },
    });
    expect(merged.servers.map((server) => server.name)).toEqual(["ok"]);
    expect(merged.issues[0]).toMatchObject({ name: "both" });
  });

  it("carries per-server allow/deny onto the resolved entry", () => {
    const merged = mergeMcpServers({
      profileServers: { alpha: { command: "cmd", allow: ["echo"], deny: ["rm"] } },
    });
    expect(merged.servers[0]).toMatchObject({ allow: ["echo"], deny: ["rm"] });
  });
});

describe("mcpServerFingerprint", () => {
  it("is stable across key order and unknown keys", () => {
    const left = mcpServerFingerprint({ command: "node", args: ["a"], env: { X: "1", Y: "2" } });
    const right = mcpServerFingerprint(
      JSON.parse('{"env":{"Y":"2","X":"1"},"args":["a"],"command":"node","junk":true}') as Record<string, never>,
    );
    expect(left).toBe(right);
    expect(left).not.toBe(mcpServerFingerprint({ command: "node", args: ["b"] }));
  });
});

describe("resolveConfigValue", () => {
  afterEach(() => {
    delete process.env.CTC_TEST_MCP_TOKEN;
  });

  it("passes literals, resolves env: references, and throws for missing vars", () => {
    expect(resolveConfigValue("literal")).toBe("literal");
    process.env.CTC_TEST_MCP_TOKEN = "secret";
    expect(resolveConfigValue("env:CTC_TEST_MCP_TOKEN")).toBe("secret");
    expect(resolveConfigValueMap({ A: "env:CTC_TEST_MCP_TOKEN", B: "plain" })).toEqual({ A: "secret", B: "plain" });
    delete process.env.CTC_TEST_MCP_TOKEN;
    expect(() => resolveConfigValue("env:CTC_TEST_MCP_TOKEN")).toThrow(/CTC_TEST_MCP_TOKEN/);
  });
});
