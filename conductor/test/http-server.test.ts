import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConductorHttpServer } from "../src/server/http.js";

let http: ConductorHttpServer | undefined;

afterEach(async () => {
  await http?.close();
  http = undefined;
});

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
});

describe("ConductorHttpServer", () => {
  it("serves multiple concurrent clients on the stable /mcp URL", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));
    expect(registered.url.endsWith("/mcp")).toBe(true);

    const first = await connect(registered.url);
    const second = await connect(registered.url);
    await expect(first.client.listTools()).resolves.toEqual({ tools: [] });
    await expect(second.client.listTools()).resolves.toEqual({ tools: [] });
    await first.client.close();
    await second.client.close();
  });

  it("lets a client reconnect after terminating its MCP session", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    const first = await connect(registered.url);
    await first.transport.terminateSession();
    await first.client.close();

    const second = await connect(registered.url);
    await expect(second.client.listTools()).resolves.toEqual({ tools: [] });
    await second.client.close();
  });

  it("still routes explicit /mcp/<sessionId> paths", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    const attached = await connect(registered.sessionUrl);
    await expect(attached.client.listTools()).resolves.toEqual({ tools: [] });
    await attached.client.close();
  });

  it("points /mcp at the most recent session and falls back when it closes", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    await http.registerSession("session-a", () => createListToolsServer("server-a"));
    const registered = await http.registerSession("session-b", () => createListToolsServer("server-b"));

    const onB = await connect(registered.url);
    expect(onB.client.getServerVersion()?.name).toBe("server-b");
    await onB.client.close();

    await http.unregisterSession("session-b");
    const onA = await connect(registered.url);
    expect(onA.client.getServerVersion()?.name).toBe("server-a");
    await onA.client.close();
  });

  it("accepts wildcard and JSON-only Accept headers on POST", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    for (const accept of ["*/*", "application/json"]) {
      const response = await fetch(registered.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: accept },
        body: initializeBody,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeTruthy();
      expect(response.headers.get("content-type")).toContain("application/json");
    }
  });

  it("answers CORS preflight and marks CORS headers on responses", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    const preflight = await fetch(registered.url, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Mcp-Session-Id");

    const response = await fetch(registered.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*", Origin: "http://localhost:5173" },
      body: initializeBody,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-expose-headers")).toContain("Mcp-Session-Id");
  });

  it("returns 404 for unknown MCP session ids so clients re-initialize", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    const response = await fetch(registered.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "not-a-live-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects non-loopback origins and hosts when no bearer auth is set", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    const badOrigin = await fetch(registered.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*", Origin: "https://evil.example" },
      body: initializeBody,
    });
    expect(badOrigin.status).toBe(403);

    const badHost = await rawStatus(registered.url, { Host: "evil.example" });
    expect(badHost).toBe(403);
  });

  it("rejects unauthenticated requests when bearer auth is enabled", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));
    http.setBearerToken("secret-token");

    const response = await fetch(registered.url, { method: "GET", headers: { Accept: "text/event-stream" } });
    expect(response.status).toBe(401);

    const authorized = await fetch(registered.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "*/*",
        Authorization: "Bearer secret-token",
      },
      body: initializeBody,
    });
    expect(authorized.status).toBe(200);
  });
});

async function connect(url: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "ctc-test", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, transport };
}

function createListToolsServer(name: string): Server {
  const server = new Server({ name, version: "0.1.0" }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  return server;
}

function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, method: "GET", headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}
