import { describe, expect, it } from "vitest";
import { editText } from "../src/tui/components/TextField.js";

const noKeys = {
  ctrl: false,
  meta: false,
  tab: false,
  escape: false,
  return: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
  backspace: false,
  delete: false,
};

const key = (overrides: Partial<typeof noKeys> = {}) => ({ ...noKeys, ...overrides });

describe("editText", () => {
  it("ignores ctrl and meta chords so app shortcuts do not leak characters", () => {
    // Ink reports Ctrl+O as input "o" with key.ctrl set and broadcasts it to
    // every handler; the composer must not insert the "o".
    expect(editText("/insp", 5, "o", key({ ctrl: true }))).toBeUndefined();
    expect(editText("", 0, "o", key({ ctrl: true }))).toBeUndefined();
    expect(editText("abc", 3, "f", key({ meta: true }))).toBeUndefined();
  });

  it("leaves navigation keys the app owns untouched", () => {
    for (const name of ["tab", "escape", "upArrow", "downArrow", "pageUp", "pageDown"] as const) {
      expect(editText("abc", 1, "", key({ [name]: true }))).toBeUndefined();
    }
  });

  it("submits on Enter", () => {
    expect(editText("/new", 4, "", key({ return: true }))).toBe("submit");
  });

  it("inserts printable input at the cursor, including pasted chunks", () => {
    expect(editText("", 0, "a", key())).toEqual({ value: "a", cursor: 1 });
    expect(editText("ac", 1, "b", key())).toEqual({ value: "abc", cursor: 2 });
    expect(editText("ad", 1, "bc", key())).toEqual({ value: "abcd", cursor: 3 });
    expect(editText("ab", 5, "c", key())).toEqual({ value: "abc", cursor: 3 });
  });

  it("deletes the character before the cursor on backspace and delete", () => {
    expect(editText("abc", 3, "", key({ backspace: true }))).toEqual({ value: "ab", cursor: 2 });
    expect(editText("abc", 1, "", key({ delete: true }))).toEqual({ value: "bc", cursor: 0 });
    expect(editText("abc", 0, "", key({ backspace: true }))).toEqual({ value: "abc", cursor: 0 });
  });

  it("moves the cursor with arrows and home/end within bounds", () => {
    expect(editText("abc", 1, "", key({ leftArrow: true }))).toEqual({ value: "abc", cursor: 0 });
    expect(editText("abc", 0, "", key({ leftArrow: true }))).toEqual({ value: "abc", cursor: 0 });
    expect(editText("abc", 2, "", key({ rightArrow: true }))).toEqual({ value: "abc", cursor: 3 });
    expect(editText("abc", 3, "", key({ rightArrow: true }))).toEqual({ value: "abc", cursor: 3 });
    expect(editText("abc", 2, "", key({ home: true }))).toEqual({ value: "abc", cursor: 0 });
    expect(editText("abc", 1, "", key({ end: true }))).toEqual({ value: "abc", cursor: 3 });
  });

  it("ignores empty input events", () => {
    expect(editText("abc", 1, "", key())).toBeUndefined();
  });
});
