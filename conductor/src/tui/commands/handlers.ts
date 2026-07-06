import { runDoctor } from "../../cli/doctor.js";
import type { ExtraServerStatus } from "../../shared/types.js";
import type { WorkspaceCleanResult } from "../../workspace/manager.js";
import { doctorLines, type PanelState } from "../components/Panels.js";
import { errorMessage, textDisplayLines } from "../format.js";
import type { TuiSessionController, TunnelMethod } from "../session-controller.js";
import type { TuiSnapshot } from "../state.js";
import type { TuiSnapshotStore } from "../store.js";
import { glyphs } from "../theme.js";
import type { NoteKind } from "../transcript.js";
import {
  findSlashCommand,
  parseCleanCommand,
  parseCloseCommand,
  parseMcpCommand,
  parseNewCommand,
  parseSlashCommand,
  parseTunnelCommand,
} from "./registry.js";

export interface McpPickRequest {
  action: "enable" | "disable" | "reconnect";
  options: ExtraServerStatus[];
}

/**
 * Everything a slash-command handler may touch. The TUI component supplies
 * thin adapters over its state; handlers stay plain async functions.
 */
export interface CommandContext {
  controller: TuiSessionController;
  store: TuiSnapshotStore;
  snapshot: TuiSnapshot;
  initialWorkspacePath: string | undefined;
  /** Repo of the ACTIVE session (never a worktree checkout). */
  activeRepoPath(): string | undefined;
  isBusy(): boolean;
  appendNote(text: string, kind?: NoteKind): void;
  runWithBusy(label: string, task: () => Promise<void>): Promise<void>;
  setPanel(panel: PanelState | undefined): void;
  setTunnelMessage(message: string): void;
  switchToSession(sessionId: string): void;
  openTunnelPicker(methods: TunnelMethod[]): void;
  openMcpPicker(request: McpPickRequest): void;
  openCleanPicker(candidates: string[]): void;
  clearTranscript(): void;
  exit(): void;
}

/** Route one submitted line to its handler. Returns after the command settles. */
export async function dispatchInput(ctx: CommandContext, trimmed: string): Promise<void> {
  if (!trimmed.startsWith("/")) {
    ctx.appendNote("The transcript mirrors model-driven sessions; type / to browse TUI commands.", "hint");
    return;
  }
  let parsed;
  try {
    parsed = parseSlashCommand(trimmed);
  } catch (error) {
    ctx.appendNote(errorMessage(error), "error");
    return;
  }
  if (!parsed) return;
  const command = findSlashCommand(parsed.name);
  if (!command) {
    ctx.appendNote(`Unknown command ${parsed.raw}. Type /help to see available commands.`, "error");
    return;
  }
  if (ctx.isBusy() && command.name !== "quit") {
    ctx.appendNote("A TUI command is already running.", "hint");
    return;
  }

  ctx.setPanel(undefined);
  switch (command.name) {
    case "help":
      ctx.setPanel({ kind: "help" });
      break;
    case "diff":
      ctx.setPanel({ kind: "diff" });
      break;
    case "baton":
      ctx.setPanel({ kind: "baton" });
      break;
    case "approvals":
      ctx.setPanel({ kind: "approvals" });
      break;
    case "inspect":
      ctx.setPanel({ kind: "inspect" });
      break;
    case "clear":
      ctx.clearTranscript();
      break;
    case "new":
      await runNewCommand(ctx, parsed.args);
      break;
    case "close":
      await runCloseCommand(ctx, parsed.args);
      break;
    case "clean":
      await runCleanCommand(ctx, parsed.args);
      break;
    case "merge":
      await runMergeCommand(ctx);
      break;
    case "tunnel":
      await runTunnelCommand(ctx, parsed.args);
      break;
    case "config":
      await runConfigCommand(ctx, parsed.args);
      break;
    case "mcp":
      await runMcpCommand(ctx, parsed.args);
      break;
    case "doctor":
      await runDoctorCommand(ctx);
      break;
    case "quit":
      ctx.exit();
      break;
    default:
      // Tripwire for a future registry entry added without a case above.
      ctx.appendNote(`${command.usage} has no TUI handler.`, "error");
  }
}

async function runNewCommand(ctx: CommandContext, args: string[]): Promise<void> {
  await ctx.runWithBusy("Opening session", async () => {
    const parsedNew = parseNewCommand(args);
    const path = parsedNew.path ?? ctx.activeRepoPath();
    const result = await ctx.controller.replace({ path, mode: parsedNew.mode, resume: parsedNew.resume });
    ctx.switchToSession(result.sessionId);
    ctx.appendNote(result.message, "success");
    ctx.store.requestRefresh();
  });
}

