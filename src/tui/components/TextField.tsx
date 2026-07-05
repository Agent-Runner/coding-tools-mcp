import React, { useEffect, useState } from "react";
import { Text, useInput, type Key } from "ink";

export interface TextEdit {
  value: string;
  cursor: number;
}

type EditKey = Pick<
  Key,
  | "ctrl"
  | "meta"
  | "tab"
  | "escape"
  | "return"
  | "upArrow"
  | "downArrow"
  | "leftArrow"
  | "rightArrow"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "backspace"
  | "delete"
>;

const WORD_CHAR = /\S/;

/** Start of the word at or before `at`: skip trailing spaces, then the word. */
function wordStartLeft(value: string, at: number): number {
  let index = at;
  while (index > 0 && !WORD_CHAR.test(value[index - 1] ?? "")) index -= 1;
  while (index > 0 && WORD_CHAR.test(value[index - 1] ?? "")) index -= 1;
  return index;
}

/** End of the word at or after `at`: skip leading spaces, then the word. */
function wordEndRight(value: string, at: number): number {
  let index = at;
  while (index < value.length && !WORD_CHAR.test(value[index] ?? "")) index += 1;
  while (index < value.length && WORD_CHAR.test(value[index] ?? "")) index += 1;
  return index;
}

function deleteWordBackward(value: string, at: number): TextEdit {
  const start = wordStartLeft(value, at);
  return { value: value.slice(0, start) + value.slice(at), cursor: start };
}

/**
 * Pure single-line edit step. Returns "submit" for Enter, undefined for keys the
 * field does not own (unhandled chords, navigation the app handles), or the next
 * state.
 *
 * Ink broadcasts every key to all useInput handlers, so chords like Ctrl+O reach
 * this field as input "o" with key.ctrl set. We handle a fixed set of readline
 * editing shortcuts (matching Codex CLI and OpenCode) and ignore every other
 * ctrl/meta combination so app-level shortcuts never leak characters here.
 */
export function editText(value: string, cursor: number, input: string, key: EditKey): TextEdit | "submit" | undefined {
  const at = Math.max(0, Math.min(cursor, value.length));
  if (key.return) return "submit";

  if (key.ctrl && !key.meta) {
    if (key.leftArrow) return { value, cursor: wordStartLeft(value, at) };
    if (key.rightArrow) return { value, cursor: wordEndRight(value, at) };
    switch (input) {
      case "a": // line start
        return { value, cursor: 0 };
      case "e": // line end
        return { value, cursor: value.length };
      case "b": // char left
        return { value, cursor: Math.max(0, at - 1) };
      case "f": // char right
        return { value, cursor: Math.min(value.length, at + 1) };
      case "u": // kill to line start
        return { value: value.slice(at), cursor: 0 };
      case "k": // kill to line end
        return { value: value.slice(0, at), cursor: at };
      case "w": // kill word backward
        return deleteWordBackward(value, at);
      case "d": // delete char forward
        return at >= value.length ? { value, cursor: at } : { value: value.slice(0, at) + value.slice(at + 1), cursor: at };
      default:
        return undefined;
    }
  }

  if (key.meta && !key.ctrl) {
    if (key.backspace || key.delete) return deleteWordBackward(value, at);
    if (input === "b" || key.leftArrow) return { value, cursor: wordStartLeft(value, at) };
    if (input === "f" || key.rightArrow) return { value, cursor: wordEndRight(value, at) };
    return undefined;
  }

  if (key.tab || key.escape) return undefined;
  if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) return undefined;
  if (key.leftArrow) return { value, cursor: Math.max(0, at - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, at + 1) };
  if (key.home) return { value, cursor: 0 };
  if (key.end) return { value, cursor: value.length };
  if (key.backspace || key.delete) {
    if (at === 0) return { value, cursor: 0 };
    return { value: value.slice(0, at - 1) + value.slice(at), cursor: at - 1 };
  }
  if (!input) return undefined;
  return { value: value.slice(0, at) + input + value.slice(at), cursor: at + input.length };
}

/**
 * Minimal controlled text input. The cursor starts at the end of the initial
 * value, so parents that replace the value programmatically (completion,
 * history) remount it via a React key to land the cursor at the end.
 */
export function TextField({
  value,
  onChange,
  onSubmit,
  placeholder,
  focus,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  focus: boolean;
}): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);

  useEffect(() => {
    setCursor((current) => Math.min(current, value.length));
  }, [value]);

  useInput(
    (input, key) => {
      const edit = editText(value, cursor, input, key);
      if (edit === "submit") {
        onSubmit(value);
        return;
      }
      if (!edit) return;
      setCursor(edit.cursor);
      if (edit.value !== value) onChange(edit.value);
    },
    { isActive: focus },
  );

  if (!value) {
    if (!focus) return <Text color="gray">{placeholder}</Text>;
    return (
      <Text>
        <Text inverse>{placeholder.slice(0, 1) || " "}</Text>
        <Text color="gray">{placeholder.slice(1)}</Text>
      </Text>
    );
  }
  if (!focus) return <Text>{value}</Text>;
  const at = Math.min(cursor, value.length);
  return (
    <Text>
      {value.slice(0, at)}
      <Text inverse>{value.slice(at, at + 1) || " "}</Text>
      {value.slice(at + 1)}
    </Text>
  );
}
