import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface RegisteredHttpSession {
  sessionId: string;
  url: string;
  sessionUrl: string;
}

interface ActiveTransport {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
}

interface SessionRoute {
  sessionId: string;
  createServer: () => McpServer;
  transports: Map<string, ActiveTransport>;
}

const MCP_SESSION_HEADER = "mcp-session-id";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TRANSPORTS_PER_ROUTE = 64;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CORS_ALLOW_HEADERS = "Accept, Authorization, Content-Type, Last-Event-ID, Mcp-Session-Id, MCP-Protocol-Version";
const CORS_EXPOSE_HEADERS = "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate";

export class ConductorHttpServer {
  private readonly routes = new Map<string, SessionRoute>();
  private defaultRoute?: SessionRoute;
  private server?: NodeServer;
  private port?: number;
  private bearerToken?: string;

  constructor(private readonly host = "127.0.0.1") {}

  get origin(): string | undefined {
    return this.port ? `http://${this.host}:${String(this.port)}` : undefined;
  }

  async listen(port = 0): Promise<string> {
    if (this.server && this.origin) return this.origin;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("HTTP server was not created."));
        return;
      }
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.off("error", reject);
        const address = server.address() as AddressInfo | null;
        this.port = address?.port;
        resolve();
      });
    });
    if (!this.origin) throw new Error("HTTP server started without a port.");
    return this.origin;
  }

  /**
   * Register a conductor session behind the stable `/mcp` endpoint. Each MCP client that
   * POSTs an `initialize` request gets its own transport + Server instance (the SDK's
   * documented multi-session pattern); follow-up requests are routed by `Mcp-Session-Id`.
   */
  async registerSession(sessionId: string, createMcpServer: () => McpServer): Promise<RegisteredHttpSession> {
    if (!this.origin) await this.listen();
    await this.unregisterSession(sessionId);
    const route: SessionRoute = { sessionId, createServer: createMcpServer, transports: new Map() };
    this.routes.set(sessionId, route);
    this.defaultRoute = route;
    return { sessionId, url: this.mcpUrl(), sessionUrl: this.sessionUrl(sessionId) };
  }

  async unregisterSession(sessionId: string): Promise<void> {
    const route = this.routes.get(sessionId);
    if (!route) return;
    this.routes.delete(sessionId);
    if (this.defaultRoute === route) this.defaultRoute = [...this.routes.values()].pop();
    await closeRouteTransports(route);
  }

  /** Stable MCP endpoint serving the most recently registered session. */
  mcpUrl(): string {
    if (!this.origin) throw new Error("HTTP server is not listening.");
    return `${this.origin}/mcp`;
  }

  /** Explicit per-session endpoint for hosts running several conductor sessions at once. */
  sessionUrl(sessionId: string): string {
    if (!this.origin) throw new Error("HTTP server is not listening.");
    return `${this.origin}/mcp/${encodeURIComponent(sessionId)}`;
  }

  setBearerToken(token: string | undefined): void {
    this.bearerToken = token;
  }

  async close(): Promise<void> {
    const routes = [...this.routes.keys()];
    await Promise.all(routes.map((sessionId) => this.unregisterSession(sessionId)));
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, error instanceof Error ? error.message : "Internal error");
      } else {
        res.destroy();
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin ?? `http://${this.host}`);
    const match = /^\/mcp(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) {
      sendJsonRpcError(res, 404, -32001, "Unknown ctc MCP route.");
      return;
    }
    if (!this.isAllowedRequest(req)) {
      sendJsonRpcError(res, 403, -32600, "Origin or Host not allowed.");
      return;
    }
    applyCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { Allow: "GET, POST, DELETE, OPTIONS" });
      res.end();
      return;
    }
    if (!this.isAuthorized(req)) {
      sendJsonRpcError(res, 401, -32600, "Missing or invalid bearer token.", { "WWW-Authenticate": "Bearer" });
      return;
    }
    const explicitSessionId = match[1] ? decodeURIComponent(match[1]) : undefined;
    const route = explicitSessionId ? this.routes.get(explicitSessionId) : this.defaultRoute;
    if (!route) {
      const message = explicitSessionId ? `Unknown ctc session ${explicitSessionId}.` : "No active ctc session.";
      sendJsonRpcError(res, 404, -32001, message);
      return;
    }
    switch (req.method) {
      case "POST":
        await this.handlePost(route, req, res);
        return;
      case "GET":
      case "DELETE":
        await this.handleSessionScoped(route, req, res);
        return;
      default:
        sendJsonRpcError(res, 405, -32000, "Method not allowed.", { Allow: "GET, POST, DELETE, OPTIONS" });
    }
  }

  private async handlePost(route: SessionRoute, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined) {
      sendJsonRpcError(res, 413, -32600, "Request body exceeds maximum size.", { Connection: "close" });
      req.destroy();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
      return;
    }
    normalizeAcceptHeader(req);
    const mcpSessionId = headerValue(req, MCP_SESSION_HEADER);
    const active = mcpSessionId ? route.transports.get(mcpSessionId) : undefined;
    if (active) {
      active.lastUsedAt = Date.now();
      await active.transport.handleRequest(req, res, parsed);
      return;
    }
    if (isInitializeBody(parsed)) {
      await this.startTransport(route, req, res, parsed);
      return;
    }
    if (mcpSessionId) {
      // Spec: respond 404 for terminated/unknown sessions so the client starts a new
      // session with a fresh InitializeRequest.
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    sendJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
  }

  private async handleSessionScoped(route: SessionRoute, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") normalizeAcceptHeader(req);
    const mcpSessionId = headerValue(req, MCP_SESSION_HEADER);
    if (!mcpSessionId) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required. POST an initialize request first.");
      return;
    }
    const active = route.transports.get(mcpSessionId);
    if (!active) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    active.lastUsedAt = Date.now();
    await active.transport.handleRequest(req, res);
  }

  private async startTransport(route: SessionRoute, req: IncomingMessage, res: ServerResponse, parsed: unknown): Promise<void> {
    evictOldestTransports(route);
    const server = route.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      // Plain JSON responses keep clients that mishandle SSE bodies working; the spec
      // requires clients to accept both. Conductor sends no mid-request server messages,
      // so nothing is lost. The standalone GET SSE stream stays available either way.
      enableJsonResponse: true,
      onsessionclosed: (id) => {
        route.transports.delete(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) route.transports.delete(id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
    const mcpSessionId = transport.sessionId;
    if (mcpSessionId) route.transports.set(mcpSessionId, { server, transport, lastUsedAt: Date.now() });
  }

  private isAllowedRequest(req: IncomingMessage): boolean {
    // Tunnel mode: the bearer token is the gate; Host and Origin vary by tunnel provider.
    if (this.bearerToken) return true;
    // Local no-auth mode: require loopback Host and Origin to block DNS rebinding.
    if (!isLoopbackHostHeader(req.headers.host)) return false;
    const origin = req.headers.origin;
    return origin === undefined || isLoopbackOrigin(origin);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.bearerToken) return true;
    return req.headers.authorization === `Bearer ${this.bearerToken}`;
  }
}

