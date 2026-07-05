import React from "react";
import { Box, Text } from "ink";
import type { SlashCommand } from "../commands/registry.js";
import { pad } from "../format.js";
import { glyphs, palette } from "../theme.js";
import { TextField } from "./TextField.js";

export function Composer({
  value,
  inputKey,
  onChange,
  onSubmit,
  placeholder,
  focus,
}: {
  value: string;
  /** Bumped whenever the value is replaced programmatically (completion, history). */
  inputKey: number;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  focus: boolean;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor={focus ? palette.accent : "gray"} paddingX={1}>
      <Text color={palette.accent}>{glyphs.prompt} </Text>
      {/* Remounting on programmatic replacements (completion, history) puts the
          cursor at the end of the new value. */}
      <TextField
        key={inputKey}
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
        focus={focus}
      />
    </Box>
  );
}

/**
 * Slash command menu below the composer; ArrowUp/Down moves the selection,
 * Tab completes it, Enter runs it — same interaction as Claude Code.
 */
export function SlashMenu({ suggestions, selected }: { suggestions: SlashCommand[]; selected: number }): React.ReactElement | null {
  if (!suggestions.length) return null;
  return (
    <Box flexDirection="column" paddingX={2}>
      {suggestions.map((command, index) => {
        const active = index === selected;
        const planned = command.stage === "planned";
        return (
          <Text key={command.name} color={active ? palette.accent : planned ? "gray" : undefined} bold={active}>
            {active ? `${glyphs.pointer} ` : "  "}
            {pad(command.usage, 42)}
            <Text color={active ? palette.accent : undefined} dimColor={!active}>
              {command.description}
              {planned ? " (planned)" : ""}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
