import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { runDoctor } from "../cli/doctor.js";
import { markTuiAttached, type PermissionApprovalRequest } from "../shared/approvals.js";
import {
  findSlashCommand,
  parseCloseCommand,
  parseNewCommand,
  parseSlashCommand,
  parseTunnelCommand,
  suggestSlashCommands,
} from "./commands/registry.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { ChoicePrompt } from "./components/ChoicePrompt.js";
import { Composer, SlashMenu } from "./components/Composer.js";
import { OnboardingView, optionsForStep } from "./components/OnboardingView.js";
import {
  ScrollPanel,
  approvalPanelLines,
  batonPanelLines,
  doctorLines,
  helpLines,
  inspectLines,
} from "./components/Panels.js";
import { StatusBar } from "./components/StatusBar.js";
import { Transcript } from "./components/Transcript.js";
import { diffDisplayLines, errorMessage, formatElapsedSeconds, textDisplayLines } from "./format.js";
import {
  advanceOnboarding,
  loadOnboardingState,
  onboardingDefault,
  type OnboardingState,
} from "./onboarding.js";
import { TuiSessionController, type TunnelMethod } from "./session-controller.js";
import { TuiSnapshotStore } from "./store.js";
import { glyphs, palette, spinnerFrames, type DisplayLine } from "./theme.js";
import { TranscriptBuilder, type NoteKind, type TranscriptItem } from "./transcript.js";

const CTC_VERSION = "0.1.0";
const HISTORY_LIMIT = 50;
const CTRL_C_WINDOW_MS = 1500;

type PanelKind = "help" | "diff" | "baton" | "approvals" | "config" | "inspect" | "doctor";

interface PanelState {
  kind: PanelKind;
  lines?: DisplayLine[];
}

interface BusyState {
  label: string;
  startedAt: number;
}

const PANEL_TITLES: Record<PanelKind, string> = {
  help: "Help",
  diff: "Recent Changes",
  baton: "Baton",
  approvals: "Pending Approvals",
  config: "Profile",
  inspect: "Event Inspector",
  doctor: "Doctor",
};

