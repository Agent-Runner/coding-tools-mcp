import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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

  it("serves the legacy HTTP+SSE transport to SDK SSE clients on /sse and /mcp/sse", async () => {
    http = new ConductorHttpServer();
    const origin = await http.listen();
    await http.registerSession("session-a", () => createListToolsServer("server-a"));

    for (const path of ["/sse", "/mcp/sse"]) {
      const client = new Client({ name: "ctc-legacy-test", version: "0.1.0" }, { capabilities: {} });
      const transport = new SSEClientTransport(new URL(`${origin}${path}`));
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("server-a");
      await expect(client.listTools()).resolves.toEqual({ tools: [] });
      await client.close();
    }
  });

  it("answers the legacy SSE probe on GET /mcp with the old handshake", async () => {
    http = new ConductorHttpServer();
    await http.listen();
    const registered = await http.registerSession("session-a", () => createListToolsServer("server-a"));

    // Transport-fallback probe used by connector platforms: GET the configured URL with
    // an SSE Accept and no Mcp-Session-Id, expecting the 2024-11-05 endpoint event.
    const probe = await fetch(registered.url, { headers: { Accept: "text/event-stream" } });
    expect(probe.status).toBe(200);
    expect(probe.headers.get("content-type")).toContain("text/event-stream");
    const body = probe.body;
    if (!body) throw new Error("SSE probe returned no body.");
    const reader = body.getReader();
    const handshake = await readSse(reader, (text) => text.includes("\n\n"));
    expect(handshake).toContain("event: endpoint");
    const endpoint = /data: (\S+)/.exec(handshake)?.[1];
    expect(endpoint).toContain("/messages?sessionId=");

    const posted = await fetch(new URL(endpoint ?? "", registered.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initializeBody,
    });
    expect(posted.status).toBe(202);
    const initialized = await readSse(reader, (text) => text.includes("serverInfo"));
    expect(initialized).toContain("server-a");
    await reader.cancel();
  });

  it("binds session-scoped legacy messages paths to their own ctc session", async () => {
    http = new ConductorHttpServer();
    const origin = await http.listen();
    await http.registerSession("session-a", () => createListToolsServer("server-a"));
    await http.registerSession("session-b", () => createListToolsServer("server-b"));

    // Open a legacy SSE stream against session-a and capture its transport id.
    const probe = await fetch(`${origin}/mcp/session-a/sse`, { headers: { Accept: "text/event-stream" } });
    expect(probe.status).toBe(200);
    const reader = probe.body?.getReader();
    if (!reader) throw new Error("SSE probe returned no body.");
    const handshake = await readSse(reader, (text) => text.includes("\n\n"));
    const transportSessionId = /sessionId=(\S+)/.exec(handshake)?.[1];
    expect(transportSessionId).toBeTruthy();

    const post = (path: string) =>
      fetch(`${origin}${path}?sessionId=${transportSessionId ?? ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: initializeBody,
      });

    // The transport belongs to session-a: the scoped session-b path must not reach it.
    expect((await post("/mcp/session-b/messages")).status).toBe(404);
    expect((await post("/mcp/session-a/messages")).status).toBe(202);
    expect((await post("/messages")).status).toBe(202);
    await reader.cancel();
  });

  it("serves a routable server card on /, plain GET /mcp, and /.well-known/mcp.json", async () => {
    http = new ConductorHttpServer();
    const origin = await http.listen();
    await http.registerSession("session-a", () => createListToolsServer("server-a"));

    for (const path of ["/", "/mcp", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      const card = (await response.json()) as { transport: { endpoint: string }; legacyTransport: { endpoint: string } };
      expect(card.transport.endpoint).toBe("/mcp");
      expect(card.legacyTransport.endpoint).toBe("/sse");
    }
  });

  it("aliases the tunnel root to the MCP endpoint for clients configured without /mcp", async () => {
    http = new ConductorHttpServer();
    const origin = await http.listen();
    await http.registerSession("session-a", () => createListToolsServer("server-a"));

    const response = await fetch(`${origin}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: initializeBody,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("returns 503 (not 404) when no ctc session is active", async () => {
    http = new ConductorHttpServer();
    const origin = await http.listen();

    const posted = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: initializeBody,
    });
    expect(posted.status).toBe(503);

    const probed = await fetch(`${origin}/mcp`, { headers: { Accept: "text/event-stream" } });
    expect(probed.status).toBe(503);

    const card = await fetch(`${origin}/`);
    expect(card.status).toBe(200);
  });

  it("keeps discovery public and legacy endpoints gated in bearer mode", async () => {
    http = new ConductorHttpServer();
    const origin = await http.listen();
    await http.registerSession("session-a", () => createListToolsServer("server-a"));
    http.setBearerToken("secret-token");

    const wellKnown = await fetch(`${origin}/.well-known/mcp.json`);
    expect(wellKnown.status).toBe(200);
    expect(((await wellKnown.json()) as { auth: { type: string } }).auth.type).toBe("bearer");

    const denied = await fetch(`${origin}/sse`, { headers: { Accept: "text/event-stream" } });
    expect(denied.status).toBe(401);

    const stream = await fetch(`${origin}/sse`, {
      headers: { Accept: "text/event-stream", Authorization: "Bearer secret-token" },
    });
    expect(stream.status).toBe(200);
    await stream.body?.cancel();

    const orphaned = await fetch(`${origin}/messages?sessionId=not-a-live-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
      body: initializeBody,
    });
    expect(orphaned.status).toBe(404);
  });

  it(
    "keeps idle keep-alive connections open past Node's 5s default for tunnel connection pools",
    { timeout: 15_000 },
    async () => {
      http = new ConductorHttpServer();
      const origin = await http.listen();
      await http.registerSession("session-a", () => createListToolsServer("server-a"));

      // Tunnel providers (cloudflared pools origin sockets for ~90s) reuse idle
      // connections; if the origin closes them first, the reused socket resets and the
      // tunnel answers 502 Bad Gateway. Reproduce the pool: two requests on one socket
      // with an idle gap beyond Node's 5s default.
      const target = new URL(origin);
      const socket = netConnect({ host: target.hostname, port: Number(target.port) });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      let closedByOrigin = false;
      socket.on("close", () => {
        closedByOrigin = true;
      });
      socket.on("error", () => undefined);
      const request = `GET / HTTP/1.1\r\nHost: ${target.host}\r\nAccept: application/json\r\nConnection: keep-alive\r\n\r\n`;

      socket.write(request);
      const first = await new Promise<string>((resolve) => socket.once("data", (data) => { resolve(data.toString("utf8")); }));
      expect(first).toContain("200 OK");

      await new Promise((resolve) => setTimeout(resolve, 6_500));
      expect(closedByOrigin).toBe(false);

      socket.write(request);
      const second = await new Promise<string>((resolve) => socket.once("data", (data) => { resolve(data.toString("utf8")); }));
      expect(second).toContain("200 OK");
      socket.destroy();
    },
  );
});

async function readSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (text: string) => boolean,
  timeoutMs = 4000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(text)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for SSE content. Received: ${JSON.stringify(text)}`);
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

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
