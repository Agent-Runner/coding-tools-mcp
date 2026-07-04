import React from "react";
import { Box, Text } from "ink";
import { glyphs, palette } from "../theme.js";

export interface SelectOption {
  label: string;
  hint?: string;
}

/**
 * Claude-Code-style numbered option list driven by arrow keys. Purely
 * presentational; the parent owns selection state and key handling.
 */
export function SelectList({ options, selected }: { options: SelectOption[]; selected: number }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {options.map((option, index) => {
        const active = index === selected;
        return (
          <Box key={option.label} flexDirection="column">
            <Text color={active ? palette.accent : undefined} bold={active}>
              {active ? `${glyphs.pointer} ` : "  "}
              {String(index + 1)}. {option.label}
            </Text>
            {option.hint && active ? <Text dimColor>{"     "}{option.hint}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
