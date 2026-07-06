import { useRef, useState } from "react";

const HISTORY_LIMIT = 50;

export interface ComposerState {
  input: string;
  /** Remount key for the text input so programmatic replacements move the cursor to the end. */
  composerEpoch: number;
  menuIndex: number;
  setMenuIndex: React.Dispatch<React.SetStateAction<number>>;
  handleInputChange: (value: string) => void;
  replaceInput: (value: string) => void;
  clearInput: () => void;
  resetHistoryCursor: () => void;
  navigateHistory: (direction: -1 | 1) => void;
  pushHistory: (entry: string) => void;
}

/** Composer text, slash-menu cursor, and shell-style input history. */
export function useComposer(): ComposerState {
  const [input, setInput] = useState("");
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const historyDraft = useRef("");

  const replaceInput = (value: string): void => {
    setInput(value);
    setComposerEpoch((epoch) => epoch + 1);
  };

  const handleInputChange = (value: string): void => {
    setHistoryIndex(undefined);
    setMenuIndex(0);
    setInput(value);
  };

  const clearInput = (): void => {
    setInput("");
    setMenuIndex(0);
    setHistoryIndex(undefined);
  };

  const navigateHistory = (direction: -1 | 1): void => {
    if (!history.length) return;
    if (historyIndex === undefined) {
      if (direction === 1) return;
      historyDraft.current = input;
      const index = history.length - 1;
      setHistoryIndex(index);
      replaceInput(history[index] ?? "");
      return;
    }
    const next = historyIndex + direction;
    if (next < 0) return;
    if (next >= history.length) {
      setHistoryIndex(undefined);
      replaceInput(historyDraft.current);
      return;
    }
    setHistoryIndex(next);
    replaceInput(history[next] ?? "");
  };

  const pushHistory = (entry: string): void => {
    setHistory((entries) => {
      const next = entries.filter((item) => item !== entry);
      return [...next, entry].slice(-HISTORY_LIMIT);
    });
  };

  return {
    input,
    composerEpoch,
    menuIndex,
    setMenuIndex,
    handleInputChange,
    replaceInput,
    clearInput,
    resetHistoryCursor: () => {
      setHistoryIndex(undefined);
    },
    navigateHistory,
    pushHistory,
  };
}
