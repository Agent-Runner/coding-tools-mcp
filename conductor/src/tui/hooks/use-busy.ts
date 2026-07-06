import { useEffect, useState } from "react";
import { spinnerFrames } from "../theme.js";

export interface BusyState {
  label: string;
  startedAt: number;
}

export interface BusyRunner {
  busy: BusyState | undefined;
  spinnerFrame: number;
  /** Run one TUI task under the spinner; errors go to onError instead of throwing. */
  runWithBusy: (label: string, task: () => Promise<void>) => Promise<void>;
  setBusy: (state: BusyState | undefined) => void;
}

export function useBusy(onError: (error: unknown) => void): BusyRunner {
  const [busy, setBusy] = useState<BusyState | undefined>(undefined);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  useEffect(() => {
    if (!busy) return undefined;
    const interval = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % spinnerFrames.length);
    }, 120);
    return () => {
      clearInterval(interval);
    };
  }, [busy]);

  const runWithBusy = async (label: string, task: () => Promise<void>): Promise<void> => {
    setBusy({ label, startedAt: Date.now() });
    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(undefined);
    }
  };

  return { busy, spinnerFrame, runWithBusy, setBusy };
}
