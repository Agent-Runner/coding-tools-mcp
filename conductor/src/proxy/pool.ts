import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CachedTool, ExtraServerStatus, ResolvedMcpServer } from "../shared/types.js";
import { BackendDisconnectedError } from "./client.js";
import { ExtraMcpClient } from "./extra-client.js";

export interface McpPoolHooks {
  onStatus?: (status: ExtraServerStatus) => void;
  onToolsChanged?: (server: string) => void;
}

export const MCP_TOOL_SEPARATOR = "__";

/** One connected extra tool under its exposed (prefixed) name. */
export interface ExposedToolEntry {
  name: string;
  server: string;
  tool: CachedTool;
}

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

  /**
   * Every connected extra tool in exposure order (server registration order,
   * then the server's own tool order). This ordering is the single source of
   * truth shared by listing, routing, and dropped-tool attribution, so a name
   * collision always resolves to the same winner everywhere.
   */
  entries(): ExposedToolEntry[] {
    const entries: ExposedToolEntry[] = [];
    for (const client of this.clients) {
      for (const tool of client.tools()) {
        entries.push({ name: `${client.name()}${MCP_TOOL_SEPARATOR}${tool.name}`, server: client.name(), tool });
      }
    }
    return entries;
  }

  /** Merged tool list of connected servers, names prefixed `<server>__<tool>`. */
  tools(): CachedTool[] {
    return this.entries().map((entry) => ({ ...entry.tool, name: entry.name }));
  }

  /**
   * Map a prefixed tool name back to its owning server. Live exposed tools
   * win first (same first-writer-wins order the tool list uses). Names no
   * live tool claims — e.g. a call to a currently disconnected server — fall
   * back to prefix parsing; server names may themselves contain `__`, so
   * registered names match longest-first instead of splitting on the first
   * separator.
   */
  resolve(name: string): { server: string; tool: string } | undefined {
    const entry = this.entries().find((candidate) => candidate.name === name);
    if (entry) return { server: entry.server, tool: entry.tool.name };
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
