import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConductorRuntime } from "../src/server/mcp.js";
import { SessionEventBus } from "../src/sessions/events.js";
import type {
  McpConfigIssue,
  ResolvedMcpServer,
  RuntimeOptions,
  ServerStatusEvent,
  SessionStartedEvent,
  ToolCallEvent,
} from "../src/shared/types.js";

const FIXTURE = "test/fixtures/line-extra.mjs";
const originalCtcHome = process.env.CTC_HOME;
let sandbox: string;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "ctc-aggregation-"));
  process.env.CTC_HOME = sandbox;
});

afterAll(() => {
  if (originalCtcHome === undefined) delete process.env.CTC_HOME;
  else process.env.CTC_HOME = originalCtcHome;
});

function extra(name: string, tools: string, overrides: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name,
    source: "profile",
    transport: { type: "stdio", command: process.execPath, args: [FIXTURE, "--tools", tools, "--label", name] },
    enabled: true,
    ...overrides,
  };
}

function runtimeOptions(input: {
  primaryTools?: string;
  mcpServers?: ResolvedMcpServer[];
  mcpConfigIssues?: McpConfigIssue[];
  deny?: string[];
  primaryCommand?: string[];
}): RuntimeOptions {
  const sessionId = `ctc-test-${Math.random().toString(36).slice(2, 10)}`;
  return {
    sessionId,
    workspacePath: sandbox,
    defaultMode: "direct",
    backend: {
      type: "stdio",
      command: input.primaryCommand ?? [
        process.execPath,
        FIXTURE,
        "--tools",
        input.primaryTools ?? "server_info",
        "--label",
        "primary",
      ],
    },
    toolPolicy: { deny: input.deny },
    adapters: [],
    logPath: join(sandbox, "logs", `${sessionId}.jsonl`),
    conciseLogs: false,
    mcpServers: input.mcpServers ?? [],
    mcpConfigIssues: input.mcpConfigIssues ?? [],
  };
}

interface Harness {
  runtime: ConductorRuntime;
  bus: SessionEventBus;
  sessionId: string;
}

const cleanups: (() => Promise<void>)[] = [];

async function startRuntime(options: RuntimeOptions): Promise<Harness> {
  const bus = new SessionEventBus();
  const runtime = new ConductorRuntime(options, { owner: "stdio", events: bus });
  cleanups.push(() => runtime.stop());
  await runtime.start();
  return { runtime, bus, sessionId: options.sessionId };
}

