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

/**
 * Pure single-line edit step. Returns "submit" for Enter, undefined for keys the
 * field does not own (chords, navigation the app handles), or the next state.
 *
 * Ink broadcasts every key to all useInput handlers, so chords like Ctrl+O reach
 * this field as input "o" with key.ctrl set; ignoring all ctrl/meta combinations
 * keeps app-level shortcuts from leaking characters into the composer.
 */
export function editText(value: string, cursor: number, input: string, key: EditKey): TextEdit | "submit" | undefined {
  if (key.return) return "submit";
  if (key.ctrl || key.meta || key.tab || key.escape) return undefined;
  if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) return undefined;
  const at = Math.max(0, Math.min(cursor, value.length));
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
