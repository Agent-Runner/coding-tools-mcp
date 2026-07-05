import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export type WorkspaceMode = "direct" | "worktree";

export type BackendConfig =
  | {
      type: "stdio";
      command: string[];
    }
  | {
      type: "http";
      url: string;
      tokenRef?: string;
    };

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export type McpServerTransport =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    };

/** Raw profile/.ctc/mcp.json entry, Claude Code .mcp.json style (shape-discriminated). */
export interface McpServerConfigInput {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  allow?: string[];
  deny?: string[];
}

export type McpServerSource = "profile" | "workspace";

/** Normalized, merged extra-server entry carried on RuntimeOptions. */
export interface ResolvedMcpServer {
  name: string;
  source: McpServerSource;
  transport: McpServerTransport;
  enabled: boolean;
  untrusted?: boolean;
  allow?: string[];
  deny?: string[];
}

export type ExtraServerState = "connecting" | "connected" | "disconnected" | "error" | "disabled";

export interface ExtraServerStatus {
  name: string;
  source: McpServerSource;
  state: ExtraServerState;
  toolCount: number;
  lastError?: string;
  untrusted?: boolean;
  droppedTools?: string[];
}

export interface McpConfigIssue {
  name?: string;
  message: string;
}

export interface WorkspaceProfile {
  repoPath: string;
  backend: BackendConfig;
  defaultMode?: WorkspaceMode;
  permissionMode?: "safe" | "trusted";
  httpPort?: number;
  toolPolicy?: ToolPolicy;
  tunnel?: {
    provider: "cloudflared" | "none";
    hostname?: string;
    enabled?: boolean;
  };
  adapters?: string[];
  mcpServers?: Record<string, McpServerConfigInput>;
  trustedWorkspaceMcp?: Record<string, string>;
}

export interface RuntimeOptions {
  sessionId: string;
  workspacePath: string;
  defaultMode: WorkspaceMode;
  backend: BackendConfig;
  toolPolicy: ToolPolicy;
  adapters: string[];
  logPath: string;
  conciseLogs: boolean;
  mcpServers: ResolvedMcpServer[];
  mcpConfigIssues: McpConfigIssue[];
}

export interface WorkspaceState {
  sessionId: string;
  mode: WorkspaceMode;
  sourcePath: string;
  activePath: string;
  repoRoot?: string;
  worktreePath?: string;
  baseRef?: string;
  baseCommit?: string;
  openedAt: string;
  closedAt?: string;
}

export interface InstructionFileSummary {
  path: string;
  bytes: number;
  rootLevel: boolean;
  inlineContent?: string;
  truncated?: boolean;
}

export interface SkillSummary {
  name: string;
  path: string;
  source: "ctc" | "claude";
  description?: string;
}

export interface WorkspaceContextGuide {
  rootPath: string;
  instructionFiles: InstructionFileSummary[];
  skills: SkillSummary[];
}

export interface LoadedSkill extends SkillSummary {
  content: string;
}

export interface ToolCallEvent {
  ts: string;
  sessionId: string;
  type: "tool_call";
  tool: string;
  argsSummary: string;
  resultSummary?: string;
  durationMs: number;
  error?: string;
  server?: string;
}

export interface ReviewCheckpointEvent {
  ts: string;
  sessionId: string;
  type: "review_checkpoint";
  since: "last_shown" | "workspace_open" | "head";
  base: string;
  snapshot: string;
  statSummary: string;
  diff?: string;
  truncated: boolean;
}

export interface SessionStartedEvent {
  ts: string;
  sessionId: string;
  type: "session_started";
  owner?: "stdio" | "tui";
  workspacePath: string;
  defaultMode: WorkspaceMode;
  backendType: BackendConfig["type"];
  backendStatus: BackendStatus;
  logPath: string;
  mcpServers?: SessionMcpServerSummary[];
}

export interface SessionMcpServerSummary {
  name: string;
  source: McpServerSource;
  state: ServerStatusEvent["state"];
  toolCount?: number;
  error?: string;
  untrusted?: boolean;
}

export interface ServerStatusEvent {
  ts: string;
  sessionId: string;
  type: "server_status";
  server: string;
  state: "connected" | "disconnected" | "error" | "disabled";
  source?: McpServerSource;
  toolCount?: number;
  error?: string;
  untrusted?: boolean;
  droppedTools?: string[];
}

export interface PermissionRequestEvent {
  ts: string;
  sessionId: string;
  type: "permission_request";
  requestId: string;
  state: "pending" | "approved" | "denied" | "timeout";
  argsSummary: string;
}

export type ConductorEvent =
  | ToolCallEvent
  | ReviewCheckpointEvent
  | SessionStartedEvent
  | PermissionRequestEvent
  | ServerStatusEvent;

export interface BackendStatus {
  connected: boolean;
  reconnecting: boolean;
  lastError?: string;
}

export type CachedTool = Tool;
export type ProxiedToolResult = CallToolResult;
