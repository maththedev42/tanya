import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { SessionSummary } from "../../sessions/types";
import { relativeAge } from "../../cli/sessionsCommand";

// Claude-style interactive session list for `/resume` with no id: arrow keys
// (or j/k) move, Enter resumes the highlighted session, Esc cancels.
export function SessionPicker({ sessions, onSelect, onCancel }: {
  sessions: SessionSummary[] | null;
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const active = sessions !== null && sessions.length > 0;

  useInput(
    (input, key) => {
      if (!sessions) return;
      if (key.escape || input === "q") {
        onCancel();
        return;
      }
      if (key.upArrow || input === "k") {
        setIndex((current) => (current - 1 + sessions.length) % sessions.length);
        return;
      }
      if (key.downArrow || input === "j") {
        setIndex((current) => (current + 1) % sessions.length);
        return;
      }
      if (key.return) {
        const session = sessions[Math.min(index, sessions.length - 1)];
        if (session) onSelect(session.id);
      }
    },
    { isActive: active },
  );

  if (!sessions) return null;
  if (sessions.length === 0) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text color="cyan">No saved sessions found. Press Esc to dismiss.</Text>
      </Box>
    );
  }

  const now = new Date();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text color="cyan" bold>
        Resume a session
      </Text>
      {sessions.map((session, sessionIndex) => {
        const selected = sessionIndex === index;
        const age = relativeAge(new Date(session.lastUpdatedAt), now);
        const label = session.label || "(untitled)";
        const line = `${age.padEnd(10)} ${String(session.turnCount).padStart(3)}t  ${label}`;
        return (
          <Text key={session.id} {...(selected ? { color: "green" } : {})} wrap="truncate-end">
            {selected ? "❯ " : "  "}
            {line}
            <Text dimColor> · {session.id}</Text>
          </Text>
        );
      })}
      <Text dimColor>↑/↓ select · Enter resume · Esc cancel</Text>
    </Box>
  );
}
