import React from "react";
import { Box, Text } from "ink";
import type { DoctorCheck } from "../../cli/doctor.js";
import { formatBatonBundle } from "../../baton/protocol.js";
import type { PermissionApprovalRequest } from "../../shared/approvals.js";
import { WORKSPACE_MCP_FILE } from "../../profiles/mcp.js";
import type { ConductorEvent } from "../../shared/types.js";
import { slashCommandGroups } from "../commands/registry.js";
import { formatDuration, pad, timeOf, wrapText } from "../format.js";
import type { McpServerStatusSnapshot, TuiSnapshot } from "../state.js";
import { glyphs, palette, USAGE_COLUMN, type DisplayLine } from "../theme.js";

/**
 * Bounded scrollable panel shown in the live region (diff, help, inspector…).
 * ↑/↓ scroll by line, ←/→ (and PgUp/PgDn) by page; Esc closes it.
 */
export function ScrollPanel({
  title,
  lines,
  scroll,
  height,
}: {
  title: string;
  lines: DisplayLine[];
  scroll: number;
  height: number;
}): React.ReactElement {
  // Content rows inside the box: total height minus borders and title row.
  const bodyHeight = Math.max(1, height - 3);
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const start = Math.min(scroll, maxScroll);
  const visible = lines.slice(start, start + bodyHeight);
  const scrollInfo =
    lines.length > bodyHeight
      ? `  ${String(start + 1)}-${String(start + visible.length)} of ${String(lines.length)} ${glyphs.dot} ↑/↓ scroll ${glyphs.dot} ←/→ page ${glyphs.dot} Esc close`
      : `  Esc close`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1} height={height}>
      <Text bold>
        {title}
        <Text dimColor>{scrollInfo}</Text>
      </Text>
      {visible.length ? (
        visible.map((line, index) => (
          <Text key={String(start + index)} color={line.color} dimColor={line.dim} bold={line.bold} wrap="truncate-end">
            {line.text || " "}
          </Text>
        ))
      ) : (
        <Text dimColor>Nothing to show.</Text>
      )}
    </Box>
  );
}

export function helpLines(): DisplayLine[] {
  const lines: DisplayLine[] = [];
  for (const group of slashCommandGroups) {
    if (lines.length) lines.push({ text: "" });
    lines.push({ text: group.title, bold: true });
    for (const command of group.commands) {
      lines.push({ text: `  ${pad(command.usage, USAGE_COLUMN)} ${command.description}` });
    }
  }
  lines.push({ text: "" });
  lines.push({ text: "Keys", bold: true });
  lines.push({ text: "  Enter               run the typed command (or the selected menu entry)" });
  lines.push({ text: "  Tab                 complete the selected slash command" });
  lines.push({ text: "  ↑/↓                 menu selection, panel scroll, or input history" });
  lines.push({ text: "  ←/→                 page an open panel when the input is empty" });
  lines.push({ text: "  Ctrl+A / Ctrl+E     move the cursor to the start / end of the line" });
  lines.push({ text: "  Ctrl+W / Ctrl+U / Ctrl+K  delete the previous word / to line start / to line end" });
  lines.push({ text: "  Ctrl+←/→, Alt+←/→   move the cursor by word" });
  lines.push({ text: "  Ctrl+O              open the event inspector" });
  lines.push({ text: "  Esc                 clear input / close panel / cancel pickers / deny the pending approval" });
  lines.push({ text: "  y n 1 2 ←/→         answer permission prompts" });
  lines.push({ text: "  Ctrl+C (twice)      quit" });
  return lines;
}

export function approvalPanelLines(approvals: PermissionApprovalRequest[]): DisplayLine[] {
  if (!approvals.length) return [{ text: "No pending approvals.", dim: true }];
  const lines: DisplayLine[] = [];
  for (const approval of approvals) {
    lines.push({ text: `${timeOf(approval.createdAt)} ${approval.sessionId}`, color: palette.warn, bold: true });
    for (const chunk of wrapText(approval.argsSummary, 96).slice(0, 4)) lines.push({ text: `  ${chunk}` });
  }
  return lines;
}

export function batonPanelLines(snapshot: TuiSnapshot): DisplayLine[] {
  if (!snapshot.baton) return [{ text: "No baton workspace found for this session.", dim: true }];
  return formatBatonBundle(snapshot.baton)
    .trimEnd()
    .split("\n")
    .map((text) => ({ text }));
}

export function inspectLines(events: ConductorEvent[], limit = 20): DisplayLine[] {
  const recent = events.slice(-limit).reverse();
  if (!recent.length) return [{ text: "No events recorded yet.", dim: true }];
  const lines: DisplayLine[] = [];
  for (const event of recent) {
    lines.push(...inspectEventLines(event));
    lines.push({ text: "" });
  }
  lines.pop();
  return lines;
}

