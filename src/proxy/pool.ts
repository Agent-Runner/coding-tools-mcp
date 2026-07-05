import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CachedTool, ExtraServerStatus, ResolvedMcpServer } from "../shared/types.js";
import { BackendDisconnectedError } from "./client.js";
import { ExtraMcpClient } from "./extra-client.js";

export interface McpPoolHooks {
  onStatus?: (status: ExtraServerStatus) => void;
  onToolsChanged?: (server: string) => void;
}

export const MCP_TOOL_SEPARATOR = "__";

/**
 * Owns one ExtraMcpClient per configured additional MCP server and exposes
 * their tools under a `<server>__` prefix. Startup is never fatal: a broken
 * extra server becomes an error status with a background reconnect loop while
 * its siblings keep serving.
 */
export class McpServerPool {
  private readonly clients: ExtraMcpClient[] = [];
  private readonly byName = new Map<string, ExtraMcpClient>();
  private readonly namesByLengthDesc: string[];

  constructor(servers: ResolvedMcpServer[], hooks: McpPoolHooks = {}) {
    for (const server of servers) {
      if (this.byName.has(server.name)) continue;
      const client = new ExtraMcpClient(server, {
        onStatus: (status) => hooks.onStatus?.(status),
        onToolsChanged: () => hooks.onToolsChanged?.(server.name),
      });
      this.clients.push(client);
      this.byName.set(server.name, client);
    }
    this.namesByLengthDesc = [...this.byName.keys()].sort((left, right) => right.length - left.length);
  }

  size(): number {
    return this.clients.length;
  }

  async start(): Promise<void> {
    await Promise.allSettled(
      this.clients.map(async (client) => {
        if (!client.isEnabled()) {
          client.announce();
          return;
        }
        try {
          await client.connect();
        } catch {
          client.scheduleReconnect();
        }
      }),
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
  }

  statuses(): ExtraServerStatus[] {
    return this.clients.map((client) => client.status());
  }

  /** Merged tool list of connected servers, names prefixed `<server>__<tool>`. */
  tools(): CachedTool[] {
    const tools: CachedTool[] = [];
    for (const client of this.clients) {
      for (const tool of client.tools()) {
        tools.push({ ...tool, name: `${client.name()}${MCP_TOOL_SEPARATOR}${tool.name}` });
      }
    }
    return tools;
  }

  /**
   * Map a prefixed tool name back to its owning server. Server names may
   * themselves contain `__`, so match registered names longest-first instead
   * of splitting on the first separator.
   */
  resolve(name: string): { server: string; tool: string } | undefined {
    for (const serverName of this.namesByLengthDesc) {
      const prefix = `${serverName}${MCP_TOOL_SEPARATOR}`;
      if (name.length > prefix.length && name.startsWith(prefix)) {
        return { server: serverName, tool: name.slice(prefix.length) };
      }
    }
    return undefined;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return this.require(server).callTool(tool, args);
  }

  async setEnabled(name: string, enabled: boolean): Promise<ExtraServerStatus> {
    const client = this.require(name);
    if (enabled && client.status().untrusted) {
      throw new Error(`MCP server ${name} is untrusted; approve it with /mcp trust ${name} first.`);
    }
    await client.setEnabled(enabled);
    if (enabled) {
      await client.connect().catch(() => {
        client.scheduleReconnect();
      });
    }
    return client.status();
  }

  async reconnect(name: string): Promise<ExtraServerStatus> {
    const client = this.require(name);
    if (!client.isEnabled()) throw new Error(`MCP server ${name} is disabled; enable it before reconnecting.`);
    await client.connect().catch(() => {
      client.scheduleReconnect();
    });
    return client.status();
  }

  /** Called after the profile recorded trust: clear the flag, enable, connect. */
  async trust(name: string): Promise<ExtraServerStatus> {
    const client = this.require(name);
    client.markTrusted();
    await client.setEnabled(true);
    await client.connect().catch(() => {
      client.scheduleReconnect();
    });
    return client.status();
  }

  private require(name: string): ExtraMcpClient {
    const client = this.byName.get(name);
    if (!client) throw new BackendDisconnectedError(`Unknown MCP server ${name}`);
    return client;
  }
}
