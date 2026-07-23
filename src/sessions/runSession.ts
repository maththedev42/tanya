import type { RunAgentResult } from "../agent/runner";
import { ChatSessionController } from "./repl";
import { createSession } from "./storage";
import type { ChatSession } from "./types";

// Persists a one-shot `tanya run` as a resumable chat session: each attempt
// becomes a turn (the prompt actually sent → the final report), so
// `tanya --resume <id>` drops the user into a chat that already knows the
// task and what happened — "did u finished?"-style follow-ups just work.

export type RunSessionAttempt = {
  prompt: string;
  message: string;
  startedAt: number;
  elapsedMs: number;
  result: RunAgentResult;
};

export function runSessionLabel(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const compact = firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
  return `run · ${compact || "(no prompt)"}`;
}

export function runSessionsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(0|false|off|no)$/i.test((env.TANYA_RUN_SESSIONS ?? "").trim());
}

export function persistRunSession(options: {
  cwd: string;
  provider: string;
  model: string;
  // The user's original task, used for the label (attempt prompts may be
  // retry-augmented variants).
  taskPrompt: string;
  attempts: RunSessionAttempt[];
}): ChatSession | null {
  if (options.attempts.length === 0) return null;
  const controller = new ChatSessionController(
    createSession({ cwd: options.cwd, provider: options.provider, model: options.model }),
  );
  for (const attempt of options.attempts) {
    controller.appendCompletedTurn(attempt.prompt, attempt.message, attempt.startedAt, attempt.elapsedMs, attempt.result);
  }
  return controller.materialize(runSessionLabel(options.taskPrompt));
}
