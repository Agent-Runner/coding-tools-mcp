import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ctcHome,
  defaultBackendForPath,
  readProfileForPath,
  resolveProfileTargetPath,
  resolveRuntimeOptions,
  writeProfileForPath,
} from "../profiles/config.js";
import { mcpServerFingerprint, readWorkspaceMcpServers, WORKSPACE_MCP_FILE } from "../profiles/mcp.js";
import { ConductorHttpServer } from "../server/http.js";
import { ConductorRuntime } from "../server/mcp.js";
import { MemoryApprovalBroker, respondToApproval as respondToFileApproval } from "../shared/approvals.js";
import { JsonlEventLog } from "../shared/logging.js";
import { summarizeResult } from "../shared/summarize.js";
import type {
  BackendStatus,
  ExtraServerStatus,
  RuntimeOptions,
  WorkspaceMode,
  WorkspaceProfile,
  WorkspaceState,
} from "../shared/types.js";
import {
  CompositeSessionEventSink,
  JsonlSessionEventSink,
  SessionEventBus,
  type SessionEventSink,
} from "../sessions/events.js";
import {
  availableTunnelMethods,
  cloudflaredCommand,
  defaultInstallDeps,
  installCloudflared,
  type CloudflaredInstallPlan,
  type TunnelCommand,
  type TunnelMethod,
} from "../tunnel/install.js";
import { TunnelManager, type TunnelState } from "../tunnel/manager.js";
import {
  cleanWorkspaceSessions,
  closeWorkspaceSession,
  listWorkspaceSessions,
  mergeWorkspaceSession,
  readWorkspaceSession,
  type CloseWorkspaceResult,
  type WorkspaceCleanResult,
  type WorkspaceMergeResult,
} from "../workspace/manager.js";

export interface CreateTuiSessionOptions {
  path?: string;
  mode?: WorkspaceMode;
  resume?: string;
}

export interface CreateTuiSessionResult {
  sessionId: string;
  workspace: WorkspaceState;
  message: string;
  httpUrl?: string;
}

export interface TuiConfigResult {
  text: string;
  changed: boolean;
}

export interface TuiTunnelResult {
  state: TunnelState;
  message: string;
}

export type { TunnelMethod };

/** The runtime surface the controller needs; injectable for tests. */
export type ConductorRuntimeLike = Pick<
  ConductorRuntime,
  "start" | "stop" | "callTool" | "createServer" | "mcpStatuses" | "setMcpEnabled" | "reconnectMcp" | "trustMcp"
>;

export type RuntimeFactory = (
  options: RuntimeOptions,
  hooks: { owner: "tui"; events: SessionEventSink; approvals: MemoryApprovalBroker },
) => ConductorRuntimeLike;

interface HostedSession {
  sessionId: string;
  runtime: ConductorRuntimeLike;
  events: SessionEventSink;
  httpUrl?: string;
}

interface OpenWorkspaceRuntimeResult {
  workspace: WorkspaceState;
}

const SHUTDOWN_CLOSE_TIMEOUT_MS = 5000;

export class TuiSessionController {
  private hosted?: HostedSession;
  private shuttingDown = false;
  private readonly eventBus = new SessionEventBus();
  private readonly approvals = new MemoryApprovalBroker();
  private readonly tunnel = new TunnelManager();
  private http?: ConductorHttpServer;

  constructor(
    private readonly runtimeFactory: RuntimeFactory = (options, hooks) => new ConductorRuntime(options, hooks),
  ) {}

  activeSessionId(): string | undefined {
    return this.hosted?.sessionId;
  }

