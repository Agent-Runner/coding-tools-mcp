/**
 * Visual constants shared by every TUI component so the whole surface reads
 * as one product: glyphs, ink color names, and spinner frames.
 */

export const glyphs = {
  prompt: "›",
  bullet: "●",
  result: "⎿",
  pointer: "❯",
  working: "✳",
  divider: "─",
  dot: "·",
} as const;

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const palette = {
  accent: "cyan",
  ok: "green",
  error: "red",
  warn: "yellow",
  border: "gray",
} as const;

/** Column where command descriptions start in the slash menu and /help. */
export const USAGE_COLUMN = 42;

export interface DisplayLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}
