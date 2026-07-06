import { useState } from "react";
import type { Key } from "ink";

/**
 * One modal single-choice picker (tunnel provider, MCP server, clean mode).
 * `meta` carries prompt-level context such as the pending /mcp action.
 */
export interface Picker<T, M = undefined> {
  items: T[] | undefined;
  meta: M | undefined;
  choice: number;
  open: (items: T[], meta?: M) => void;
  close: () => void;
  current: () => T | undefined;
  /**
   * Shared keyboard protocol: Esc/n cancels, 1..9 picks directly, arrows move,
   * Enter picks the highlighted item. Returns false when the key is not for
   * this picker. onPick(undefined) means canceled; the picker closes on pick.
   */
  handleKey: (inputChar: string, key: Key, onPick: (item: T | undefined) => void) => boolean;
}

export function usePicker<T, M = undefined>(): Picker<T, M> {
  const [state, setState] = useState<{ items?: T[]; meta?: M; choice: number }>({ choice: 0 });
  const items = state.items;

  const open = (nextItems: T[], meta?: M): void => {
    setState({ items: nextItems, meta, choice: 0 });
  };

  const close = (): void => {
    setState({ choice: 0 });
  };

  const current = (): T | undefined => {
    if (!items?.length) return undefined;
    return items[Math.min(state.choice, items.length - 1)];
  };

  const handleKey = (inputChar: string, key: Key, onPick: (item: T | undefined) => void): boolean => {
    if (!items?.length) return false;
    const count = items.length;
    const digit = Number.parseInt(inputChar, 10);
    if (key.escape || inputChar === "n" || inputChar === "N") {
      close();
      onPick(undefined);
      return true;
    }
    if (Number.isInteger(digit) && digit >= 1 && digit <= count) {
      const picked = items[digit - 1];
      close();
      onPick(picked);
      return true;
    }
    if (key.upArrow) {
      setState((previous) => ({ ...previous, choice: Math.max(0, previous.choice - 1) }));
      return true;
    }
    if (key.downArrow) {
      setState((previous) => ({ ...previous, choice: Math.min(count - 1, previous.choice + 1) }));
      return true;
    }
    if (key.return) {
      const picked = current();
      close();
      onPick(picked);
      return true;
    }
    return true; // Modal: swallow other keys while the picker is up.
  };

  return { items, meta: state.meta, choice: state.choice, open, close, current, handleKey };
}
