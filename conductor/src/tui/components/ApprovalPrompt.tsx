import React from "react";
import { Box, Text } from "ink";
import type { PermissionApprovalRequest } from "../../shared/approvals.js";
import { timeOf, wrapText } from "../format.js";
import { glyphs, palette } from "../theme.js";
import { SelectList } from "./SelectList.js";

const MAX_ARG_LINES = 8;

/**
 * Permission prompt styled after Claude Code's tool approval dialog:
 * arrow-selectable options with numeric and y/n accelerators.
 */
export function ApprovalPrompt({
  approval,
  index,
  total,
  choice,
  width,
}: {
  approval: PermissionApprovalRequest;
  index: number;
  total: number;
  choice: number;
  width: number;
}): React.ReactElement {
  const argLines = wrapText(approval.argsSummary, Math.max(24, width - 8));
  const shown = argLines.slice(0, MAX_ARG_LINES);
  const hidden = argLines.length - shown.length;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.warn} paddingX={1}>
      <Text color={palette.warn} bold>
        Permission request{total > 1 ? ` (${String(index + 1)}/${String(total)})` : ""}
      </Text>
      <Text dimColor>
        session {approval.sessionId} {glyphs.dot} {timeOf(approval.createdAt)}
      </Text>
      <Text> </Text>
      {shown.map((line, lineIndex) => (
        <Text key={lineIndex}>{"  "}{line}</Text>
      ))}
      {hidden > 0 ? <Text dimColor>{"  "}… {String(hidden)} more lines</Text> : null}
      <Text> </Text>
      <SelectList options={[{ label: "Approve (y)" }, { label: "Deny (n)" }]} selected={choice} />
      <Text> </Text>
      <Text dimColor>
        ↑/↓ choose {glyphs.dot} Enter confirm{total > 1 ? ` ${glyphs.dot} ←/→ next request` : ""} {glyphs.dot} Esc deny
      </Text>
    </Box>
  );
}