async function runCloseCommand(ctx: CommandContext, args: string[]): Promise<void> {
  const sessionId = ctx.snapshot.sessionId;
  if (!sessionId) {
    ctx.appendNote("No active session to close.", "hint");
    return;
  }
  await ctx.runWithBusy("Closing workspace", async () => {
    const parsedClose = parseCloseCommand(args);
    const result = await ctx.controller.close(sessionId, { force: parsedClose.force });
    ctx.appendNote(result.message, result.closed ? "success" : "hint");
    if (result.closed) {
      ctx.store.setRequestedSession(undefined);
      ctx.appendNote("No active session — /new reopens one.", "hint");
    }
    ctx.store.requestRefresh();
  });
}

async function runMergeCommand(ctx: CommandContext): Promise<void> {
  const sessionId = ctx.snapshot.sessionId;
  if (!sessionId) {
    ctx.appendNote("No active session to merge.", "hint");
    return;
  }
  await ctx.runWithBusy("Merging worktree", async () => {
    const result = await ctx.controller.merge(sessionId);
    ctx.appendNote(result.message, result.applied ? "success" : "hint");
    ctx.store.requestRefresh();
  });
}

async function runCleanCommand(ctx: CommandContext, args: string[]): Promise<void> {
  let parsedClean;
  try {
    parsedClean = parseCleanCommand(args);
  } catch (error) {
    ctx.appendNote(errorMessage(error), "error");
    return;
  }
  if (parsedClean.force || parsedClean.yes) {
    await executeClean(ctx, parsedClean.force);
    return;
  }
  const candidates = await ctx.controller.cleanCandidates();
  if (!candidates.length) {
    ctx.appendNote("No recorded worktrees to clean.", "hint");
    return;
  }
  ctx.openCleanPicker(candidates);
}

export async function executeClean(ctx: CommandContext, force: boolean): Promise<void> {
  await ctx.runWithBusy("Cleaning worktrees", async () => {
    const result = await ctx.controller.clean({ force, sessionId: ctx.snapshot.sessionId });
    ctx.appendNote(formatCleanResult(result), result.removed.length ? "success" : "info");
    if (result.skippedDirty.length) {
      ctx.appendNote(`Dirty worktrees skipped: ${result.skippedDirty.join(", ")} — /clean --force removes them.`, "hint");
    }
    if (ctx.snapshot.sessionId && result.removed.includes(ctx.snapshot.sessionId)) ctx.store.setRequestedSession(undefined);
    ctx.store.requestRefresh();
  });
}

export async function startTunnelWith(ctx: CommandContext, method: TunnelMethod): Promise<void> {
  await ctx.runWithBusy(
    method.kind === "install" ? "Installing cloudflared" : `Starting tunnel via ${method.label}`,
    async () => {
      if (method.note) ctx.appendNote(method.note, "hint");
      const command =
        method.kind === "install"
          ? await ctx.controller.installCloudflaredProvider(method.plan, (line) => {
              ctx.appendNote(line, "info");
            })
          : method.command;
      const result = await ctx.controller.startTunnel(command);
      ctx.setTunnelMessage(result.state.message);
      ctx.appendNote(result.message, "success");
      ctx.store.requestRefresh();
    },
  );
}

async function runTunnelCommand(ctx: CommandContext, args: string[]): Promise<void> {
  let parsedTunnel;
  try {
    parsedTunnel = parseTunnelCommand(args);
  } catch (error) {
    ctx.appendNote(errorMessage(error), "error");
    return;
  }
  if (parsedTunnel.action === "start") {
    // startTunnelWith owns its own busy spinner, so don't nest one here.
    const methods = ctx.controller.tunnelMethods();
    const ready = methods.find((method) => method.id === "cloudflared");
    if (ready) {
      await startTunnelWith(ctx, ready); // cloudflared already installed — no prompt
    } else if (methods.length) {
      ctx.openTunnelPicker(methods);
    } else {
      ctx.appendNote("No tunnel provider available. Install cloudflared or Node's npx, then retry.", "error");
    }
    return;
  }
  await ctx.runWithBusy("Updating tunnel", async () => {
    if (parsedTunnel.action === "stop") {
      const result = await ctx.controller.stopTunnel();
      ctx.setTunnelMessage(result.state.message);
      ctx.appendNote(result.message, "info");
    } else {
      const state = ctx.controller.tunnelStatus();
      ctx.setTunnelMessage(state.message);
      ctx.appendNote(state.publicUrl ? `Tunnel: ${state.publicUrl}` : state.message, "info");
    }
  });
}

