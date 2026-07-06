import { describe, expect, it, vi } from "vitest";
import type { ToolCallEvent } from "../src/shared/types.js";
import type { TuiSnapshot } from "../src/tui/state.js";
import { TuiSnapshotStore, emptySnapshot, fingerprintSnapshot } from "../src/tui/store.js";

function snapshotWithEvents(events: ToolCallEvent[]): TuiSnapshot {
  return {
    ...emptySnapshot(),
    sessionId: "session-a",
    events,
    toolCalls: events,
  };
}

function toolCall(tool: string): ToolCallEvent {
  return {
    ts: "2026-07-03T12:00:01.000Z",
    sessionId: "session-a",
    type: "tool_call",
    tool,
    argsSummary: "{}",
    durationMs: 5,
  };
}

describe("TuiSnapshotStore", () => {
  it("notifies subscribers only when the snapshot fingerprint changes", async () => {
    let current = snapshotWithEvents([toolCall("read_file")]);
    const loader = vi.fn(() => Promise.resolve(current));
    const store = new TuiSnapshotStore({}, loader);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    await store.refresh();
    expect(notifications).toBe(1);
    expect(store.getSnapshot().sessionId).toBe("session-a");

    // Same content: reload happens, no re-render is triggered.
    current = snapshotWithEvents([toolCall("read_file")]);
    await store.refresh();
    expect(notifications).toBe(1);

    current = snapshotWithEvents([toolCall("read_file"), toolCall("write_file")]);
    await store.refresh();
    expect(notifications).toBe(2);
    expect(store.getSnapshot().events).toHaveLength(2);
  });

  it("keeps the previous snapshot when the loader fails", async () => {
    let fail = false;
    const good = snapshotWithEvents([toolCall("read_file")]);
    const loader = vi.fn(() => (fail ? Promise.reject(new Error("boom")) : Promise.resolve(good)));
    const store = new TuiSnapshotStore({}, loader);
    await store.refresh();
    fail = true;
    await store.refresh();
    expect(store.getSnapshot().sessionId).toBe("session-a");
  });

  it("reloads with the requested session id", async () => {
    const loader = vi.fn((options: { requestedSessionId?: string }) =>
      Promise.resolve({ ...emptySnapshot(), sessionId: options.requestedSessionId }),
    );
    const store = new TuiSnapshotStore({}, loader);
    store.setRequestedSession("session-b");
    await vi.waitFor(() => {
      expect(store.getSnapshot().sessionId).toBe("session-b");
    });
    expect(store.requestedSession()).toBe("session-b");
  });

  it("fingerprints track pending approvals and workspace close transitions", () => {
    const base = snapshotWithEvents([toolCall("read_file")]);
    const approval = {
      id: "req-1",
      sessionId: "session-a",
      status: "pending" as const,
      createdAt: "2026-07-03T12:00:00.000Z",
      updatedAt: "2026-07-03T12:00:00.000Z",
      argsSummary: "{}",
      args: {},
    };
    expect(fingerprintSnapshot({ ...base, pendingApprovals: [approval] })).not.toBe(fingerprintSnapshot(base));

    const workspace = {
      sessionId: "session-a",
      mode: "direct" as const,
      sourcePath: "/repo",
      activePath: "/repo",
      openedAt: "2026-07-03T12:00:00.000Z",
    };
    const open = fingerprintSnapshot({ ...base, workspace });
    const closed = fingerprintSnapshot({ ...base, workspace: { ...workspace, closedAt: "2026-07-03T13:00:00.000Z" } });
    expect(closed).not.toBe(open);
  });

  it("fingerprints track mcp server state changes", () => {
    const base = snapshotWithEvents([toolCall("read_file")]);
    const connected = { ...base, mcpServers: [{ name: "github", state: "connected" as const, toolCount: 12 }] };
    const errored = { ...base, mcpServers: [{ name: "github", state: "error" as const, toolCount: 0 }] };
    expect(fingerprintSnapshot(connected)).not.toBe(fingerprintSnapshot(base));
    expect(fingerprintSnapshot(connected)).not.toBe(fingerprintSnapshot(errored));
    expect(fingerprintSnapshot(connected)).toBe(fingerprintSnapshot({ ...connected }));
  });
});
