import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

interface ActiveLegacyTransport {
  routeSessionId: string;
  server: McpServer;
  transport: SSEServerTransport;
  keepalive: ReturnType<typeof setInterval>;
  lastUsedAt: number;
}

interface SessionRoute {
  sessionId: string;
  createServer: () => McpServer;
  transports: Map<string, ActiveTransport>;
}

/**
 * Where a request should be dispatched. `mcp` is the Streamable HTTP endpoint, `sse` and
 * `messages` are the legacy 2024-11-05 HTTP+SSE transport, and `discovery` is the
 * unauthenticated server card used by clients and humans to find the real endpoints.
 */
type RouteTarget =
  | { kind: "mcp"; sessionId?: string; isRoot?: boolean }
  | { kind: "sse"; sessionId?: string }
  | { kind: "messages" }
  | { kind: "discovery" };

const MCP_SESSION_HEADER = "mcp-session-id";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TRANSPORTS_PER_ROUTE = 64;
const MAX_LEGACY_TRANSPORTS = 64;
// Node closes idle keep-alive sockets after 5s by default, but tunnel providers pool
// origin connections much longer (cloudflared reuses them for ~90s idle). A pooled
// request landing on a socket the origin already closed is answered with 502 Bad
// Gateway by the tunnel. Keep origin sockets alive longer than any pool reuse window
// so the tunnel always closes first. headersTimeout must exceed keepAliveTimeout,
// otherwise Node re-arms a shorter clock while waiting for the next request's headers.
const KEEP_ALIVE_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 125_000;
// SSE comment pings keep free-tier tunnels (cloudflared idles streams out around 100s)
// and strict proxies from dropping otherwise-quiet legacy streams.
const LEGACY_KEEPALIVE_MS = 25_000;
const LEGACY_MESSAGES_PATH = "/messages";
const SERVER_CARD_SERVER = { name: "coding-tools-conductor", version: "0.1.0" };
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CORS_ALLOW_HEADERS = "Accept, Authorization, Content-Type, Last-Event-ID, Mcp-Session-Id, MCP-Protocol-Version";
const CORS_EXPOSE_HEADERS = "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate";

export class ConductorHttpServer {
  private readonly routes = new Map<string, SessionRoute>();
  private readonly legacyTransports = new Map<string, ActiveLegacyTransport>();
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
    this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    this.server.headersTimeout = HEADERS_TIMEOUT_MS;
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
    await this.closeLegacyTransports((entry) => entry.routeSessionId === sessionId);
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
    await this.closeLegacyTransports(() => true);
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
    const target = parseRoutePath(url.pathname);
    if (!target) {
      sendJsonRpcError(res, 404, -32001, "Unknown ctc MCP route. POST /mcp (Streamable HTTP) or GET /sse (legacy SSE).");
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
    // Discovery surfaces stay readable without auth (mirroring the lower server's
    // /.well-known behavior) so a misconfigured client fails with a routable card
    // instead of a bare 404.
    if (target.kind === "discovery" || (target.kind === "mcp" && target.isRoot && isPlainDiscoveryRequest(req))) {
      this.handleDiscovery(req, res);
      return;
    }
    if (!this.isAuthorized(req)) {
      sendJsonRpcError(res, 401, -32600, "Missing or invalid bearer token.", { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (target.kind === "messages") {
      await this.handleLegacyMessage(req, res, url);
      return;
    }
    const route = target.sessionId ? this.routes.get(target.sessionId) : this.defaultRoute;
    if (!route) {
      if (target.sessionId) {
        sendJsonRpcError(res, 404, -32001, `Unknown ctc session ${target.sessionId}.`);
      } else {
        // 503, not 404: the endpoint exists, there is just no live conductor session.
        // Clients probing transports treat 404 as "wrong URL" and give up.
        sendJsonRpcError(res, 503, -32000, "No active ctc session. Open a workspace in ctc, then retry.", {
          "Retry-After": "5",
        });
      }
      return;
    }
    if (target.kind === "sse") {
      if (req.method !== "GET") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed.", { Allow: "GET, OPTIONS" });
        return;
      }
      await this.startLegacyTransport(route, res);
      return;
    }
    switch (req.method) {
      case "POST":
        await this.handlePost(route, req, res);
        return;
      case "GET":
        if (!headerValue(req, MCP_SESSION_HEADER)) {
          // Streamable clients always send Mcp-Session-Id on GET. A GET without it and
          // with an explicit SSE Accept is the legacy-transport probe (the spec's
          // backwards-compatibility flow), so serve the old handshake here too.
          if (acceptsEventStream(req)) {
            await this.startLegacyTransport(route, res);
            return;
          }
          this.handleDiscovery(req, res);
          return;
        }
        await this.handleSessionScoped(route, req, res);
        return;
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

  /**
   * Legacy 2024-11-05 HTTP+SSE handshake: stream the `endpoint` event pointing at
   * `/messages?sessionId=...` and keep the response open for server messages. Hosts such
   * as connector platforms still probe (or only speak) this transport.
   */
  private async startLegacyTransport(route: SessionRoute, res: ServerResponse): Promise<void> {
    evictOldestLegacyTransports(this.legacyTransports);
    const server = route.createServer();
    const transport = new SSEServerTransport(LEGACY_MESSAGES_PATH, res);
    const entry: ActiveLegacyTransport = {
      routeSessionId: route.sessionId,
      server,
      transport,
      keepalive: setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
      }, LEGACY_KEEPALIVE_MS),
      lastUsedAt: Date.now(),
    };
    entry.keepalive.unref();
    transport.onclose = () => {
      clearInterval(entry.keepalive);
      this.legacyTransports.delete(transport.sessionId);
    };
    try {
      // connect() calls transport.start(), which writes the SSE headers + endpoint event.
      await server.connect(transport);
    } catch (error) {
      clearInterval(entry.keepalive);
      throw error;
    }
    this.legacyTransports.set(transport.sessionId, entry);
  }

  private async handleLegacyMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.", { Allow: "POST, OPTIONS" });
      return;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJsonRpcError(res, 400, -32000, "Bad Request: sessionId query parameter is required.");
      return;
    }
    const entry = this.legacyTransports.get(sessionId);
    if (!entry) {
      sendJsonRpcError(res, 404, -32001, "Session not found. Reconnect to /sse to establish a new one.");
      return;
    }
    entry.lastUsedAt = Date.now();
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
    // The SDK transport rejects a missing Content-Type outright; the body has already
    // been parsed, so default it instead of failing minimal clients.
    if (!req.headers["content-type"]) req.headers["content-type"] = "application/json";
    await entry.transport.handlePostMessage(req, res, parsed);
  }

