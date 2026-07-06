import React from "react";
import { Box, Text } from "ink";
import { truncate } from "../format.js";
import type { TuiSnapshot } from "../state.js";
import { glyphs, palette } from "../theme.js";

/**
 * Compact bottom status area for the single active session: one session line,
 * one dim state line, and one contextual hint line — everything else lives in
 * the transcript.
 */
export function StatusBar({
  snapshot,
  tunnelMessage,
  hint,
}: {
  snapshot: TuiSnapshot;
  tunnelMessage: string;
  hint: string;
}): React.ReactElement {
  const workspace =
    snapshot.workspace?.activePath ?? snapshot.session?.workspacePath ?? snapshot.initialWorkspacePath ?? "no workspace";
  const mode = snapshot.workspace?.mode ?? snapshot.session?.defaultMode ?? "direct";
  const backend = snapshot.session?.backendStatus.connected ? "backend ok" : snapshot.session ? "backend off" : "backend idle";
  const mcpTotal = snapshot.mcpServers.length;
  const mcpConnected = snapshot.mcpServers.filter((server) => server.state === "connected").length;
  const mcp = mcpTotal ? ` ${glyphs.dot} mcp ${String(mcpConnected)}/${String(mcpTotal)}` : "";
  const external = snapshot.session && snapshot.session.owner !== "tui";
  const closed = Boolean(snapshot.workspace?.closedAt);
  const live = Boolean(snapshot.sessionId) && !closed;
  return (
    <Box flexDirection="column" paddingX={1}>
      {live ? (
        <Text wrap="truncate-end">
          <Text color={palette.accent} bold>
            {truncate(snapshot.label ?? snapshot.sessionId ?? "session", 24)}
            {mode === "worktree" ? "*" : ""}
          </Text>
          <Text dimColor>
            {" "}
            {glyphs.dot} {mode} {glyphs.dot} {backend}
            {mcp}
            {external ? ` ${glyphs.dot} attached read-only` : ""}
          </Text>
          {snapshot.pendingApprovals.length ? (
            <Text color={palette.warn} bold>
              {" "}
              !{String(snapshot.pendingApprovals.length)}
            </Text>
          ) : null}
        </Text>
      ) : (
        <Text dimColor>no active session {glyphs.dot} /new opens one</Text>
      )}
      <Text dimColor wrap="truncate-end">
        {tunnelMessage} {glyphs.dot} {truncate(workspace, 64)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}