export function TuiApp({
  requestedSessionId,
  initialWorkspacePath,
}: {
  requestedSessionId?: string;
  initialWorkspacePath?: string;
}): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const controllerRef = useRef<TuiSessionController | undefined>(undefined);
  if (!controllerRef.current) controllerRef.current = new TuiSessionController();
  const controller = controllerRef.current;

  const storeRef = useRef<TuiSnapshotStore | undefined>(undefined);
  if (!storeRef.current) storeRef.current = new TuiSnapshotStore({ requestedSessionId, initialWorkspacePath });
  const store = storeRef.current;

  const builderRef = useRef<TranscriptBuilder | undefined>(undefined);
  if (!builderRef.current) builderRef.current = new TranscriptBuilder();
  const builder = builderRef.current;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const [size, setSize] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }));
  const textWidth = Math.max(40, Math.min(size.columns - 2, 120));

  const [items, setItems] = useState<TranscriptItem[]>(() => [
    builder.banner({
      title: "Coding Tools Conductor",
      version: CTC_VERSION,
      workspace: initialWorkspacePath ?? process.cwd(),
      tips: [
        "/new opens a workspace session for model clients",
        "/help lists commands and keys",
        `Tab cycles sessions ${glyphs.dot} Ctrl+O inspects recent events`,
      ],
    }),
  ]);
  const [epoch, setEpoch] = useState(0);

  const [input, setInput] = useState("");
  const [composerEpoch, setComposerEpoch] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const historyDraft = useRef("");

  // Programmatic replacements (Tab completion, history) remount the text input via
  // composerEpoch so the cursor lands at the end instead of staying mid-string.
  const replaceInput = (value: string): void => {
    setInput(value);
    setComposerEpoch((epoch) => epoch + 1);
  };

  const [panel, setPanel] = useState<PanelState | undefined>(undefined);
  const [scroll, setScroll] = useState(0);

  const [busy, setBusy] = useState<BusyState | undefined>(undefined);
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const [onboarding, setOnboarding] = useState<OnboardingState | undefined>(undefined);
  const [onboardingChoice, setOnboardingChoice] = useState(0);

  const [approvalCursor, setApprovalCursor] = useState(0);
  const [approvalChoice, setApprovalChoice] = useState(0);

  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [tunnelMessage, setTunnelMessage] = useState(() => controller.tunnelStatus().message);
  const [tunnelMethods, setTunnelMethods] = useState<TunnelMethod[] | undefined>(undefined);
  const [tunnelChoice, setTunnelChoice] = useState(0);

  // The menu is a command picker: it opens on "/name" and closes once you type a
  // space and move on to arguments (matching Codex CLI / OpenCode).
  const menuOpen = !onboarding && /^\/\S*$/.test(input);
  const suggestions = useMemo(() => (menuOpen ? suggestSlashCommands(input) : []), [menuOpen, input]);
  const menuQuery = input.startsWith("/") ? input.slice(1) : "";
  const menuVisible = menuOpen;

  const orderedSessions = useMemo(
    () => [...snapshot.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [snapshot.sessions],
  );

  const approvalQueue = useMemo(() => {
    const seen = new Set<string>();
    const queue: PermissionApprovalRequest[] = [];
    for (const approval of [...snapshot.pendingApprovals, ...snapshot.allPendingApprovals]) {
      if (seen.has(approval.id)) continue;
      seen.add(approval.id);
      queue.push(approval);
    }
    return queue;
  }, [snapshot.pendingApprovals, snapshot.allPendingApprovals]);
  const approvalVisible = approvalQueue.length > 0 && !onboarding;
  const activeApproval = approvalQueue[Math.min(approvalCursor, Math.max(approvalQueue.length - 1, 0))];
  const tunnelPickVisible = Boolean(tunnelMethods?.length) && !onboarding && !approvalVisible;

  const onboardingOptions = useMemo(() => (onboarding ? optionsForStep(onboarding) : []), [onboarding]);

  const appendItems = (added: TranscriptItem[]): void => {
    if (added.length) setItems((previous) => [...previous, ...added]);
  };

  const appendNote = (text: string, kind: NoteKind = "info"): void => {
    appendItems([builder.note(text, kind, textWidth)]);
  };

  // Store lifecycle: watch ~/.ctc/logs and poll as a fallback.
  useEffect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, [store]);

  // In-process events from TUI-owned sessions refresh the snapshot instantly.
  useEffect(() => {
    return controller.onEvent(() => {
      store.requestRefresh();
    });
  }, [controller, store]);

  useEffect(() => {
    return () => {
      void controller.closeClients();
    };
  }, [controller]);

  // Append newly observed session events to the committed transcript.
  useEffect(() => {
    if (!snapshot.sessionId) return;
    if (!store.requestedSession()) store.setRequestedSession(snapshot.sessionId);
    const summary = snapshot.sessions.find((session) => session.sessionId === snapshot.sessionId);
    appendItems(
      builder.syncSession({
        sessionId: snapshot.sessionId,
        label: summary?.label ?? snapshot.sessionId,
        events: snapshot.events,
        width: textWidth,
      }),
    );
  }, [snapshot, textWidth]);

  // Onboarding kicks in when the initial workspace has no profile yet.
  useEffect(() => {
    if (requestedSessionId) return undefined;
    let cancelled = false;
    void loadOnboardingState(initialWorkspacePath).then((state) => {
      if (cancelled) return;
      setOnboarding(state);
      if (state) appendNote("No profile found for this repo — answer three quick questions, then run /new.", "hint");
    });
    return () => {
      cancelled = true;
    };
  }, [requestedSessionId, initialWorkspacePath]);

  // Heartbeat that routes lower-level permission requests to this TUI.
  useEffect(() => {
    if (!snapshot.sessionId) return undefined;
    const sessionId = snapshot.sessionId;
    void markTuiAttached(sessionId);
    const interval = setInterval(() => {
      void markTuiAttached(sessionId);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [snapshot.sessionId]);

  useEffect(() => {
    if (!busy) return undefined;
    const interval = setInterval(() => {
      setSpinnerFrame((frame) => (frame + 1) % spinnerFrames.length);
    }, 120);
    return () => {
      clearInterval(interval);
    };
  }, [busy]);

  useEffect(() => {
    const onResize = (): void => {
      setSize({ columns: stdout.columns, rows: stdout.rows });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    setApprovalCursor((cursor) => Math.min(cursor, Math.max(approvalQueue.length - 1, 0)));
  }, [approvalQueue.length]);

  useEffect(() => {
    setApprovalChoice(0);
  }, [activeApproval?.id]);

  useEffect(() => {
    setScroll(0);
  }, [panel?.kind]);

  useEffect(() => {
    return () => {
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    };
  }, []);

  const switchToSession = (sessionId: string): void => {
    store.setRequestedSession(sessionId);
    setPanel(undefined);
  };

  const cycleSession = (offset: number): void => {
    if (!orderedSessions.length) return;
    const currentIndex = Math.max(
      0,
      orderedSessions.findIndex((session) => session.sessionId === snapshot.sessionId),
    );
    const next = orderedSessions[(currentIndex + offset + orderedSessions.length) % orderedSessions.length];
    if (next && next.sessionId !== snapshot.sessionId) switchToSession(next.sessionId);
  };

  const respondToApproval = (approved: boolean): void => {
    if (!activeApproval) return;
    void controller.respondToApproval(activeApproval.sessionId, activeApproval.id, approved);
    appendNote(
      `${approved ? "Approved" : "Denied"} permission request in ${activeApproval.sessionId}.`,
      approved ? "success" : "info",
    );
    store.requestRefresh();
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

  const completeSelected = (): void => {
    const selected = suggestions[Math.min(menuIndex, suggestions.length - 1)];
    if (!selected) return;
    const parsed = safeParse(input);
    if (parsed && parsed.name === selected.name && parsed.args.length) return;
    replaceInput(`/${selected.name} `);
    setMenuIndex(0);
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

  const handleCtrlC = (): void => {
    if (ctrlCArmed) {
      exit();
      return;
    }
    clearInput();
    setCtrlCArmed(true);
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    ctrlCTimer.current = setTimeout(() => {
      setCtrlCArmed(false);
    }, CTRL_C_WINDOW_MS);
  };

  const clearTranscript = (): void => {
    stdout.write("\u001B[2J\u001B[3J\u001B[H");
    setItems([]);
    setEpoch((value) => value + 1);
    appendNote("Transcript cleared.", "hint");
  };

  const pushHistory = (entry: string): void => {
    setHistory((entries) => {
      const next = entries.filter((item) => item !== entry);
      return [...next, entry].slice(-HISTORY_LIMIT);
    });
  };

  const runWithBusy = async (label: string, task: () => Promise<void>): Promise<void> => {
    setBusy({ label, startedAt: Date.now() });
    try {
      await task();
    } catch (error) {
      appendNote(errorMessage(error), "error");
    } finally {
      setBusy(undefined);
    }
  };

  const submitInput = (value: string): void => {
    setHistoryIndex(undefined);
    if (onboarding) {
      void submitOnboarding(value);
      return;
    }
    const trimmed = value.trim();
    clearInput();
    if (!trimmed) return;

    let commandText = trimmed;
    if (trimmed.startsWith("/")) {
      const menu = suggestSlashCommands(trimmed);
      const selected = menu[Math.min(menuIndex, Math.max(menu.length - 1, 0))];
      const parsed = safeParse(trimmed);
      if (selected && parsed && !parsed.args.length && parsed.name !== selected.name) {
        commandText = `/${selected.name}`;
      }
    }
    void runCommand(commandText);
  };

  const submitOnboarding = async (value: string): Promise<void> => {
    if (!onboarding || busy) return;
    const typed = value.trim();
    const option = onboardingOptions[Math.min(onboardingChoice, Math.max(onboardingOptions.length - 1, 0))];
    if (!typed && option?.requiresInput) {
      appendNote(option.hint ?? "Type a value and press Enter.", "hint");
      return;
    }
    const answer = typed || option?.value || "";
    clearInput();
    setBusy({ label: "Saving profile", startedAt: Date.now() });
    try {
      const next = await advanceOnboarding(onboarding, answer);
      setOnboardingChoice(0);
      if (next.complete) {
        setOnboarding(undefined);
        appendNote(`Profile written for ${next.repoPath}. Run /new to open a workspace session.`, "success");
      } else {
        setOnboarding(next);
      }
    } catch (error) {
      appendNote(errorMessage(error), "error");
    } finally {
      setBusy(undefined);
    }
  };

  const runCommand = async (trimmed: string): Promise<void> => {
    pushHistory(trimmed);
    if (!trimmed.startsWith("/")) {
      appendNote("The transcript mirrors model-driven sessions; type / to browse TUI commands.", "hint");
      return;
    }
    let parsed;
    try {
      parsed = parseSlashCommand(trimmed);
    } catch (error) {
      appendNote(errorMessage(error), "error");
      return;
    }
    if (!parsed) return;
    const command = findSlashCommand(parsed.name);
    if (!command) {
      appendNote(`Unknown command ${parsed.raw}. Type /help to see available commands.`, "error");
      return;
    }
    if (command.stage === "planned") {
      appendNote(`${command.usage} is not wired into the TUI yet. ${command.description}`, "hint");
      return;
    }
    if (busy && command.name !== "quit") {
      appendNote("A TUI command is already running.", "hint");
      return;
    }

    setPanel(undefined);
    switch (command.name) {
      case "help":
        setPanel({ kind: "help" });
        break;
      case "diff":
        setPanel({ kind: "diff" });
        break;
      case "baton":
        setPanel({ kind: "baton" });
        break;
      case "approvals":
        setPanel({ kind: "approvals" });
        break;
      case "inspect":
        setPanel({ kind: "inspect" });
        break;
      case "clear":
        clearTranscript();
        break;
      case "switch":
        runSwitchCommand(parsed.args);
        break;
      case "new":
        await runNewCommand(parsed.args);
        break;
      case "close":
        await runCloseCommand(parsed.args);
        break;
      case "merge":
        await runMergeCommand();
        break;
      case "tunnel":
        await runTunnelCommand(parsed.args);
        break;
      case "config":
        await runConfigCommand(parsed.args);
        break;
      case "doctor":
        await runDoctorCommand();
        break;
      case "quit":
        exit();
        break;
      default:
        appendNote(`${command.usage} is registered but not wired yet.`, "hint");
    }
  };

  const runSwitchCommand = (args: string[]): void => {
    if (!orderedSessions.length) {
      appendNote("No sessions found yet — /new opens one.", "hint");
      return;
    }
    const target = args[0];
    if (!target) {
      cycleSession(1);
      return;
    }
    const numeric = Number.parseInt(target, 10);
    const session = Number.isInteger(numeric)
      ? orderedSessions[numeric - 1]
      : orderedSessions.find((item) => item.sessionId.includes(target) || item.label.includes(target));
    if (!session) {
      appendNote(`No session matched ${target}.`, "error");
      return;
    }
    switchToSession(session.sessionId);
  };

  const runNewCommand = async (args: string[]): Promise<void> => {
    await runWithBusy("Opening workspace", async () => {
      const parsedNew = parseNewCommand(args);
      const path = parsedNew.path ?? initialWorkspacePath;
      const result = await controller.create({ path, mode: parsedNew.mode, resume: parsedNew.resume });
      switchToSession(result.sessionId);
      appendNote(result.message, "success");
      store.requestRefresh();
    });
  };

  const runCloseCommand = async (args: string[]): Promise<void> => {
    const sessionId = snapshot.sessionId;
    if (!sessionId) {
      appendNote("No active session to close.", "hint");
      return;
    }
    await runWithBusy("Closing workspace", async () => {
      const parsedClose = parseCloseCommand(args);
      const result = await controller.close(sessionId, { force: parsedClose.force });
      appendNote(result.message, result.closed ? "success" : "hint");
      if (result.closed) store.setRequestedSession(undefined);
      store.requestRefresh();
    });
  };

  const runMergeCommand = async (): Promise<void> => {
    const sessionId = snapshot.sessionId;
    if (!sessionId) {
      appendNote("No active session to merge.", "hint");
      return;
    }
    await runWithBusy("Merging worktree", async () => {
      const result = await controller.merge(sessionId);
      appendNote(result.message, result.applied ? "success" : "hint");
      store.requestRefresh();
    });
  };

  const startTunnelWith = async (method: TunnelMethod): Promise<void> => {
    await runWithBusy(method.kind === "install" ? "Installing cloudflared" : `Starting tunnel via ${method.label}`, async () => {
      if (method.note) appendNote(method.note, "hint");
      const command =
        method.kind === "install"
          ? await controller.installCloudflaredProvider(method.plan, (line) => {
              appendNote(line, "info");
            })
          : method.command;
      const result = await controller.startTunnel(command);
      setTunnelMessage(result.state.message);
      appendNote(result.message, "success");
      store.requestRefresh();
    });
  };

  const pickTunnelMethod = (method: TunnelMethod | undefined): void => {
    setTunnelMethods(undefined);
    setTunnelChoice(0);
    if (!method) {
      appendNote("Tunnel canceled. Run /tunnel start to try again, or /config tunnel none.", "hint");
      return;
    }
    void startTunnelWith(method);
  };

  const runTunnelCommand = async (args: string[]): Promise<void> => {
    let parsedTunnel;
    try {
      parsedTunnel = parseTunnelCommand(args);
    } catch (error) {
      appendNote(errorMessage(error), "error");
      return;
    }
    if (parsedTunnel.action === "start") {
      // startTunnelWith owns its own busy spinner, so don't nest one here.
      const methods = controller.tunnelMethods();
      const ready = methods.find((method) => method.id === "cloudflared");
      if (ready) {
        await startTunnelWith(ready); // cloudflared already installed — no prompt
      } else if (methods.length) {
        setTunnelChoice(0);
        setTunnelMethods(methods);
      } else {
        appendNote("No tunnel provider available. Install cloudflared or Node's npx, then retry.", "error");
      }
      return;
    }
    await runWithBusy("Updating tunnel", async () => {
      if (parsedTunnel.action === "stop") {
        const result = await controller.stopTunnel();
        setTunnelMessage(result.state.message);
        appendNote(result.message, "info");
      } else {
        const state = controller.tunnelStatus();
        setTunnelMessage(state.message);
        appendNote(state.publicUrl ? `Tunnel: ${state.publicUrl}` : state.message, "info");
      }
    });
  };

  const runConfigCommand = async (args: string[]): Promise<void> => {
    await runWithBusy("Loading profile", async () => {
      const result = await controller.configure(initialWorkspacePath, args);
      setPanel({ kind: "config", lines: textDisplayLines(result.text) });
      if (result.changed) appendNote("Profile updated.", "success");
    });
  };

  const runDoctorCommand = async (): Promise<void> => {
    await runWithBusy("Running doctor checks", async () => {
      const root = snapshot.workspace?.activePath ?? snapshot.session?.workspacePath ?? initialWorkspacePath;
      const checks = await runDoctor(root);
      setPanel({ kind: "doctor", lines: doctorLines(checks) });
      if (checks.some((check) => check.status === "fail")) appendNote("Doctor found failing checks.", "error");
    });
  };

  const panelLines = useMemo((): DisplayLine[] => {
    if (!panel) return [];
    switch (panel.kind) {
      case "diff":
        return diffDisplayLines(snapshot.checkpoints.at(-1));
      case "baton":
        return batonPanelLines(snapshot);
      case "help":
        return helpLines();
      case "approvals":
        return approvalPanelLines(approvalQueue);
      case "inspect":
        return inspectLines(snapshot.events);
      default:
        return panel.lines ?? [];
    }
  }, [panel, snapshot, approvalQueue]);

  const panelHeight = Math.max(8, Math.min(size.rows - 9, panelLines.length + 3));
  const pageSize = Math.max(1, panelHeight - 3);

  useInput((inputChar, key) => {
    const isCtrlC = (key.ctrl && (inputChar === "c" || inputChar === "C")) || inputChar === "\u0003";
    if (isCtrlC) {
      handleCtrlC();
      return;
    }
    if (onboarding) {
      if (key.upArrow && !input) setOnboardingChoice((choice) => Math.max(0, choice - 1));
      else if (key.downArrow && !input)
        setOnboardingChoice((choice) => Math.min(Math.max(onboardingOptions.length - 1, 0), choice + 1));
      else if (key.escape) clearInput();
      return;
    }
    if (approvalVisible && activeApproval) {
      if (inputChar === "y" || inputChar === "Y" || inputChar === "1") respondToApproval(true);
      else if (inputChar === "n" || inputChar === "N" || inputChar === "2" || key.escape) respondToApproval(false);
      else if (key.upArrow) setApprovalChoice(0);
      else if (key.downArrow) setApprovalChoice(1);
      else if (key.return) respondToApproval(approvalChoice === 0);
      else if (key.leftArrow) setApprovalCursor((cursor) => Math.max(0, cursor - 1));
      else if (key.rightArrow) setApprovalCursor((cursor) => Math.min(approvalQueue.length - 1, cursor + 1));
      return;
    }
    if (tunnelPickVisible && tunnelMethods) {
      const count = tunnelMethods.length;
      const digit = Number.parseInt(inputChar, 10);
      if (key.escape || inputChar === "n" || inputChar === "N") pickTunnelMethod(undefined);
      else if (Number.isInteger(digit) && digit >= 1 && digit <= count) pickTunnelMethod(tunnelMethods[digit - 1]);
      else if (key.upArrow) setTunnelChoice((choice) => Math.max(0, choice - 1));
      else if (key.downArrow) setTunnelChoice((choice) => Math.min(count - 1, choice + 1));
      else if (key.return) pickTunnelMethod(tunnelMethods[Math.min(tunnelChoice, count - 1)]);
      return;
    }
    if (key.ctrl && (inputChar === "o" || inputChar === "O" || inputChar === "\u000F")) {
      setPanel((current) => (current?.kind === "inspect" ? undefined : { kind: "inspect" }));
      return;
    }
    if (key.escape) {
      if (input) clearInput();
      else if (panel) setPanel(undefined);
      return;
    }
    if (key.tab && key.shift) {
      if (!input) cycleSession(-1);
      return;
    }
    if (key.tab) {
      if (menuVisible) completeSelected();
      else if (!input) cycleSession(1);
      return;
    }
    if (key.upArrow) {
      if (menuVisible) {
        if (suggestions.length) setMenuIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
      } else if (panel) setScroll((value) => Math.max(0, value - 1));
      else navigateHistory(-1);
      return;
    }
    if (key.downArrow) {
      if (menuVisible) {
        if (suggestions.length) setMenuIndex((index) => (index + 1) % suggestions.length);
      } else if (panel) setScroll((value) => value + 1);
      else navigateHistory(1);
      return;
    }
    // ←/→ page open panels while the composer is empty (Mac keyboards have no
    // PgUp/PgDn); with text present they keep moving the input cursor instead.
    if (key.leftArrow && panel && !input) {
      setScroll((value) => Math.max(0, value - pageSize));
      return;
    }
    if (key.rightArrow && panel && !input) {
      setScroll((value) => value + pageSize);
      return;
    }
    if (key.pageUp && panel) {
      setScroll((value) => Math.max(0, value - pageSize));
      return;
    }
    if (key.pageDown && panel) {
      setScroll((value) => value + pageSize);
    }
  });

  const hint = ctrlCArmed
    ? "Press Ctrl+C again to exit"
    : onboarding
      ? `↑/↓ choose ${glyphs.dot} Enter accept ${glyphs.dot} or type a value`
      : approvalVisible
        ? "Answer the permission request above"
        : tunnelPickVisible
          ? "Pick a tunnel provider above · Esc cancels"
          : panel
          ? `↑/↓ scroll ${glyphs.dot} ←/→ page ${glyphs.dot} Esc close`
          : menuVisible
            ? `↑/↓ choose ${glyphs.dot} Tab complete ${glyphs.dot} Enter run ${glyphs.dot} Esc clear`
            : `/ commands ${glyphs.dot} Tab sessions ${glyphs.dot} Ctrl+O inspector ${glyphs.dot} Ctrl+C twice to quit`;

  return (
    <Box flexDirection="column">
      <Transcript items={items} epoch={epoch} />
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {onboarding ? (
          <OnboardingView state={onboarding} options={onboardingOptions} choice={onboardingChoice} />
        ) : approvalVisible && activeApproval ? (
          <ApprovalPrompt
            approval={activeApproval}
            index={approvalCursor}
            total={approvalQueue.length}
            choice={approvalChoice}
            width={textWidth}
          />
        ) : tunnelPickVisible && tunnelMethods ? (
          <ChoicePrompt
            title="Start a public tunnel with…"
            body="cloudflared was not found. Pick how to expose this MCP server."
            options={tunnelMethods.map((method) => ({ label: method.label, hint: method.note }))}
            selected={Math.min(tunnelChoice, tunnelMethods.length - 1)}
          />
        ) : panel ? (
          <ScrollPanel title={PANEL_TITLES[panel.kind]} lines={panelLines} scroll={scroll} height={panelHeight} />
        ) : null}
        {busy ? (
          <Text color={palette.accent}>
            {spinnerFrames[spinnerFrame] ?? "⠋"} {busy.label}…{" "}
            <Text dimColor>({formatElapsedSeconds(busy.startedAt)})</Text>
          </Text>
        ) : null}
        <Composer
          value={input}
          inputKey={composerEpoch}
          onChange={handleInputChange}
          onSubmit={submitInput}
          placeholder={onboarding ? onboardingDefault(onboarding) : "/ for commands"}
          focus={!approvalVisible && !tunnelPickVisible}
        />
        {menuVisible && !approvalVisible && !tunnelPickVisible ? (
          <SlashMenu
            suggestions={suggestions}
            selected={Math.min(menuIndex, Math.max(suggestions.length - 1, 0))}
            query={menuQuery}
          />
        ) : null}
        <StatusBar snapshot={snapshot} sessions={orderedSessions} tunnelMessage={tunnelMessage} hint={hint} />
      </Box>
    </Box>
  );
}

function safeParse(value: string): { name: string; args: string[] } | undefined {
  try {
    return parseSlashCommand(value);
  } catch {
    return undefined;
  }
}
