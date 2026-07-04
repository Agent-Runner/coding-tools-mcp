import React from "react";
import { Box, Text } from "ink";
import type { DoctorCheck } from "../../cli/doctor.js";
import { formatBatonBundle } from "../../baton/protocol.js";
import type { PermissionApprovalRequest } from "../../shared/approvals.js";
import type { ConductorEvent } from "../../shared/types.js";
import { slashCommands } from "../commands/registry.js";
import { formatDuration, pad, timeOf, wrapText } from "../format.js";
import type { TuiSnapshot } from "../state.js";
import { glyphs, palette, type DisplayLine } from "../theme.js";

/**
 * Bounded scrollable panel shown in the live region (diff, help, inspector…).
 * ArrowUp/Down and PgUp/PgDn scroll it; Esc closes it.
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
      ? `  ${String(start + 1)}-${String(start + visible.length)} of ${String(lines.length)} ${glyphs.dot} ↑/↓ scroll ${glyphs.dot} Esc close`
      : `  Esc close`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
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
  const available = slashCommands.filter((command) => command.stage === "available");
  const planned = slashCommands.filter((command) => command.stage === "planned");
  const lines: DisplayLine[] = [{ text: "Commands", bold: true }];
  for (const command of available) lines.push({ text: `  ${pad(command.usage, 42)} ${command.description}` });
  if (planned.length) {
    lines.push({ text: "" });
    lines.push({ text: "Planned", bold: true });
    for (const command of planned) lines.push({ text: `  ${pad(command.usage, 42)} ${command.description}`, dim: true });
  }
  lines.push({ text: "" });
  lines.push({ text: "Keys", bold: true });
  lines.push({ text: "  Enter               run the typed command (or the selected menu entry)" });
  lines.push({ text: "  Tab                 complete the slash command; cycle sessions when input is empty" });
  lines.push({ text: "  Shift+Tab           cycle sessions backwards" });
  lines.push({ text: "  ↑/↓                 menu selection, panel scroll, or input history" });
  lines.push({ text: "  Ctrl+O              open the event inspector" });
  lines.push({ text: "  Esc                 clear input / close panel / deny the pending approval" });
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
  return [
    {
      text: `${timeOf(event.ts)} session started ${glyphs.dot} ${event.workspacePath} ${glyphs.dot} ${event.backendType}`,
      bold: true,
    },
  ];
}

export function doctorLines(checks: DoctorCheck[]): DisplayLine[] {
  if (!checks.length) return [{ text: "No checks were run.", dim: true }];
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks.map((check) => ({
    text: `${pad(check.status.toUpperCase(), 5)} ${pad(check.name, width)}  ${check.detail}`,
    color: check.status === "fail" ? palette.error : check.status === "warn" ? palette.warn : palette.ok,
  }));
}