  private handleDiscovery(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJsonRpcError(res, 405, -32000, "Method not allowed.", { Allow: "GET, HEAD, OPTIONS" });
      return;
    }
    sendJson(res, 200, this.serverCard(), req.method === "HEAD");
  }

  private serverCard(): object {
    return {
      server: SERVER_CARD_SERVER,
      transport: { type: "streamable_http", endpoint: "/mcp", methods: ["GET", "POST", "DELETE", "OPTIONS"] },
      legacyTransport: { type: "sse", endpoint: "/sse", messagesEndpoint: LEGACY_MESSAGES_PATH },
      auth: { type: this.bearerToken ? "bearer" : "none" },
      sessions: { active: this.routes.size, defaultEndpoint: "/mcp", byIdEndpoint: "/mcp/{ctc-session-id}" },
    };
  }

  private async closeLegacyTransports(match: (entry: ActiveLegacyTransport) => boolean): Promise<void> {
    const closing = [...this.legacyTransports.entries()].filter(([, entry]) => match(entry));
    for (const [sessionId, entry] of closing) {
      this.legacyTransports.delete(sessionId);
      clearInterval(entry.keepalive);
    }
    await Promise.all(closing.map(([, entry]) => entry.transport.close().catch(() => undefined)));
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

/**
 * Accepted URL space. Alongside the canonical `/mcp` routes, the tunnel root and the
 * legacy `/sse` + `/messages` pair are honored so clients configured with any of the
 * common URL shapes (`https://host`, `https://host/mcp`, `https://host/sse`) connect.
 */
function parseRoutePath(pathname: string): RouteTarget | undefined {
  if (pathname === "/") return { kind: "mcp", isRoot: true };
  if (pathname === "/.well-known/mcp.json" || pathname === "/.well-known/mcp/server-card.json") {
    return { kind: "discovery" };
  }
  let segments: string[];
  try {
    segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (segments.length === 1) {
    if (segments[0] === "mcp") return { kind: "mcp" };
    if (segments[0] === "sse") return { kind: "sse" };
    if (segments[0] === "messages") return { kind: "messages" };
    return undefined;
  }
  if (segments[0] !== "mcp") return undefined;
  if (segments.length === 2) {
    if (segments[1] === "sse") return { kind: "sse" };
    if (segments[1] === "messages") return { kind: "messages" };
    return { kind: "mcp", sessionId: segments[1] };
  }
  if (segments.length === 3 && segments[2] === "sse") return { kind: "sse", sessionId: segments[1] };
  if (segments.length === 3 && segments[2] === "messages") return { kind: "messages" };
  return undefined;
}

/** A root GET/HEAD that is neither a legacy SSE probe nor a streamable stream request. */
function isPlainDiscoveryRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return !headerValue(req, MCP_SESSION_HEADER) && !acceptsEventStream(req);
}

/**
 * Explicit SSE intent only: wildcard Accepts (curl, browsers) must not match, otherwise
 * a debugging GET would hang on an event stream instead of returning the server card.
 */
function acceptsEventStream(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").includes("text/event-stream");
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

function evictOldestLegacyTransports(transports: Map<string, ActiveLegacyTransport>): void {
  while (transports.size >= MAX_LEGACY_TRANSPORTS) {
    let oldest: [string, ActiveLegacyTransport] | undefined;
    for (const candidate of transports) {
      if (!oldest || candidate[1].lastUsedAt < oldest[1].lastUsedAt) oldest = candidate;
    }
    if (!oldest) return;
    transports.delete(oldest[0]);
    clearInterval(oldest[1].keepalive);
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

function sendJson(res: ServerResponse, status: number, payload: object, headOnly = false): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(headOnly ? undefined : body);
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