async function connectClient(runtime: ConductorRuntime): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = runtime.createServer();
  const client = new Client({ name: "aggregation-test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(() => client.close());
  return client;
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ConductorRuntime multi-server aggregation", () => {
  it("exposes conductor + unprefixed primary + prefixed extra tools", async () => {
    const { runtime } = await startRuntime(
      runtimeOptions({ mcpServers: [extra("alpha", "echo"), extra("beta", "search")] }),
    );
    const client = await connectClient(runtime);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("open_workspace");
    expect(names).toContain("server_info");
    expect(names).toContain("alpha__echo");
    expect(names).toContain("beta__search");

    const result = await runtime.callTool("alpha__echo", {});
    expect(result.content).toEqual([{ type: "text", text: "alpha:echo:ok" }]);
  });

  it("lets an exact primary tool name shadow the extra copy and records the drop", async () => {
    const { runtime, bus, sessionId } = await startRuntime(
      runtimeOptions({ primaryTools: "server_info,alpha__echo", mcpServers: [extra("alpha", "echo")] }),
    );
    const client = await connectClient(runtime);
    const names = (await client.listTools()).tools.filter((tool) => tool.name === "alpha__echo");
    expect(names).toHaveLength(1);

    const result = await runtime.callTool("alpha__echo", {});
    expect(result.content).toEqual([{ type: "text", text: "primary:alpha__echo:ok" }]);

    const statusEvents = bus.events(sessionId).filter((event): event is ServerStatusEvent => event.type === "server_status");
    expect(statusEvents.find((event) => event.server === "alpha")?.droppedTools).toEqual(["alpha__echo"]);
  });

  it("applies the global tool policy to prefixed names", async () => {
    const { runtime } = await startRuntime(
      runtimeOptions({ mcpServers: [extra("beta", "search")], deny: ["beta__search"] }),
    );
    const client = await connectClient(runtime);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("beta__search");

    const result = await runtime.callTool("beta__search", {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool beta__search is disabled by this workspace profile." }]);
  });

  it("attributes tool_call events to the owning extra server only", async () => {
    const { runtime, bus, sessionId } = await startRuntime(runtimeOptions({ mcpServers: [extra("beta", "search")] }));
    await runtime.callTool("beta__search", {});
    await runtime.callTool("server_info", {});

    const calls = bus.events(sessionId).filter((event): event is ToolCallEvent => event.type === "tool_call");
    expect(calls.find((event) => event.tool === "beta__search")?.server).toBe("beta");
    expect(calls.find((event) => event.tool === "server_info")?.server).toBeUndefined();
  });

  it("summarizes extras in session_started and reports config issues as error events", async () => {
    const { bus, sessionId } = await startRuntime(
      runtimeOptions({
        mcpServers: [extra("alpha", "echo")],
        mcpConfigIssues: [{ name: "broken", message: "Invalid MCP server entry broken." }],
      }),
    );
    const events = bus.events(sessionId);
    const started = events.find((event): event is SessionStartedEvent => event.type === "session_started");
    expect(started?.mcpServers).toEqual([{ name: "alpha", source: "profile", state: "connected", toolCount: 1 }]);

    const issue = events.find(
      (event): event is ServerStatusEvent => event.type === "server_status" && event.server === "broken",
    );
    expect(issue).toMatchObject({ state: "error", error: "Invalid MCP server entry broken." });
    // Issue events append after session_started so snapshot folding keeps them.
    expect(events.indexOf(issue as never)).toBeGreaterThan(events.indexOf(started as never));
  });

  it("keeps primary failures fatal while extra failures stay non-fatal", async () => {
    const broken: ResolvedMcpServer = {
      name: "broken",
      source: "profile",
      transport: { type: "stdio", command: "ctc-definitely-not-a-real-mcp-server" },
      enabled: true,
    };
    const healthy = await startRuntime(runtimeOptions({ mcpServers: [broken] }));
    expect(healthy.runtime.mcpStatuses()[0]?.state).toBe("error");

    const fatal = new ConductorRuntime(
      runtimeOptions({ primaryCommand: ["ctc-definitely-not-a-real-backend"], mcpServers: [extra("alpha", "echo")] }),
      { owner: "stdio", events: new SessionEventBus() },
    );
    cleanups.push(() => fatal.stop());
    await expect(fatal.start()).rejects.toThrow(/stdio backend failed to start/);
  });

  it("routes bare request_permissions to the primary even when an extra shadows it", async () => {
    const { runtime } = await startRuntime(
      runtimeOptions({ primaryTools: "server_info,request_permissions", mcpServers: [extra("x", "request_permissions")] }),
    );
    const client = await connectClient(runtime);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("x__request_permissions");

    const bare = await runtime.callTool("request_permissions", {});
    expect(bare.content).toEqual([{ type: "text", text: "primary:request_permissions:ok" }]);

    const prefixed = await runtime.callTool("x__request_permissions", {});
    expect(prefixed.content).toEqual([{ type: "text", text: "x:request_permissions:ok" }]);
  });

  it("broadcasts tools/list_changed when an extra server is toggled", async () => {
    const { runtime } = await startRuntime(runtimeOptions({ mcpServers: [extra("alpha", "echo")] }));
    const client = await connectClient(runtime);
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notified += 1;
    });

    await runtime.setMcpEnabled("alpha", false);
    await eventually(() => {
      if (!notified) throw new Error("no list_changed notification yet");
      return Promise.resolve();
    });

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("alpha__echo");
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
