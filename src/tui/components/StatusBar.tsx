import React from "react";
import { Box, Text } from "ink";
import { truncate } from "../format.js";
import type { TuiSessionSummary, TuiSnapshot } from "../state.js";
import { glyphs, palette } from "../theme.js";

/**
 * Compact bottom status area: one session tab strip, one dim state line, and
 * one contextual hint line — everything else lives in the transcript.
 */
export function StatusBar({
  snapshot,
  sessions,
  tunnelMessage,
  hint,
}: {
  snapshot: TuiSnapshot;
  sessions: TuiSessionSummary[];
  tunnelMessage: string;
  hint: string;
}): React.ReactElement {
  const workspace =
    snapshot.workspace?.activePath ?? snapshot.session?.workspacePath ?? snapshot.initialWorkspacePath ?? "no workspace";
  const mode = snapshot.workspace?.mode ?? snapshot.session?.defaultMode ?? "attached";
  const backend = snapshot.session?.backendStatus.connected ? "backend ok" : snapshot.session ? "backend off" : "backend idle";
  return (
    <Box flexDirection="column" paddingX={1}>
      <SessionTabs sessions={sessions} activeSessionId={snapshot.sessionId} />
      <Text dimColor wrap="truncate-end">
        {mode} {glyphs.dot} {backend} {glyphs.dot} {tunnelMessage} {glyphs.dot} {truncate(workspace, 48)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  );
}

function SessionTabs({
  sessions,
  activeSessionId,
}: {
  sessions: TuiSessionSummary[];
  activeSessionId?: string;
}): React.ReactElement {
  if (!sessions.length) {
    return <Text dimColor>no sessions {glyphs.dot} /new to open one</Text>;
  }
  const shown = sessions.slice(0, 9);
  return (
    <Text wrap="truncate-end">
      {shown.map((session, index) => {
        const active = session.sessionId === activeSessionId;
        return (
          <React.Fragment key={session.sessionId}>
            {index ? <Text>  </Text> : null}
            <Text color={active ? palette.accent : undefined} bold={active} dimColor={!active}>
              {String(index + 1)}
              {glyphs.dot}
              {truncate(session.label, 16)}
              {session.mode === "worktree" ? "*" : ""}
            </Text>
            {session.pendingApprovalCount ? (
              <Text color={palette.warn} bold>
                {" "}
                !{String(session.pendingApprovalCount)}
              </Text>
            ) : null}
          </React.Fragment>
        );
      })}
      {sessions.length > shown.length ? <Text dimColor>  +{String(sessions.length - shown.length)} more</Text> : null}
    </Text>
  );
}