  async create(options: CreateTuiSessionOptions): Promise<CreateTuiSessionResult> {
    if (options.resume) return this.resume(options.resume);
    if (this.hosted) {
      throw new Error(`A session is already live (${this.hosted.sessionId}). /new replaces it.`);
    }

    const runtimeOptions = await resolveRuntimeOptions({ path: options.path, conciseLogs: false });
    const events = new CompositeSessionEventSink([
      new JsonlSessionEventSink(new JsonlEventLog(runtimeOptions.logPath, false)),
      this.eventBus,
    ]);
    const runtime = this.runtimeFactory(runtimeOptions, { owner: "tui", events, approvals: this.approvals });
    try {
      await runtime.start();
      const opened = requireStructured(
        await runtime.callTool("open_workspace", { path: runtimeOptions.workspacePath, mode: options.mode }),
      ) as OpenWorkspaceRuntimeResult;
      const httpUrl = await this.registerHttpSession(runtimeOptions.sessionId, runtime, runtimeOptions.workspacePath);
      this.hosted = { sessionId: runtimeOptions.sessionId, runtime, events, httpUrl };
      if (this.shuttingDown) {
        // The TUI quit while we were booting; clean up after ourselves.
        this.hosted = undefined;
        await runtime.callTool("close_workspace", {}).catch(() => undefined);
        await runtime.stop().catch(() => undefined);
        throw new Error("TUI is shutting down.");
      }
      return {
        sessionId: runtimeOptions.sessionId,
        workspace: opened.workspace,
        httpUrl,
        message: `Opened ${opened.workspace.mode} workspace ${opened.workspace.activePath}. MCP: ${httpUrl}`,
      };
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      throw error;
    }
  }

  /** /new semantics: close the live session (non-force) first, then open the next one. */
  async replace(options: CreateTuiSessionOptions): Promise<CreateTuiSessionResult> {
    if (options.resume) return this.resume(options.resume);
    if (this.hosted) {
      const closed = await this.close(this.hosted.sessionId, {});
      if (!closed.closed) {
        throw new Error(`${closed.message} Review with /diff, apply with /merge, or /close --force — then /new again.`);
      }
    }
    return this.create(options);
  }

  async close(sessionId: string, options: { force?: boolean } = {}): Promise<CloseWorkspaceResult> {
    const hosted = this.hosted?.sessionId === sessionId ? this.hosted : undefined;
    const started = performance.now();
    if (hosted) {
      const result = requireStructured(
        await hosted.runtime.callTool("close_workspace", { force: options.force }),
      ) as CloseWorkspaceResult;
      if (result.closed) {
        await this.http?.unregisterSession(sessionId).catch(() => undefined);
        await hosted.runtime.stop().catch(() => undefined);
        this.hosted = undefined;
      }
      return result;
    }

    const result = await closeWorkspaceSession(sessionId, { force: options.force });
    await appendToolEvent(
      jsonlSinkForSession(sessionId),
      sessionId,
      "close_workspace",
      started,
      result,
      result.closed ? undefined : result.message,
    );
    return result;
  }

  async merge(sessionId: string): Promise<WorkspaceMergeResult> {
    const hosted = this.hosted?.sessionId === sessionId ? this.hosted : undefined;
    const events = hosted?.events ?? jsonlSinkForSession(sessionId);
    const started = performance.now();
    try {
      const result = await mergeWorkspaceSession(sessionId);
      await appendToolEvent(events, sessionId, "merge_workspace", started, result, result.applied ? undefined : result.message);
      return result;
    } catch (error) {
      await appendToolEvent(events, sessionId, "merge_workspace", started, undefined, error).catch(() => undefined);
      throw error;
    }
  }

