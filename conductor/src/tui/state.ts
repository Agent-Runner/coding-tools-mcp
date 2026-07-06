import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readBatonBundle, type BatonBundle } from "../baton/protocol.js";
import { ctcHome } from "../profiles/config.js";
import { listPendingApprovals, type PermissionApprovalRequest } from "../shared/approvals.js";
import type {
  ConductorEvent,
  ExtraServerState,
  McpServerSource,
  ReviewCheckpointEvent,
  SessionStartedEvent,
  ToolCallEvent,
  WorkspaceState,
} from "../shared/types.js";
import { readWorkspaceSession } from "../workspace/manager.js";

export interface TuiSnapshot {
  sessionId?: string;
  logPath?: string;
  initialWorkspacePath?: string;
  label?: string;
  events: ConductorEvent[];
  toolCalls: ToolCallEvent[];
  checkpoints: ReviewCheckpointEvent[];
  session?: SessionStartedEvent;
  workspace?: WorkspaceState;
  baton?: BatonBundle;
  pendingApprovals: PermissionApprovalRequest[];
  mcpServers: McpServerStatusSnapshot[];
}

export interface McpServerStatusSnapshot {
  name: string;
  state: ExtraServerState;
  source?: McpServerSource;
  toolCount?: number;
  lastError?: string;
  untrusted?: boolean;
  droppedTools?: string[];
  lastChangedTs?: string;
}

export interface LoadTuiSnapshotOptions {
  requestedSessionId?: string;
  initialWorkspacePath?: string;
}

export async function loadTuiSnapshot(options: LoadTuiSnapshotOptions = {}): Promise<TuiSnapshot> {
  const sessionId = options.requestedSessionId;
  if (!sessionId) {
    return {
      initialWorkspacePath: options.initialWorkspacePath,
      events: [],
      toolCalls: [],
      checkpoints: [],
      pendingApprovals: [],
      mcpServers: [],
    };
  }
  const logPath = join(ctcHome(), "logs", `${sessionId}.jsonl`);
  const events = await readEventLog(logPath);
  const session = lastOfType(events, "session_started");
  const workspace = await readWorkspaceSession(sessionId);
  const root = workspace?.activePath ?? session?.workspacePath;
  const baton = root ? await readBatonBundle(root).catch(() => undefined) : undefined;
  const pendingApprovals = await listPendingApprovals(sessionId).catch(() => []);
  return {
    sessionId,
    logPath,
    initialWorkspacePath: options.initialWorkspacePath,
    label: labelForSession(sessionId, workspace?.activePath ?? session?.workspacePath),
    events,
    toolCalls: events.filter((event): event is ToolCallEvent => event.type === "tool_call"),
    checkpoints: events.filter((event): event is ReviewCheckpointEvent => event.type === "review_checkpoint"),
    session,
    workspace,
    baton,
    pendingApprovals,
    mcpServers: deriveMcpServers(events),
  };
}

/** Newest session log id by mtime — one-shot startup helper for bare `ctc tui`. */
export async function latestSessionLogId(): Promise<string | undefined> {
  const dir = join(ctcHome(), "logs");
  if (!existsSync(dir)) return undefined;
  const entries = await Promise.all(
    (await readdir(dir))
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name))).mtimeMs })),
  );
  const newest = entries.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest ? basename(newest.name, ".jsonl") : undefined;
}

/**
 * Fold the session's mcp server history into one row per server: the last
 * session_started summary is the baseline, later server_status events update
 * it. Dropped tools only mean something for a connected server, so they are
 * restored from the baseline, replaced (empty array included) on every
 * connected update, and cleared on any other state so a reconnect never shows
 * a stale shadow list. Exported for tests.
 */
export function deriveMcpServers(events: ConductorEvent[]): McpServerStatusSnapshot[] {
  const servers = new Map<string, McpServerStatusSnapshot>();
  for (const event of events) {
    if (event.type === "session_started") {
      servers.clear();
      for (const summary of event.mcpServers ?? []) {
        servers.set(summary.name, {
          name: summary.name,
          state: summary.state,
          source: summary.source,
          toolCount: summary.toolCount,
          lastError: summary.error,
          untrusted: summary.untrusted,
          droppedTools: summary.state === "connected" ? (summary.droppedTools ?? []) : undefined,
        });
      }
      continue;
    }
    if (event.type !== "server_status") continue;
    const previous = servers.get(event.server);
    servers.set(event.server, {
      name: event.server,
      state: event.state,
      source: event.source ?? previous?.source,
      toolCount: event.toolCount ?? (event.state === "connected" ? previous?.toolCount : undefined),
      lastError: event.error,
      untrusted: event.untrusted,
      droppedTools: event.state === "connected" ? (event.droppedTools ?? []) : undefined,
      lastChangedTs: event.ts,
    });
  }
  return [...servers.values()];
}

interface LogCacheEntry {
  mtimeMs: number;
  size: number;
  consumedBytes: number;
  events: ConductorEvent[];
}

const logCache = new Map<string, LogCacheEntry>();

async function readEventLog(path: string): Promise<ConductorEvent[]> {
  const stats = await stat(path).catch(() => undefined);
  if (!stats) return [];
  const cached = logCache.get(path);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.events;
  if (cached && stats.size >= cached.consumedBytes) {
    const tail = await readFileSlice(path, cached.consumedBytes).catch(() => undefined);
    if (tail !== undefined) {
      const { events, consumed } = parseCompleteLines(tail);
      const entry: LogCacheEntry = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        consumedBytes: cached.consumedBytes + consumed,
        events: events.length ? [...cached.events, ...events] : cached.events,
      };
      logCache.set(path, entry);
      return entry.events;
    }
  }
  const text = await readFile(path, "utf8").catch(() => "");
  const { events, consumed } = parseCompleteLines(text);
  logCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, consumedBytes: consumed, events });
  return events;
}

function parseCompleteLines(text: string): { events: ConductorEvent[]; consumed: number } {
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
  const events = complete
    .split("\n")
    .filter(Boolean)
    .map(parseEvent)
    .filter((event): event is ConductorEvent => Boolean(event));
  let consumed = Buffer.byteLength(complete, "utf8");
  const remainder = lastNewline === -1 ? text : text.slice(lastNewline + 1);
  if (remainder) {
    const trailing = parseEvent(remainder);
    if (trailing) {
      events.push(trailing);
      consumed += Buffer.byteLength(remainder, "utf8");
    }
  }
  return { events, consumed };
}

async function readFileSlice(path: string, start: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.max(0, size - start);
    if (!length) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseEvent(line: string): ConductorEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isObject(parsed)) return undefined;
    const type = parsed.type;
    if (
      type === "tool_call" ||
      type === "review_checkpoint" ||
      type === "session_started" ||
      type === "permission_request" ||
      type === "server_status"
    ) {
      return parsed as unknown as ConductorEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function lastOfType<T extends ConductorEvent["type"]>(
  events: ConductorEvent[],
  type: T,
): Extract<ConductorEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event as Extract<ConductorEvent, { type: T }>;
  }
  return undefined;
}

function labelForSession(sessionId: string, workspacePath?: string): string {
  if (workspacePath) return basename(workspacePath) || workspacePath;
  return sessionId.replace(/^ctc-/, "").slice(-12);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
