import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  McpConfigIssue,
  McpServerConfigInput,
  McpServerTransport,
  ResolvedMcpServer,
} from "../shared/types.js";

export const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export const mcpServerConfigSchema = z.object({
  type: z.enum(["stdio", "http"]).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string()).optional(),
  disabled: z.boolean().optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

export const mcpServersRecordSchema = z.record(
  z.string().regex(MCP_SERVER_NAME_RE, "MCP server names may only use letters, digits, _ and -"),
  mcpServerConfigSchema,
);

const workspaceMcpFileShape = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });

export const WORKSPACE_MCP_FILE = ".ctc/mcp.json";

export function workspaceMcpPath(workspacePath: string): string {
  return join(workspacePath, ".ctc", "mcp.json");
}

export interface WorkspaceMcpServers {
  servers: Record<string, McpServerConfigInput>;
  issues: McpConfigIssue[];
}

export async function readWorkspaceMcpServers(workspacePath: string): Promise<WorkspaceMcpServers> {
  const file = workspaceMcpPath(workspacePath);
  if (!existsSync(file)) return { servers: {}, issues: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return { servers: {}, issues: [{ message: `${WORKSPACE_MCP_FILE} is not valid JSON: ${errorMessage(error)}` }] };
  }
  const parsedFile = workspaceMcpFileShape.safeParse(raw);
  if (!parsedFile.success) {
    return { servers: {}, issues: [{ message: `${WORKSPACE_MCP_FILE} must be an object with an mcpServers record.` }] };
  }
  const servers: Record<string, McpServerConfigInput> = {};
  const issues: McpConfigIssue[] = [];
  for (const [name, value] of Object.entries(parsedFile.data.mcpServers ?? {})) {
    if (!MCP_SERVER_NAME_RE.test(name)) {
      issues.push({ name, message: `Invalid MCP server name ${name}; use letters, digits, _ and - only.` });
      continue;
    }
    const entry = mcpServerConfigSchema.safeParse(value);
    if (!entry.success) {
      issues.push({ name, message: `Invalid MCP server entry ${name}: ${entry.error.issues[0]?.message ?? "invalid shape"}` });
      continue;
    }
    servers[name] = entry.data;
  }
  return { servers, issues };
}

export function normalizeMcpTransport(name: string, raw: McpServerConfigInput): McpServerTransport {
  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;
  const hasUrl = typeof raw.url === "string" && raw.url.length > 0;
  if (hasCommand && hasUrl) throw new Error(`MCP server ${name} must set either command or url, not both.`);
  if (raw.type === "stdio" && !hasCommand) throw new Error(`MCP server ${name} has type stdio but no command.`);
  if (raw.type === "http" && !hasUrl) throw new Error(`MCP server ${name} has type http but no url.`);
  if (hasCommand) {
    return {
      type: "stdio",
      command: raw.command as string,
      ...(raw.args ? { args: raw.args } : {}),
      ...(raw.env ? { env: raw.env } : {}),
    };
  }
  if (hasUrl) {
    return { type: "http", url: raw.url as string, ...(raw.headers ? { headers: raw.headers } : {}) };
  }
  throw new Error(`MCP server ${name} must set a stdio command or an http url.`);
}

export function mcpServerFingerprint(raw: McpServerConfigInput): string {
  const parsed = mcpServerConfigSchema.parse(raw);
  return createHash("sha256").update(stableStringify(parsed)).digest("hex");
}

export interface MergeMcpServersInput {
  profileServers?: Record<string, McpServerConfigInput>;
  workspaceServers?: Record<string, McpServerConfigInput>;
  trustedWorkspaceMcp?: Record<string, string>;
  trustAllWorkspace?: boolean;
}

export interface MergedMcpServers {
  servers: ResolvedMcpServer[];
  issues: McpConfigIssue[];
}

export function mergeMcpServers(input: MergeMcpServersInput): MergedMcpServers {
  const servers: ResolvedMcpServer[] = [];
  const issues: McpConfigIssue[] = [];
  const seen = new Set<string>();

  const add = (name: string, raw: McpServerConfigInput, source: "profile" | "workspace", trusted: boolean) => {
    let transport: McpServerTransport;
    try {
      transport = normalizeMcpTransport(name, raw);
    } catch (error) {
      issues.push({ name, message: errorMessage(error) });
      return;
    }
    servers.push({
      name,
      source,
      transport,
      enabled: raw.disabled !== true && trusted,
      ...(source === "workspace" && !trusted ? { untrusted: true } : {}),
      ...(raw.allow ? { allow: raw.allow } : {}),
      ...(raw.deny ? { deny: raw.deny } : {}),
    });
  };

  for (const [name, raw] of Object.entries(input.profileServers ?? {})) {
    if (!MCP_SERVER_NAME_RE.test(name)) {
      issues.push({ name, message: `Invalid MCP server name ${name}; use letters, digits, _ and - only.` });
      continue;
    }
    seen.add(name);
    add(name, raw, "profile", true);
  }
  for (const [name, raw] of Object.entries(input.workspaceServers ?? {})) {
    if (seen.has(name)) continue;
    const trusted = input.trustAllWorkspace === true || input.trustedWorkspaceMcp?.[name] === mcpServerFingerprint(raw);
    add(name, raw, "workspace", trusted);
  }
  return { servers, issues };
}

export function resolveConfigValue(value: string): string {
  if (!value.startsWith("env:")) return value;
  const envName = value.slice("env:".length);
  const resolved = process.env[envName];
  if (resolved === undefined) throw new Error(`Environment variable ${envName} referenced by env:${envName} is not set.`);
  return resolved;
}

export function resolveConfigValueMap(map: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(map ?? {})) resolved[key] = resolveConfigValue(value);
  return resolved;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
