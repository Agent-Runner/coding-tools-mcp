import React from "react";
import { Box, Text } from "ink";
import { fuzzyMatch, type SlashCommand } from "../commands/registry.js";
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

const COMMAND_COLUMN = 40;

/**
 * Slash command menu below the composer; ArrowUp/Down moves the selection
 * (wrapping at the ends), Tab completes it, Enter runs it. Characters that the
 * typed query matched are highlighted, the way Codex CLI and OpenCode do it.
 */
export function SlashMenu({
  suggestions,
  selected,
  query,
}: {
  suggestions: SlashCommand[];
  selected: number;
  query: string;
}): React.ReactElement | null {
  if (!suggestions.length) {
    if (!query) return null;
    return (
      <Box paddingX={2}>
        <Text dimColor>no matching commands</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={2}>
      {suggestions.map((command, index) => {
        const active = index === selected;
        const planned = command.stage === "planned";
        const matched = new Set(fuzzyMatch(query, command.name)?.positions ?? []);
        // usage is always "/" + name + optional args; keep the args tail dim and
        // pad so descriptions line up in a column.
        const argsTail = command.usage.slice(1 + command.name.length);
        const tailPad = Math.max(1, COMMAND_COLUMN - 1 - command.name.length - argsTail.length);
        const nameColor = active ? palette.accent : planned ? "gray" : undefined;
        return (
          <Text key={command.name} bold={active} wrap="truncate-end">
            <Text color={active ? palette.accent : undefined}>{active ? `${glyphs.pointer} ` : "  "}</Text>
            <Text color={nameColor}>/</Text>
            {Array.from(command.name, (char, charIndex) => (
              <Text
                key={`${command.name}-${String(charIndex)}`}
                color={matched.has(charIndex) ? palette.accent : nameColor}
                bold={matched.has(charIndex)}
              >
                {char}
              </Text>
            ))}
            <Text dimColor>{`${argsTail}${" ".repeat(tailPad)}`}</Text>
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
