import React from "react";
import { Box, Text } from "ink";
import { glyphs, palette } from "../theme.js";
import { SelectList, type SelectOption } from "./SelectList.js";

/**
 * Bordered single-choice picker styled like the approval dialog. The parent owns
 * the selected index and key handling (arrows + Enter, number accelerators, Esc
 * to cancel).
 */
export function ChoicePrompt({
  title,
  body,
  options,
  selected,
}: {
  title: string;
  body?: string;
  options: SelectOption[];
  selected: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1}>
      <Text color={palette.accent} bold>
        {title}
      </Text>
      {body ? <Text dimColor>{body}</Text> : null}
      <Text> </Text>
      <SelectList options={options} selected={selected} />
      <Text> </Text>
      <Text dimColor>
        ↑/↓ choose {glyphs.dot} 1–{String(options.length)} pick {glyphs.dot} Enter select {glyphs.dot} Esc cancel
      </Text>
    </Box>
  );
}
