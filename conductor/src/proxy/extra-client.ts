import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveConfigValueMap } from "../profiles/mcp.js";
import type { CachedTool, ExtraServerState, ExtraServerStatus, ResolvedMcpServer } from "../shared/types.js";
import { BackendDisconnectedError } from "./client.js";

const CONNECT_TIMEOUT_MS = 8000;
const STDERR_TAIL_CHARS = 4000;

export interface ExtraClientHooks {
  /** Fired on state transitions only; reconnect retries update lastError silently. */
  onStatus?: (status: ExtraServerStatus) => void;
  /** Fired when the cached tool name set actually changed. */
  onToolsChanged?: () => void;
}

/**
 * MCP client for one additional third-party server. Unlike the primary
 * BackendClient this speaks the full SDK handshake (third-party servers send
 * notifications the hand-rolled line client would ignore), never calls
 * server_info, and treats connect failures as a per-server error state rather
 * than a fatal one.
 */
export class ExtraMcpClient {
  private readonly server: ResolvedMcpServer;
  private readonly hooks: ExtraClientHooks;
  private client: Client | undefined;
  private state: ExtraServerState;
  private lastError: string | undefined;
  private untrusted: boolean;
  private enabled: boolean;
  private cachedTools: CachedTool[] = [];
  private stderrTail = "";
  private reconnecting = false;
  private closed = false;

  constructor(server: ResolvedMcpServer, hooks: ExtraClientHooks = {}) {
    this.server = server;
    this.hooks = hooks;
    this.enabled = server.enabled;
    this.untrusted = server.untrusted === true;
    this.state = "disabled";
    if (this.untrusted) this.lastError = `not trusted; approve with /mcp trust ${server.name} or --trust-workspace-mcp`;
    else if (!this.enabled) this.lastError = "disabled in config";
  }

  name(): string {
    return this.server.name;
  }

  status(): ExtraServerStatus {
    return {
      name: this.server.name,
      source: this.server.source,
      state: this.state,
      toolCount: this.state === "connected" ? this.cachedTools.length : 0,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.untrusted ? { untrusted: true } : {}),
    };
  }

  /** Cached tool list, per-server allow/deny applied, names NOT prefixed. */
  tools(): CachedTool[] {
    return this.state === "connected" ? this.cachedTools : [];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Connect now; throws on failure after recording the error state. */
  async connect(): Promise<void> {
    if (this.closed) throw new BackendDisconnectedError(`MCP server ${this.server.name} is closed`);
    if (!this.enabled) {
      this.transition("disabled");
      return;
    }
    // A manual connect supersedes any background reconnect loop.
    this.reconnecting = false;
    try {
      await this.connectOnce();
      this.transition("connected");
    } catch (error) {
      this.lastError = this.describeError(error);
      this.transition("error");
      throw new BackendDisconnectedError(`MCP server ${this.server.name}: ${this.lastError}`);
    }
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.isToolExposed(tool)) {
      throw new Error(`Tool ${tool} is denied by the ${this.server.name} server's tool policy.`);
    }
    const client = this.client;
    if (!client || this.state !== "connected") {
      if (this.enabled && !this.closed) this.scheduleReconnect();
      throw new BackendDisconnectedError(
        `MCP server ${this.server.name} is ${this.state}${this.lastError ? `: ${this.lastError}` : ""}`,
      );
    }
    try {
      return (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
    } catch (error) {
      this.markDisconnected(this.describeError(error));
      this.scheduleReconnect();
      throw new BackendDisconnectedError(
        `MCP server ${this.server.name} call failed; reconnecting in background: ${this.describeError(error)}`,
      );
    }
  }

  /** Disable (close, no more reconnects) or re-enable (caller connects). */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (enabled) return;
    this.reconnecting = false;
    await this.closeClient();
    this.lastError = "disabled for this session";
    this.transition("disabled");
  }

  /** Clear the untrusted flag after the profile recorded approval. */
  markTrusted(): void {
    this.untrusted = false;
    if (this.state === "disabled") this.lastError = undefined;
  }

  scheduleReconnect(): void {
    if (this.reconnecting || this.closed || !this.enabled) return;
    this.reconnecting = true;
    void this.reconnectLoop();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.reconnecting = false;
    await this.closeClient();
  }

  private async reconnectLoop(): Promise<void> {
    let waitMs = 250;
    for (;;) {
      await delay(waitMs);
      if (!this.reconnecting || this.closed || !this.enabled) {
        this.reconnecting = false;
        return;
      }
      try {
        await this.connectOnce();
        this.reconnecting = false;
        this.transition("connected");
        return;
      } catch (error) {
        // Retries keep the current state; only lastError advances.
        this.lastError = this.describeError(error);
        waitMs = Math.min(waitMs * 2, 5000);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    await this.closeClient();
    this.stderrTail = "";
    const transport = this.createTransport();
    const client = new Client({ name: `ctc-extra-${this.server.name}`, version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.refreshToolCache().catch(() => undefined);
    });
    this.client = client;
    this.lastError = undefined;
    client.onclose = () => {
      if (this.client !== client || this.closed) return;
      this.markDisconnected(this.stderrTail ? `connection closed: ${this.stderrTail}` : "connection closed");
      this.scheduleReconnect();
    };
    await this.refreshToolCache();
  }

  private createTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    const transport = this.server.transport;
    if (transport.type === "stdio") {
      // Extras spawn with the SDK's minimal default environment plus the
      // configured env only; secrets must be passed intentionally.
      const stdio = new StdioClientTransport({
        command: transport.command,
        args: transport.args ?? [],
        env: { ...getDefaultEnvironment(), ...resolveConfigValueMap(transport.env) },
        stderr: "pipe",
      });
      stdio.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_CHARS);
      });
      return stdio;
    }
    const headers = resolveConfigValueMap(transport.headers);
    return new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
  }

  private async refreshToolCache(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const response = await client.listTools();
    const filtered = response.tools.filter((tool) => this.isToolExposed(tool.name));
    const changed =
      filtered.length !== this.cachedTools.length ||
      filtered.some((tool, index) => tool.name !== this.cachedTools[index]?.name);
    this.cachedTools = filtered;
    if (changed && this.state === "connected") this.hooks.onToolsChanged?.();
  }

  private isToolExposed(name: string): boolean {
    if (this.server.allow?.length && !this.server.allow.includes(name)) return false;
    if (this.server.deny?.includes(name)) return false;
    return true;
  }

  private markDisconnected(message: string): void {
    this.lastError = message;
    const client = this.client;
    this.client = undefined;
    if (client) void client.close().catch(() => undefined);
    this.transition("disconnected");
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
    }
  }

  /** Emit the current status unconditionally (used to announce initial disabled states). */
  announce(): void {
    this.hooks.onStatus?.(this.status());
  }

  private transition(state: ExtraServerState): void {
    const previous = this.state;
    this.state = state;
    if (state === previous) return;
    this.hooks.onStatus?.(this.status());
    // Entering or leaving "connected" changes which tools the pool exposes.
    if (state === "connected" || previous === "connected") this.hooks.onToolsChanged?.();
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (this.stderrTail && !message.includes(this.stderrTail)) {
      return `${message} ${this.stderrTail}`.trim().slice(0, 800);
    }
    return message.slice(0, 800);
  }
}