async function closeRouteTransports(route: SessionRoute): Promise<void> {
  const active = [...route.transports.values()];
  route.transports.clear();
  await Promise.all(active.map(({ transport }) => transport.close().catch(() => undefined)));
}

function evictOldestTransports(route: SessionRoute): void {
  while (route.transports.size >= MAX_TRANSPORTS_PER_ROUTE) {
    let oldest: [string, ActiveTransport] | undefined;
    for (const candidate of route.transports) {
      if (!oldest || candidate[1].lastUsedAt < oldest[1].lastUsedAt) oldest = candidate;
    }
    if (!oldest) return;
    route.transports.delete(oldest[0]);
    void oldest[1].transport.close().catch(() => undefined);
  }
}

function isInitializeBody(parsed: unknown): boolean {
  return Array.isArray(parsed) ? parsed.some(isInitializeRequest) : isInitializeRequest(parsed);
}

// RFC 9110: a missing Accept header or */* means the client accepts any media type. The
// SDK transport matches literal substrings and would 406 those clients, so expand the
// wildcard forms into the pair it expects. A JSON-only Accept on POST is honored by
// appending the SSE type; responses stay JSON because enableJsonResponse is on.
function normalizeAcceptHeader(req: IncomingMessage): void {
  const accept = req.headers.accept;
  let normalized: string | undefined;
  if (!accept || accept.includes("*/*")) {
    normalized = "application/json, text/event-stream";
  } else if (req.method === "POST" && accept.includes("application/json") && !accept.includes("text/event-stream")) {
    normalized = `${accept}, text/event-stream`;
  }
  if (normalized === undefined) return;
  req.headers.accept = normalized;
  // The SDK's Node adapter rebuilds the web Request from rawHeaders, so patch both.
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i]?.toLowerCase() === "accept") raw.splice(i, 2);
  }
  raw.push("Accept", normalized);
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
}

function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