async function runConfigCommand(ctx: CommandContext, args: string[]): Promise<void> {
  await ctx.runWithBusy("Loading profile", async () => {
    const result = await ctx.controller.configure(ctx.activeRepoPath(), args);
    ctx.setPanel({ kind: "config", lines: textDisplayLines(result.text) });
    if (result.changed) ctx.appendNote("Profile updated.", "success");
  });
}

async function runMcpCommand(ctx: CommandContext, args: string[]): Promise<void> {
  let parsedMcp;
  try {
    parsedMcp = parseMcpCommand(args);
  } catch (error) {
    ctx.appendNote(errorMessage(error), "error");
    return;
  }
  if (parsedMcp.action === "status") {
    ctx.setPanel({ kind: "mcp" });
    return;
  }
  const hosted = ctx.controller.mcpStatuses(ctx.snapshot.sessionId);
  // Trust only writes the profile, so it works without a hosted session too.
  if (!hosted && parsedMcp.action !== "trust") {
    ctx.appendNote(
      "/mcp changes apply to TUI-owned sessions; this session is external and read-only. Run /new to host one.",
      "hint",
    );
    return;
  }
  if (parsedMcp.server) {
    await runMcpAction(ctx, parsedMcp.action, parsedMcp.server);
    return;
  }
  const action = parsedMcp.action;
  if (action === "trust") return; // parser guarantees trust always carries a server name
  const options = (hosted ?? []).filter((server) =>
    action === "enable" ? server.state === "disabled" && !server.untrusted : server.state !== "disabled",
  );
  if (!options.length) {
    ctx.appendNote(`No MCP servers available to ${action}. /mcp shows the current list.`, "hint");
    return;
  }
  ctx.openMcpPicker({ action, options });
}

export async function runMcpAction(
  ctx: CommandContext,
  action: "enable" | "disable" | "reconnect" | "trust",
  server: string,
): Promise<void> {
  const labels = { enable: "Enabling", disable: "Disabling", reconnect: "Reconnecting", trust: "Trusting" } as const;
  await ctx.runWithBusy(`${labels[action]} mcp ${server}`, async () => {
    let status: ExtraServerStatus | undefined;
    if (action === "trust") {
      status = await ctx.controller.mcpTrust(ctx.activeRepoPath(), ctx.snapshot.sessionId, server);
      if (!status) {
        ctx.appendNote(`Trusted workspace MCP server ${server}; it connects when a hosted session starts.`, "success");
        return;
      }
    } else if (action === "reconnect") {
      status = await ctx.controller.mcpReconnect(ctx.snapshot.sessionId, server);
    } else {
      status = await ctx.controller.mcpSetEnabled(ctx.snapshot.sessionId, server, action === "enable");
    }
    ctx.appendNote(describeMcpStatus(status), status.state === "connected" || status.state === "disabled" ? "success" : "error");
    ctx.store.requestRefresh();
  });
}

async function runDoctorCommand(ctx: CommandContext): Promise<void> {
  await ctx.runWithBusy("Running doctor checks", async () => {
    const root = ctx.snapshot.workspace?.activePath ?? ctx.snapshot.session?.workspacePath ?? ctx.initialWorkspacePath;
    const checks = await runDoctor(root);
    ctx.setPanel({ kind: "doctor", lines: doctorLines(checks) });
    if (checks.some((check) => check.status === "fail")) ctx.appendNote("Doctor found failing checks.", "error");
  });
}

function describeMcpStatus(status: ExtraServerStatus): string {
  if (status.state === "connected") return `mcp ${status.name} connected ${glyphs.dot} ${String(status.toolCount)} tools`;
  if (status.state === "disabled") return `mcp ${status.name} disabled for this session`;
  return `mcp ${status.name} ${status.state}${status.lastError ? `: ${status.lastError}` : ""}`;
}

function formatCleanResult(result: WorkspaceCleanResult): string {
  return `Cleaned worktrees: removed ${String(result.removed.length)} ${glyphs.dot} skipped dirty ${String(result.skippedDirty.length)} ${glyphs.dot} missing ${String(result.missing.length)} ${glyphs.dot} pruned ${String(result.prunedRecords.length)} records`;
}