  async respondToApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    if (this.hosted?.sessionId === sessionId) await this.approvals.respond(sessionId, requestId, approved);
    else await respondToFileApproval(sessionId, requestId, approved);
  }

  /** Session ids of recorded, still-open worktree workspaces (the set `ctc ws clean` sees). */
  async cleanCandidates(): Promise<string[]> {
    return (await listWorkspaceSessions())
      .filter((state) => state.mode === "worktree" && !state.closedAt)
      .map((state) => state.sessionId);
  }

  /** Remove idle managed worktrees; shuts down hosted runtimes whose worktree was removed. */
  async clean(options: { force?: boolean; sessionId?: string } = {}): Promise<WorkspaceCleanResult> {
    const started = performance.now();
    const events = options.sessionId
      ? (this.hosted?.sessionId === options.sessionId ? this.hosted.events : jsonlSinkForSession(options.sessionId))
      : undefined;
    try {
      const result = await cleanWorkspaceSessions({ force: options.force, keepSessionId: options.sessionId });
      const hosted = this.hosted;
      if (hosted && result.removed.includes(hosted.sessionId)) {
        await this.http?.unregisterSession(hosted.sessionId).catch(() => undefined);
        await hosted.runtime.stop().catch(() => undefined);
        this.hosted = undefined;
      }
      if (events && options.sessionId) {
        await appendToolEvent(events, options.sessionId, "clean_workspaces", started, result, undefined);
      }
      return result;
    } catch (error) {
      if (events && options.sessionId) {
        await appendToolEvent(events, options.sessionId, "clean_workspaces", started, undefined, error).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Ordered ways to start a tunnel on this host (run cloudflared/wrangler, or install). */
  tunnelMethods(): TunnelMethod[] {
    return availableTunnelMethods();
  }

  /** Install cloudflared per the platform plan, returning its ready run command. */
  async installCloudflaredProvider(plan: CloudflaredInstallPlan, onLog: (line: string) => void): Promise<TunnelCommand> {
    const path = await installCloudflared(plan, defaultInstallDeps(onLog));
    return cloudflaredCommand(path);
  }

  async startTunnel(command: TunnelCommand): Promise<TuiTunnelResult> {
    // A tunnel in front of a session-less server can only answer 503, which remote
    // connectors surface as a failed setup. Refuse early with the fix instead.
    if (!this.hosted) {
      throw new Error("No live session to expose. /new opens one, then /tunnel start again.");
    }
    const http = await this.ensureHttpServer();
    if (!http.origin) throw new Error("HTTP MCP server is not listening.");
    const state = await this.tunnel.start(http.origin, command);
    http.setBearerToken(state.token);
    const route = `${state.publicUrl ?? "<public-url>"}/mcp`;
    return {
      state,
      message: `Tunnel ready via ${command.label}: ${route} with Authorization: Bearer ${state.token ?? "<token>"}`,
    };
  }

  async stopTunnel(): Promise<TuiTunnelResult> {
    const state = await this.tunnel.stop();
    this.http?.setBearerToken(undefined);
    return { state, message: "Tunnel stopped." };
  }

  tunnelStatus(): TunnelState {
    return this.tunnel.status();
  }

  onEvent(listener: () => void): () => void {
    this.eventBus.on("event", listener);
    return () => {
      this.eventBus.off("event", listener);
    };
  }

  async configure(path: string | undefined, args: string[]): Promise<TuiConfigResult> {
    const targetPath = path ?? process.cwd();
    const existing = await readProfileForPath(targetPath).catch(() => undefined);
    const profile: WorkspaceProfile = existing ?? {
      repoPath: targetPath,
      backend: defaultBackendForPath(targetPath),
      defaultMode: "direct",
      permissionMode: "safe",
      tunnel: { provider: "none" },
    };

    if (!args.length) return { text: formatProfile(profile), changed: false };
    const [field, value] = args;
    if (field === "mode") {
      if (value !== "direct" && value !== "worktree") throw new Error("/config mode requires direct or worktree.");
      profile.defaultMode = value;
    } else if (field === "permission") {
      if (value !== "safe" && value !== "trusted") throw new Error("/config permission requires safe or trusted.");
      profile.permissionMode = value;
    } else if (field === "tunnel") {
      if (value !== "none" && value !== "cloudflared") throw new Error("/config tunnel requires none or cloudflared.");
      profile.tunnel = { ...(profile.tunnel ?? {}), provider: value };
    } else {
      throw new Error("Usage: /config [mode direct|worktree | permission safe|trusted | tunnel none|cloudflared]");
    }
    await writeProfileForPath(targetPath, profile);
    return { text: formatProfile(profile), changed: true };
  }

  /** Extra MCP server statuses for the TUI-hosted session; undefined for external sessions. */
  mcpStatuses(sessionId: string | undefined): ExtraServerStatus[] | undefined {
    if (!sessionId || this.hosted?.sessionId !== sessionId) return undefined;
    return this.hosted.runtime.mcpStatuses();
  }

  async mcpSetEnabled(sessionId: string | undefined, name: string, enabled: boolean): Promise<ExtraServerStatus> {
    return this.requireHostedRuntime(sessionId).setMcpEnabled(name, enabled);
  }

  async mcpReconnect(sessionId: string | undefined, name: string): Promise<ExtraServerStatus> {
    return this.requireHostedRuntime(sessionId).reconnectMcp(name);
  }

  /**
   * Record trust for a workspace-declared server in the profile (fingerprint
   * of the current entry), then connect it live when the session is hosted.
   */
  async mcpTrust(
    path: string | undefined,
    sessionId: string | undefined,
    name: string,
  ): Promise<ExtraServerStatus | undefined> {
    const targetPath = await resolveProfileTargetPath(path ?? process.cwd());
    const workspace = await readWorkspaceMcpServers(targetPath);
    const entry = workspace.servers[name];
    if (!entry) throw new Error(`No MCP server named ${name} in ${WORKSPACE_MCP_FILE}.`);
    const existing = await readProfileForPath(targetPath).catch(() => undefined);
    const profile: WorkspaceProfile = existing ?? {
      repoPath: targetPath,
      backend: defaultBackendForPath(targetPath),
      defaultMode: "direct",
      permissionMode: "safe",
      tunnel: { provider: "none" },
    };
    profile.trustedWorkspaceMcp = { ...(profile.trustedWorkspaceMcp ?? {}), [name]: mcpServerFingerprint(entry) };
    await writeProfileForPath(targetPath, profile);
    const hosted = sessionId && this.hosted?.sessionId === sessionId ? this.hosted : undefined;
    if (!hosted) return undefined;
    return hosted.runtime.trustMcp(name);
  }

  /**
   * Auto-stop on TUI exit: stamp the workspace closed (never force — a dirty
   * worktree keeps its record and files), then tear everything down. A hung
   * backend must not wedge quit, so the close is raced against a timeout.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const hosted = this.hosted;
    if (hosted) {
      await Promise.race([
        hosted.runtime.callTool("close_workspace", {}).catch(() => undefined),
        delay(SHUTDOWN_CLOSE_TIMEOUT_MS),
      ]);
    }
    await this.stopTunnel().catch(() => undefined);
    await this.http?.close().catch(() => undefined);
    await hosted?.runtime.stop().catch(() => undefined);
    this.hosted = undefined;
  }

  private requireHostedRuntime(sessionId: string | undefined): ConductorRuntimeLike {
    const hosted = sessionId && this.hosted?.sessionId === sessionId ? this.hosted : undefined;
    if (!hosted) throw new Error("/mcp changes apply to TUI-owned sessions; this session is external and read-only.");
    return hosted.runtime;
  }

  private async resume(resume: string): Promise<CreateTuiSessionResult> {
    const state = await findWorkspaceForResume(resume);
    if (!state) throw new Error(`No recorded workspace matches ${resume}.`);
    await ensureSessionLog(state);
    return {
      sessionId: state.sessionId,
      workspace: state,
      message: `Resumed recorded workspace ${state.activePath} (read-only view). /merge applies a worktree's changes; /new opens a live session.`,
    };
  }

  private async registerHttpSession(sessionId: string, runtime: ConductorRuntimeLike, workspacePath: string): Promise<string> {
    const http = await this.ensureHttpServer(workspacePath);
    const registered = await http.registerSession(sessionId, () => runtime.createServer());
    return registered.url;
  }

  private async ensureHttpServer(workspacePath?: string): Promise<ConductorHttpServer> {
    if (!this.http) this.http = new ConductorHttpServer();
    if (this.http.origin) return this.http;
    const profile = workspacePath ? await readProfileForPath(workspacePath).catch(() => undefined) : undefined;
    const origin = await this.http.listen(profile?.httpPort);
    if (workspacePath && profile && !profile.httpPort) {
      const port = Number(new URL(origin).port);
      if (Number.isInteger(port)) await writeProfileForPath(workspacePath, { ...profile, httpPort: port });
    }
    return this.http;
  }
}

async function appendToolEvent(
  events: SessionEventSink,
  sessionId: string,
  tool: string,
  started: number,
  result: object | undefined,
  error: unknown,
): Promise<void> {
  await events.append({
    ts: new Date().toISOString(),
    sessionId,
    type: "tool_call",
    tool,
    argsSummary: "TUI command",
    resultSummary: result ? summarizeObject(result) : undefined,
    durationMs: Math.round(performance.now() - started),
    error: error ? errorMessage(error) : undefined,
  });
}

async function findWorkspaceForResume(resume: string): Promise<WorkspaceState | undefined> {
  const exact = await readWorkspaceSession(resume);
  if (exact && !exact.closedAt) return exact;
  const resolved = resolve(resume);
  return (await listWorkspaceSessions()).find(
    (state) => !state.closedAt && (state.worktreePath === resolved || state.activePath === resolved || basename(state.activePath) === resume),
  );
}

async function ensureSessionLog(state: WorkspaceState): Promise<void> {
  const path = sessionLogPath(state.sessionId);
  if (existsSync(path)) return;
  await mkdir(join(ctcHome(), "logs"), { recursive: true });
  const eventLog = new JsonlEventLog(path, false);
  const status: BackendStatus = { connected: false, reconnecting: false };
  await eventLog.append({
    ts: new Date().toISOString(),
    sessionId: state.sessionId,
    type: "session_started",
    owner: "tui",
    workspacePath: state.sourcePath,
    defaultMode: state.mode,
    backendType: "stdio",
    backendStatus: status,
    logPath: path,
  });
}

function sessionLogPath(sessionId: string): string {
  return join(ctcHome(), "logs", `${sessionId}.jsonl`);
}

function jsonlSinkForSession(sessionId: string): SessionEventSink {
  return new JsonlSessionEventSink(new JsonlEventLog(sessionLogPath(sessionId), false));
}

function summarizeObject(value: object): string {
  return summarizeResult({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
}

function requireStructured(result: CallToolResult): unknown {
  if (result.isError) throw new Error(resultText(result) || "MCP tool call failed.");
  if (result.structuredContent) return result.structuredContent;
  const text = resultText(result);
  if (!text) throw new Error("MCP tool call returned no structured content.");
  return JSON.parse(text) as unknown;
}

function resultText(result: CallToolResult): string | undefined {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : undefined;
}

function formatProfile(profile: WorkspaceProfile): string {
  const allow = profile.toolPolicy?.allow?.join(", ") || "<any>";
  const deny = profile.toolPolicy?.deny?.join(", ") || "<none>";
  const mcpServers = Object.keys(profile.mcpServers ?? {});
  const trustedMcp = Object.keys(profile.trustedWorkspaceMcp ?? {});
  return [
    `repo: ${profile.repoPath}`,
    `backend: ${profile.backend.type}`,
    `defaultMode: ${profile.defaultMode ?? "direct"}`,
    `permissionMode: ${profile.permissionMode ?? "safe"}`,
    `httpPort: ${profile.httpPort ? String(profile.httpPort) : "<auto>"}`,
    `tunnel: ${profile.tunnel?.provider ?? "none"}`,
    `allow: ${allow}`,
    `deny: ${deny}`,
    `mcp: ${mcpServers.length ? mcpServers.join(", ") : "<none>"}`,
    `trusted workspace mcp: ${trustedMcp.length ? trustedMcp.join(", ") : "<none>"}`,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
