import React from "react";
import { Box, Text } from "ink";
import { glyphs, palette } from "../theme.js";
import { SelectList } from "./SelectList.js";

/**
 * Small yes/no confirmation styled like the approval dialog. The parent owns the
 * choice index and key handling; y/n and 1/2 accelerators plus arrows + Enter.
 */
export function ConfirmPrompt({
  title,
  body,
  confirmLabel,
  cancelLabel,
  choice,
}: {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  choice: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Text color={palette.accent} bold>
        {title}
      </Text>
      {body ? <Text dimColor>{body}</Text> : null}
      <Text> </Text>
      <SelectList options={[{ label: `${confirmLabel} (y)` }, { label: `${cancelLabel} (n)` }]} selected={choice} />
      <Text> </Text>
      <Text dimColor>
        ↑/↓ choose {glyphs.dot} Enter confirm {glyphs.dot} Esc cancel
      </Text>
    </Box>
  );
}
