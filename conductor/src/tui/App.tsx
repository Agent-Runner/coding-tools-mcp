import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { markTuiAttached } from "../shared/approvals.js";
import type { ExtraServerStatus } from "../shared/types.js";
import { dispatchInput, executeClean, runMcpAction, startTunnelWith, type CommandContext, type McpPickRequest } from "./commands/handlers.js";
import { parseSlashCommand, suggestSlashCommands } from "./commands/registry.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { ChoicePrompt } from "./components/ChoicePrompt.js";
import { Composer, SlashMenu } from "./components/Composer.js";
import { OnboardingView, optionsForStep } from "./components/OnboardingView.js";
import { PANEL_TITLES, panelContentLines, ScrollPanel, type PanelState } from "./components/Panels.js";
import { StatusBar } from "./components/StatusBar.js";
import { Transcript } from "./components/Transcript.js";
import { errorMessage, formatElapsedSeconds } from "./format.js";
import { useBusy } from "./hooks/use-busy.js";
import { useComposer } from "./hooks/use-composer.js";
import { usePicker } from "./hooks/use-picker.js";
import { useTerminalSize } from "./hooks/use-terminal-size.js";
import {
  advanceOnboarding,
  loadOnboardingState,
  onboardingDefault,
  type OnboardingState,
} from "./onboarding.js";
import { TuiSessionController, type TunnelMethod } from "./session-controller.js";
import { TuiSnapshotStore } from "./store.js";
import { glyphs, palette, spinnerFrames } from "./theme.js";
import { TranscriptBuilder, type NoteKind, type TranscriptItem } from "./transcript.js";

const CTC_VERSION = "0.1.0";
const CTRL_C_WINDOW_MS = 1500;

interface CleanChoice {
  label: string;
  hint: string;
  force: boolean;
}