function inspectEventLines(event: ConductorEvent): DisplayLine[] {
  if (event.type === "tool_call") {
    const status = event.error ? "error" : "ok";
    const lines: DisplayLine[] = [
      {
        text: `${timeOf(event.ts)} ${event.tool} ${glyphs.dot} ${formatDuration(event.durationMs)} ${glyphs.dot} ${status}`,
        color: event.error ? palette.error : undefined,
        bold: true,
      },
    ];
    for (const chunk of wrapText(event.argsSummary, 96)) lines.push({ text: `  args    ${chunk}` });
    if (event.resultSummary) for (const chunk of wrapText(event.resultSummary, 96).slice(0, 6)) lines.push({ text: `  result  ${chunk}`, dim: true });
    if (event.error) for (const chunk of wrapText(event.error, 96).slice(0, 6)) lines.push({ text: `  error   ${chunk}`, color: palette.error });
    return lines;
  }
  if (event.type === "permission_request") {
    const lines: DisplayLine[] = [
      { text: `${timeOf(event.ts)} permission ${event.state}`, color: event.state === "pending" ? palette.warn : undefined, bold: true },
    ];
    for (const chunk of wrapText(event.argsSummary, 96)) lines.push({ text: `  ${chunk}` });
    return lines;
  }
  if (event.type === "review_checkpoint") {
    return [
      { text: `${timeOf(event.ts)} review checkpoint ${glyphs.dot} since ${event.since}`, bold: true },
      { text: `  ${event.statSummary}` },
    ];
  }
  if (event.type === "server_status") {
    const color = event.state === "connected" ? palette.ok : event.state === "disabled" ? undefined : palette.error;
    const lines: DisplayLine[] = [
      {
        text: `${timeOf(event.ts)} mcp ${event.server} ${event.state}${event.toolCount !== undefined ? ` ${glyphs.dot} ${String(event.toolCount)} tools` : ""}`,
        color,
        bold: true,
        dim: event.state === "disabled",
      },
    ];
    if (event.error) for (const chunk of wrapText(event.error, 96).slice(0, 4)) lines.push({ text: `  ${chunk}`, color: palette.error });
    if (event.droppedTools?.length) lines.push({ text: `  dropped ${event.droppedTools.join(", ")}`, dim: true });
    return lines;
  }
  return [
    {
      text: `${timeOf(event.ts)} session started ${glyphs.dot} ${event.workspacePath} ${glyphs.dot} ${event.backendType}`,
      bold: true,
    },
  ];
}

export function mcpPanelLines(servers: McpServerStatusSnapshot[], options: { hosted: boolean }): DisplayLine[] {
  if (!servers.length) {
    return [
      { text: "No additional MCP servers configured.", dim: true },
      { text: "" },
      { text: `Add entries to ${WORKSPACE_MCP_FILE} in the repo or to the mcpServers`, dim: true },
      { text: "field of the workspace profile (see README M6 Surface).", dim: true },
    ];
  }
  const nameWidth = Math.max(4, ...servers.map((server) => server.name.length));
  const stateWidth = Math.max(5, ...servers.map((server) => server.state.length));
  const lines: DisplayLine[] = [
    { text: `${pad("NAME", nameWidth)}  ${pad("STATE", stateWidth)}  ${pad("TOOLS", 5)}  ${pad("SOURCE", 9)}  DETAIL`, bold: true },
  ];
  for (const server of servers) {
    const detail = server.untrusted
      ? `untrusted ${glyphs.dot} /mcp trust ${server.name}`
      : (server.lastError ?? (server.droppedTools?.length ? `dropped ${server.droppedTools.join(", ")}` : ""));
    const tools = server.state === "connected" ? String(server.toolCount ?? 0) : "-";
    lines.push({
      text: `${pad(server.name, nameWidth)}  ${pad(server.state, stateWidth)}  ${pad(tools, 5)}  ${pad(server.source ?? "", 9)}  ${detail}`,
      color:
        server.state === "connected"
          ? palette.ok
          : server.state === "error" || server.state === "disconnected"
            ? palette.error
            : server.untrusted
              ? palette.warn
              : undefined,
      dim: server.state === "disabled" && !server.untrusted,
    });
  }
  lines.push({ text: "" });
  lines.push(
    options.hosted
      ? { text: `/mcp enable|disable|reconnect|trust <name> ${glyphs.dot} enable/disable are session-only`, dim: true }
      : { text: "read-only: this session runs under ctc start; manage servers from its own process.", dim: true },
  );
  return lines;
}

export function doctorLines(checks: DoctorCheck[]): DisplayLine[] {
  if (!checks.length) return [{ text: "No checks were run.", dim: true }];
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks.map((check) => ({
    text: `${pad(check.status.toUpperCase(), 5)} ${pad(check.name, width)}  ${check.detail}`,
    color: check.status === "fail" ? palette.error : check.status === "warn" ? palette.warn : palette.ok,
  }));
}
