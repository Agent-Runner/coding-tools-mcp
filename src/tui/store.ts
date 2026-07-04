import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { ctcHome } from "../profiles/config.js";
import { loadTuiSnapshot, type LoadTuiSnapshotOptions, type TuiSnapshot } from "./state.js";

export type SnapshotLoader = (options: LoadTuiSnapshotOptions) => Promise<TuiSnapshot>;

export interface TuiSnapshotStoreOptions {
  requestedSessionId?: string;
  initialWorkspacePath?: string;
  /** Fallback poll interval for changes fs.watch cannot see (network FS, approval files from other processes). */
  pollMs?: number;
  /** Debounce window that coalesces bursts of fs events into one reload. */
  debounceMs?: number;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_DEBOUNCE_MS = 60;

/**
 * Owns snapshot loading for the TUI. Instead of re-rendering on a fixed
 * timer, the store watches ~/.ctc/logs (every conductor event is appended
 * there, including permission requests) and only notifies subscribers when
 * the snapshot fingerprint actually changed. The API matches React's
 * useSyncExternalStore contract.
 */
export class TuiSnapshotStore {
  private snapshot: TuiSnapshot;
  private fingerprint = "";
  private readonly listeners = new Set<() => void>();
  private watcher: FSWatcher | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private queued = false;
  private stopped = false;

  constructor(
    private readonly options: TuiSnapshotStoreOptions,
    private readonly loader: SnapshotLoader = loadTuiSnapshot,
  ) {
    this.snapshot = emptySnapshot(options.initialWorkspacePath);
  }

  start(): void {
    this.stopped = false;
    void this.refresh();
    this.ensureWatcher();
    this.pollTimer = setInterval(() => {
      this.ensureWatcher();
      void this.refresh();
    }, this.options.pollMs ?? DEFAULT_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  getSnapshot = (): TuiSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setRequestedSession(sessionId: string | undefined): void {
    this.options.requestedSessionId = sessionId;
    void this.refresh();
  }

  requestedSession(): string | undefined {
    return this.options.requestedSessionId;
  }

  /** Coalesce a burst of change notifications into a single reload. */
  requestRefresh(): void {
    if (this.stopped) return;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** Load a fresh snapshot now; notifies only when content changed. */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.queued = true;
      return;
    }
    this.refreshing = true;
    try {
      const next = await this.loader({
        requestedSessionId: this.options.requestedSessionId,
        initialWorkspacePath: this.options.initialWorkspacePath,
      });
      const fingerprint = fingerprintSnapshot(next);
      if (fingerprint !== this.fingerprint) {
        this.fingerprint = fingerprint;
        this.snapshot = next;
        for (const listener of this.listeners) listener();
      }
    } catch {
      // Keep the previous snapshot on transient read errors.
    } finally {
      this.refreshing = false;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    }
  }

  private ensureWatcher(): void {
    if (this.watcher || this.stopped) return;
    const dir = join(ctcHome(), "logs");
    if (!existsSync(dir)) return;
    try {
      this.watcher = watch(dir, () => {
        this.requestRefresh();
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined;
    }
  }
}

export function fingerprintSnapshot(snapshot: TuiSnapshot): string {
  const last = snapshot.events.at(-1);
  return JSON.stringify({
    id: snapshot.sessionId,
    count: snapshot.events.length,
    last: last ? `${last.ts}|${last.type}` : "",
    sessions: [...snapshot.sessions]
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
      .map((session) => [
        session.sessionId,
        session.pendingApprovalCount,
        session.backendConnected ?? null,
        session.mode ?? null,
        session.workspacePath ?? null,
      ]),
    approvals: snapshot.allPendingApprovals.map((approval) => approval.id),
    checkpoints: snapshot.checkpoints.length,
    workspace: snapshot.workspace ? [snapshot.workspace.activePath, snapshot.workspace.closedAt ?? null] : null,
    baton: snapshot.baton
      ? [snapshot.baton.status?.updatedAt ?? null, snapshot.baton.plan?.content.length ?? 0, snapshot.baton.report?.content.length ?? 0]
      : null,
  });
}

export function emptySnapshot(initialWorkspacePath?: string): TuiSnapshot {
  return {
    initialWorkspacePath,
    sessions: [],
    events: [],
    toolCalls: [],
    checkpoints: [],
    pendingApprovals: [],
    allPendingApprovals: [],
  };
}