const CLEAN_CHOICES: CleanChoice[] = [
  { label: "Clean", hint: "remove clean worktrees, skip dirty ones", force: false },
  { label: "Force clean", hint: "also remove worktrees with uncommitted changes", force: true },
];

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

  // ctc tui <id> observes an external session; plain ctc hosts its own.
  const attachMode = Boolean(requestedSessionId);
  const bootRef = useRef(false);
  // Repo of the ACTIVE session; sourcePath (never the worktree checkout) so
  // profile operations and /new re-target the repository itself.
  const activeRepoPath = (): string | undefined =>
    snapshot.workspace?.sourcePath ?? snapshot.session?.workspacePath ?? initialWorkspacePath;

  const size = useTerminalSize();
  const textWidth = Math.max(40, Math.min(size.columns - 2, 120));
  // Menu rows fit within the live region even on short terminals; a counter
  // footer appears when the full command list overflows this budget.
  const menuMaxVisible = Math.max(4, Math.min(10, size.rows - 12));

  const [items, setItems] = useState<TranscriptItem[]>(() => [
    builder.banner({
      title: "Coding Tools Conductor",
      version: CTC_VERSION,
      workspace: initialWorkspacePath ?? process.cwd(),
      tips: [
        "The session for this repo starts automatically",
        "/new switches repo or isolation (--worktree)",
        `/help lists commands ${glyphs.dot} Ctrl+O inspects recent events`,
      ],
    }),
  ]);
  const [epoch, setEpoch] = useState(0);

  const composer = useComposer();
  const { input, menuIndex } = composer;

  const [panel, setPanel] = useState<PanelState | undefined>(undefined);
  const [scroll, setScroll] = useState(0);

  const [onboarding, setOnboarding] = useState<OnboardingState | undefined>(undefined);
  const [onboardingChoice, setOnboardingChoice] = useState(0);

  const [approvalCursor, setApprovalCursor] = useState(0);
  const [approvalChoice, setApprovalChoice] = useState(0);

  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [tunnelMessage, setTunnelMessage] = useState(() => controller.tunnelStatus().message);
  const tunnelPicker = usePicker<TunnelMethod>();
  const mcpPicker = usePicker<ExtraServerStatus, McpPickRequest["action"]>();
  const cleanPicker = usePicker<CleanChoice, string[]>();
  const untrustedNoticeFor = useRef<string | undefined>(undefined);

  const appendItems = (added: TranscriptItem[]): void => {
    if (added.length) setItems((previous) => [...previous, ...added]);
  };

  const appendNote = (text: string, kind: NoteKind = "info"): void => {
    appendItems([builder.note(text, kind, textWidth)]);
  };

  const { busy, spinnerFrame, runWithBusy, setBusy } = useBusy((error) => {
    appendNote(errorMessage(error), "error");
  });

  const clearTranscript = (): void => {
    stdout.write("\u001B[2J\u001B[3J\u001B[H");
    setItems([]);
    setEpoch((value) => value + 1);
    appendNote("Transcript cleared.", "hint");
  };

  const switchToSession = (sessionId: string): void => {
    store.setRequestedSession(sessionId);
    setPanel(undefined);
  };

  /** Adapters the extracted command handlers use to reach TUI state. */
  const commandContext = (): CommandContext => ({
    controller,
    store,
    snapshot,
    initialWorkspacePath,
    activeRepoPath,
    isBusy: () => Boolean(busy),
    appendNote,
    runWithBusy,
    setPanel,
    setTunnelMessage,
    switchToSession,
    openTunnelPicker: (methods) => {
      tunnelPicker.open(methods);
    },
    openMcpPicker: (request) => {
      mcpPicker.open(request.options, request.action);
    },
    openCleanPicker: (candidates) => {
      cleanPicker.open(CLEAN_CHOICES, candidates);
    },
    clearTranscript,
    exit,
  });

  // The menu is a command picker: it opens on "/name" and closes once you type a
  // space and move on to arguments (matching Codex CLI / OpenCode).
  const menuOpen = !onboarding && /^\/\S*$/.test(input);
  const suggestions = useMemo(() => (menuOpen ? suggestSlashCommands(input) : []), [menuOpen, input]);
  const menuQuery = input.startsWith("/") ? input.slice(1) : "";
  const menuVisible = menuOpen;

  const approvalQueue = snapshot.pendingApprovals;
  const approvalVisible = approvalQueue.length > 0 && !onboarding;
  const activeApproval = approvalQueue[Math.min(approvalCursor, Math.max(approvalQueue.length - 1, 0))];
  const tunnelPickVisible = Boolean(tunnelPicker.items?.length) && !onboarding && !approvalVisible;
  const mcpPickVisible = Boolean(mcpPicker.items?.length) && !onboarding && !approvalVisible && !tunnelPickVisible;
  const cleanPickVisible =
    Boolean(cleanPicker.items) && !onboarding && !approvalVisible && !tunnelPickVisible && !mcpPickVisible;

  const onboardingOptions = useMemo(() => (onboarding ? optionsForStep(onboarding) : []), [onboarding]);

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

  // Auto-stop: quitting the TUI closes the workspace (never force) and stops
  // the runtime; the shutdown promise keeps the process alive until done.
  useEffect(() => {
    return () => {
      void controller.shutdown();
    };
  }, [controller]);

  // Append newly observed session events to the committed transcript.
  useEffect(() => {
    if (!snapshot.sessionId) return;
    appendItems(
      builder.syncSession({
        sessionId: snapshot.sessionId,
        label: snapshot.label ?? snapshot.sessionId,
        events: snapshot.events,
        width: textWidth,
      }),
    );
  }, [snapshot, textWidth]);

  // Boot: launching ctc IS the session. First run detours through onboarding,
  // then starts; attach mode (ctc tui <id>) only observes and never auto-starts.
  // Mount-once by design: the guard ref flips before any await, and
  // controller.create() hard-rejects a second live session as backstop.
  useEffect(() => {
    if (attachMode) return undefined;
    if (bootRef.current) return undefined;
    bootRef.current = true;
    let cancelled = false;
    void loadOnboardingState(initialWorkspacePath).then(async (state) => {
      if (cancelled) return;
      if (state) {
        setOnboarding(state);
        appendNote("No profile found for this repo — answer two quick questions to get started.", "hint");
        return;
      }
      await autoStartSession();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // One-time nudge per session when workspace-declared MCP servers await trust.
  useEffect(() => {
    if (!snapshot.sessionId || untrustedNoticeFor.current === snapshot.sessionId) return;
    const untrusted = snapshot.mcpServers.filter((server) => server.untrusted);
    if (!untrusted.length) return;
    untrustedNoticeFor.current = snapshot.sessionId;
    appendNote(
      `${String(untrusted.length)} MCP server(s) from .ctc/mcp.json are not trusted yet — /mcp to review, /mcp trust <name> to enable.`,
      "hint",
    );
  }, [snapshot.sessionId, snapshot.mcpServers]);

  // Heartbeat that routes an EXTERNAL session's permission requests to this
  // TUI. Hosted sessions use the in-process approval broker instead, so the
  // attached-marker only matters in attach mode.
  useEffect(() => {
    if (!attachMode || !snapshot.sessionId) return undefined;
    const sessionId = snapshot.sessionId;
    void markTuiAttached(sessionId);
    const interval = setInterval(() => {
      void markTuiAttached(sessionId);
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [attachMode, snapshot.sessionId]);

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

  const autoStartSession = async (): Promise<void> => {
    await runWithBusy("Starting session", async () => {
      try {
        const result = await controller.create({ path: initialWorkspacePath });
        switchToSession(result.sessionId);
        appendNote(result.message, "success");
        store.requestRefresh();
      } catch (error) {
        appendNote(errorMessage(error), "error");
        appendNote("No active session — fix the issue above, then /new to retry.", "hint");
      }
    });
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

  const completeSelected = (): void => {
    const selected = suggestions[Math.min(menuIndex, suggestions.length - 1)];
    if (!selected) return;
    const parsed = safeParse(input);
    if (parsed && parsed.name === selected.name && parsed.args.length) return;
    composer.replaceInput(`/${selected.name} `);
    composer.setMenuIndex(0);
  };

  const handleCtrlC = (): void => {
    if (ctrlCArmed) {
      exit();
      return;
    }
    composer.clearInput();
    setCtrlCArmed(true);
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    ctrlCTimer.current = setTimeout(() => {
      setCtrlCArmed(false);
    }, CTRL_C_WINDOW_MS);
  };

  const submitInput = (value: string): void => {
    composer.resetHistoryCursor();
    if (onboarding) {
      void submitOnboarding(value);
      return;
    }
    const trimmed = value.trim();
    composer.clearInput();
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
    composer.pushHistory(commandText);
    void dispatchInput(commandContext(), commandText);
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
    composer.clearInput();
    setBusy({ label: "Saving profile", startedAt: Date.now() });
    let completed = false;
    try {
      const next = await advanceOnboarding(onboarding, answer);
      setOnboardingChoice(0);
      if (next.complete) {
        setOnboarding(undefined);
        appendNote(`Profile written for ${next.repoPath}.`, "success");
        completed = true;
      } else {
        setOnboarding(next);
      }
    } catch (error) {
      appendNote(errorMessage(error), "error");
    } finally {
      setBusy(undefined);
    }
    if (completed) await autoStartSession();
  };

  const panelLines = useMemo(
    () =>
      panel
        ? panelContentLines(panel, snapshot, approvalQueue, controller.mcpStatuses(snapshot.sessionId) !== undefined)
        : [],
    [panel, snapshot, approvalQueue, controller],
  );

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
      else if (key.escape) composer.clearInput();
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
    if (tunnelPickVisible) {
      tunnelPicker.handleKey(inputChar, key, (method) => {
        if (!method) {
          appendNote("Tunnel canceled. Run /tunnel start to try again, or /config tunnel none.", "hint");
          return;
        }
        void startTunnelWith(commandContext(), method);
      });
      return;
    }
    if (mcpPickVisible) {
      const action = mcpPicker.meta;
      mcpPicker.handleKey(inputChar, key, (status) => {
        if (!status || !action) {
          appendNote("MCP action canceled.", "hint");
          return;
        }
        void runMcpAction(commandContext(), action, status.name);
      });
      return;
    }
    if (cleanPickVisible) {
      cleanPicker.handleKey(inputChar, key, (choice) => {
        if (!choice) {
          appendNote("Clean canceled.", "hint");
          return;
        }
        void executeClean(commandContext(), choice.force);
      });
      return;
    }
    if (key.ctrl && (inputChar === "o" || inputChar === "O" || inputChar === "\u000F")) {
      setPanel((current) => (current?.kind === "inspect" ? undefined : { kind: "inspect" }));
      return;
    }
    if (key.escape) {
      if (input) composer.clearInput();
      else if (panel) setPanel(undefined);
      return;
    }
    if (key.tab) {
      if (menuVisible) completeSelected();
      return;
    }
    if (key.upArrow) {
      if (menuVisible) {
        if (suggestions.length) composer.setMenuIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
      } else if (panel) setScroll((value) => Math.max(0, value - 1));
      else composer.navigateHistory(-1);
      return;
    }
    if (key.downArrow) {
      if (menuVisible) {
        if (suggestions.length) composer.setMenuIndex((index) => (index + 1) % suggestions.length);
      } else if (panel) setScroll((value) => value + 1);
      else composer.navigateHistory(1);
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
          ? `Pick a tunnel provider above ${glyphs.dot} Esc cancels`
          : mcpPickVisible
            ? `Pick an MCP server above ${glyphs.dot} Esc cancels`
            : cleanPickVisible
              ? `Pick a clean option above ${glyphs.dot} Esc cancels`
          : panel
          ? `↑/↓ scroll ${glyphs.dot} ←/→ page ${glyphs.dot} Esc close`
          : menuVisible
            ? `↑/↓ choose ${glyphs.dot} Tab complete ${glyphs.dot} Enter run ${glyphs.dot} Esc clear`
            : `/ commands ${glyphs.dot} Ctrl+O inspector ${glyphs.dot} Ctrl+C twice to quit`;

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
        ) : tunnelPickVisible && tunnelPicker.items ? (
          <ChoicePrompt
            title="Start a public tunnel with…"
            body="cloudflared was not found. Pick how to expose this MCP server."
            options={tunnelPicker.items.map((method) => ({ label: method.label, hint: method.note }))}
            selected={Math.min(tunnelPicker.choice, tunnelPicker.items.length - 1)}
          />
        ) : mcpPickVisible && mcpPicker.items ? (
          <ChoicePrompt
            title={`Which MCP server do you want to ${mcpPicker.meta ?? "change"}?`}
            body={`Pick a server; /mcp ${mcpPicker.meta ?? ""} <name> skips this prompt.`}
            options={mcpPicker.items.map((server) => ({
              label: server.name,
              hint: `${server.state}${server.state === "connected" ? ` ${glyphs.dot} ${String(server.toolCount)} tools` : ""}`,
            }))}
            selected={Math.min(mcpPicker.choice, mcpPicker.items.length - 1)}
          />
        ) : cleanPickVisible && cleanPicker.items ? (
          <ChoicePrompt
            title={`Clean ${String(cleanPicker.meta?.length ?? 0)} recorded worktree(s)?`}
            body={`Removes worktrees with no uncommitted changes and prunes closed session records and logs; dirty worktrees are skipped unless forced.${
              snapshot.sessionId && cleanPicker.meta?.includes(snapshot.sessionId)
                ? " Includes the ACTIVE session's worktree — it will close if it has no uncommitted changes."
                : ""
            }`}
            options={cleanPicker.items.map((choice) => ({ label: choice.label, hint: choice.hint }))}
            selected={Math.min(cleanPicker.choice, cleanPicker.items.length - 1)}
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
          inputKey={composer.composerEpoch}
          onChange={composer.handleInputChange}
          onSubmit={submitInput}
          placeholder={onboarding ? onboardingDefault(onboarding) : "/ for commands"}
          focus={!approvalVisible && !tunnelPickVisible && !mcpPickVisible && !cleanPickVisible}
        />
        {menuVisible && !approvalVisible && !tunnelPickVisible && !mcpPickVisible && !cleanPickVisible ? (
          <SlashMenu
            suggestions={suggestions}
            selected={Math.min(menuIndex, Math.max(suggestions.length - 1, 0))}
            query={menuQuery}
            maxVisible={menuMaxVisible}
          />
        ) : null}
        <StatusBar snapshot={snapshot} tunnelMessage={tunnelMessage} hint={hint} />
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
