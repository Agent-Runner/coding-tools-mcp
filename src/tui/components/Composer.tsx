import React from "react";
import { Box, Text } from "ink";
import { fuzzyMatch, type SlashCommand } from "../commands/registry.js";
import { menuWindow } from "../menu.js";
import { glyphs, palette, USAGE_COLUMN } from "../theme.js";
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
    <Box borderStyle="round" borderColor={focus ? palette.accent : palette.border} paddingX={1}>
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
 * Slash command menu below the composer; ArrowUp/Down moves the selection
 * (wrapping at the ends), Tab completes it, Enter runs it. Characters that the
 * typed query matched are highlighted, the way Codex CLI and OpenCode do it.
 *
 * `suggestions` is always the FULL ranked list and `selected` an index into
 * it; only rendering is windowed to `maxVisible` rows. Slicing here (and not
 * in the caller) keeps the highlighted row and the command Enter runs in
 * lockstep.
 */
export function SlashMenu({
  suggestions,
  selected,
  query,
  maxVisible,
}: {
  suggestions: SlashCommand[];
  selected: number;
  query: string;
  maxVisible: number;
}): React.ReactElement | null {
  if (!suggestions.length) {
    if (!query) return null;
    return (
      <Box paddingX={2}>
        <Text dimColor>no matching commands</Text>
      </Box>
    );
  }
  const { start, end } = menuWindow(suggestions.length, selected, maxVisible);
  return (
    <Box flexDirection="column" paddingX={2}>
      {suggestions.slice(start, end).map((command, sliceIndex) => {
        const active = start + sliceIndex === selected;
        const matched = new Set(fuzzyMatch(query, command.name)?.positions ?? []);
        // usage is always "/" + name + optional args; keep the args tail dim and
        // pad so descriptions line up in a column.
        const argsTail = command.usage.slice(1 + command.name.length);
        const tailPad = Math.max(1, USAGE_COLUMN - command.usage.length);
        const nameColor = active ? palette.accent : undefined;
        return (
          <Text key={command.name} bold={active} wrap="truncate-end">
            <Text color={nameColor}>{active ? `${glyphs.pointer} ` : "  "}</Text>
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
            <Text color={nameColor} dimColor={!active}>
              {command.description}
            </Text>
          </Text>
        );
      })}
      {suggestions.length > maxVisible ? (
        <Text dimColor>{`  ${String(selected + 1)}/${String(suggestions.length)} ${glyphs.dot} ↑/↓`}</Text>
      ) : null}
    </Box>
  );
}
