export type SessionTurnRole = "user" | "assistant";

export interface SessionTurnMetrics {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  // How many prompt tokens were cache hits. Persisted so the session's cost can
  // be recomputed with the same cache discount the live footer already applies —
  // without it, buildStats prices every prompt token at the (120× dearer) miss
  // rate and the sidebar overstates spend.
  cachedPromptTokens?: number;
}

export interface SessionTurn {
  role: SessionTurnRole;
  content: string;
  timestampMs: number;
  elapsedMs?: number | null;
  metrics?: SessionTurnMetrics;
}

export interface SessionStats {
  elapsedMs: number;
  generateMs: number;
  turnCount: number;
  costUsd: number;
  totalTokens: number;
}

export interface ChatSession {
  id: string;
  createdAt: string;
  lastUpdatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  turns: SessionTurn[];
  sessionStats: SessionStats;
  label: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastUpdatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  label: string;
  turnCount: number;
  costUsd: number;
  path: string;
  scope: "project" | "global";
}

export interface LoadedSession {
  session: ChatSession;
  path: string;
  jsonlPath: string;
  scope: "project" | "global";
  warnings: string[];
}
