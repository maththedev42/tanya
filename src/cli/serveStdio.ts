import { createInterface } from "node:readline";
import { createJsonlSink } from "../events/jsonl";
import { offablePositiveIntFlag, optionalPositiveIntFlag } from "../config/runtimeFlags";
import type { EventSink } from "../events/types";
import { buildSessionSystemPrompt, runAgent, type RunAgentOptions, type RunAgentResult } from "../agent/runner";
import { createTaskWorktree, isGitRepo } from "./worktree";
import { inferInteractiveRun } from "../agent/interactiveBudget";
import { detectStaleBinary, staleBinaryWarning } from "../agent/buildInfo";
import { dispatchInteractiveCommand } from "../agent/chat";
import { loadProjectCommands } from "../commands/project";
import { listCommands } from "../commands/registry";
import type { ChatMessage, ChatProvider } from "../providers/types";
import type { HostPermissionAnswer, PermissionRequestHandler } from "../safety/permissions/host";
import {
  sessionToChatHistory,
  startChatSession,
} from "../sessions/repl";

// Bounds for the single-line session_replay event. Hosts (the mac app) frame
// stdout with a bounded per-line buffer; an unbounded replay of a months-old
// session produces a line past that bound and the whole replay is dropped —
// the session resumes visually empty. Recent history is what matters on screen;
// the full transcript stays in the session file.
export const REPLAY_MAX_MESSAGES = 400;
export const REPLAY_MAX_MESSAGE_CHARS = 20_000;

// A stall stop pauses the run and asks the user to say "continue". With
// auto-continue (default 2 per user message) serve says it itself first, so
// the user is only interrupted when the task is genuinely hard-stuck. The
// budget resets on every real user message and on any turn that ends without
// stalling. TANYA_AUTO_CONTINUE tunes it; 0/off disables.
export function autoContinueBudgetFromEnv(): number {
  return offablePositiveIntFlag("TANYA_AUTO_CONTINUE", 2);
}

// Optional override for the interactive soft turn budget. Progress extension is
// always on for serve, so this mainly shifts where stall-detection begins; raise
// it (e.g. TANYA_MAX_TURNS=120) for very long single-turn tasks.
export function interactiveMaxTurnsOverride(): number | undefined {
  return optionalPositiveIntFlag("TANYA_MAX_TURNS");
}

export interface ServeStdioOptions {
  provider: ChatProvider;
  cwd: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  routing?: RunAgentOptions["routing"];
  resumeSessionId?: string | undefined;
  permissionTimeoutMs?: number | undefined;
  installProcessHandlers?: boolean | undefined;
  // Run the session in an isolated git worktree (a "task" session): a fresh
  // branch + checkout under the repo's git dir, so the work never touches the
  // main tree until `/task-merge`. Incompatible with resume — task sessions
  // are always fresh.
  worktree?: boolean | undefined;
}

type InboundMessage =
  | { type: "user_message"; text?: unknown }
  | { type: "permission_answer"; id?: unknown; decision?: unknown; persistAs?: unknown }
  | { type: "interrupt" }
  | { type: "command"; text?: unknown }
  | { type: "list_commands" }
  | { type: "shutdown" };

type PendingPermission = {
  resolve: (answer: HostPermissionAnswer) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export async function startServeStdio(options: ServeStdioOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const sink = createJsonlSink(output);

  // Task session: create an isolated worktree and run everything inside it, so
  // the whole session (session files, agent cwd, commands) operates on the
  // worktree, never the main tree. Fail before session_ready if the cwd is not
  // a git repo — a task with nowhere to isolate would silently run in-place.
  let workDir = options.cwd;
  let worktreePath: string | undefined;
  if (options.worktree) {
    if (!(await isGitRepo(options.cwd))) {
      await sink({
        type: "error",
        message: "A task session needs a git repository, but this folder is not one.",
        code: "worktree_requires_git",
      });
      return;
    }
    try {
      const taskId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const meta = await createTaskWorktree(options.cwd, taskId);
      workDir = meta.worktreePath;
      worktreePath = meta.worktreePath;
    } catch (error) {
      await sink({
        type: "error",
        message: "Failed to create the task worktree.",
        code: "worktree_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const sessionStart = startChatSession({
    cwd: workDir,
    provider: options.provider.id,
    model: options.provider.model,
    resumeSessionId: options.resumeSessionId,
  });
  const sessionController = sessionStart.controller;
  let history: ChatMessage[] = sessionStart.resumedSession ? sessionToChatHistory(sessionStart.resumedSession) : [];
  // Pin one system prompt for the whole session. Rebuilding it per turn made
  // the first bytes of every request differ (task-hint-ranked blocks, task
  // history the previous turn just appended to), so the provider prefix cache
  // missed on the entire conversation every turn. Built lazily on the first
  // turn; a failure falls back to the runner's per-turn build.
  let sessionSystemPrompt: string | undefined;
  const pinnedSystemPrompt = async (): Promise<string | undefined> => {
    if (sessionSystemPrompt === undefined) {
      try {
        sessionSystemPrompt = await buildSessionSystemPrompt(workDir, options.provider);
      } catch {
        return undefined;
      }
    }
    return sessionSystemPrompt;
  };
  const pendingPermissions = new Map<string, PendingPermission>();
  let activeAbortController: AbortController | null = null;
  let activeTurn: Promise<void> | null = null;
  let shuttingDown = false;

  const emit: EventSink = async (event) => {
    await sink(event);
  };
  const emitError = async (message: string, code: string, detail?: string) => {
    await emit({ type: "error", message, code, ...(detail ? { detail } : {}) });
  };
  const materialize = () => {
    try {
      sessionController.materialize();
    } catch (error) {
      stderr.write(`[tanya serve] session materialize failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const [id, pending] of pendingPermissions) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ decision: "deny" });
      pendingPermissions.delete(id);
    }
    if (activeTurn) {
      try {
        await activeTurn;
      } catch {
        // Turn errors are already emitted as JSONL error events.
      }
    }
    materialize();
  };

  const onPermissionRequest: PermissionRequestHandler = async (request) => {
    return new Promise((resolve) => {
      const pending: PendingPermission = { resolve };
      if (options.permissionTimeoutMs && options.permissionTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          pendingPermissions.delete(request.id);
          resolve({ decision: "deny" });
          void emitError(`Permission request ${request.id} timed out.`, "permission_timeout");
        }, options.permissionTimeoutMs);
      }
      pendingPermissions.set(request.id, pending);
    });
  };

  const commandOutput = {
    write(chunk: unknown) {
      const message = String(chunk).trimEnd();
      if (message) void emit({ type: "status", message });
      return true;
    },
  } as NodeJS.WritableStream;

  const emitCommands = async () => {
    try {
      await loadProjectCommands(workDir);
    } catch {
      // Project command discovery is best-effort; built-ins still list.
    }
    await emit({
      type: "commands",
      commands: listCommands().map((command) => ({
        name: command.name,
        description: command.description,
        category: command.category ?? "built-in",
      })),
    });
  };

  const autoContinueBudget = autoContinueBudgetFromEnv();
  let autoContinuesLeft = autoContinueBudget;
  let lastTurnStalled = false;

  const startTurn = async (prompt: string, opts: { auto?: boolean } = {}) => {
    if (activeTurn) {
      await emitError("A turn is already running.", "busy");
      return;
    }
    const trimmed = prompt.trim();
    if (!trimmed) return;
    // A real user message is fresh intent: restore the auto-continue budget.
    if (!opts.auto) autoContinuesLeft = autoContinueBudget;
    // Re-check each submission (not just startup): dist/ may have been rebuilt
    // under this long-lived process since it started. A real user message is the
    // moment to remind them before the OLD code runs the task.
    if (!opts.auto) {
      const staleWarning = staleBinaryWarning();
      if (staleWarning) await emit({ type: "status", message: staleWarning });
    }

    const turnPromise = (async () => {
      const startedAt = Date.now();
      const abortController = new AbortController();
      activeAbortController = abortController;
      let result: RunAgentResult | undefined;
      try {
        const inferred = inferInteractiveRun(trimmed);
        const maxTurnsOverride = interactiveMaxTurnsOverride();
        const pinnedPrompt = await pinnedSystemPrompt();
        result = await runAgent({
          provider: options.provider,
          prompt: trimmed,
          cwd: workDir,
          sink: emit,
          history,
          ...(pinnedPrompt !== undefined ? { systemPromptOverride: pinnedPrompt } : {}),
          signal: abortController.signal,
          onPermissionRequest,
          interactive: true,
          // Interactive turns always get progress-based budget extension: a
          // productive run has NO step ceiling — it keeps going while it makes
          // progress and only stops — asking you to say "continue" — when it
          // genuinely stalls. Without this, a prompt the coding-intent heuristic
          // doesn't recognise fell through to the runner's fixed 40-turn cap and
          // stopped mid-task. Override the soft budget with TANYA_MAX_TURNS; set
          // TANYA_HARD_TURN_CEILING to restore a fixed absolute ceiling.
          extendBudgetOnProgress: true,
          ...(options.routing ? { routing: options.routing } : {}),
          ...(inferred.runContext ? { runContext: inferred.runContext } : {}),
          ...(maxTurnsOverride !== undefined
            ? { maxTurns: maxTurnsOverride }
            : inferred.maxTurns !== undefined
              ? { maxTurns: inferred.maxTurns }
              : {}),
        });
        history.push({ role: "user", content: trimmed });
        history.push({ role: "assistant", content: result.message });
        sessionController.appendCompletedTurn(trimmed, result.message, startedAt, Date.now() - startedAt, result);
        lastTurnStalled = result.manifest?.terminationReason === "turn_budget_exhausted";
        // A turn that ends cleanly proves the task moves again: restore the budget.
        if (!lastTurnStalled) autoContinuesLeft = autoContinueBudget;
      } catch (error) {
        lastTurnStalled = false;
        await emitError("Turn failed.", "turn_failed", error instanceof Error ? error.message : String(error));
      } finally {
        activeAbortController = null;
        await emit({
          type: "turn_complete",
          elapsedMs: Date.now() - startedAt,
          ...(result?.metrics?.promptTokens !== undefined ? { promptTokens: result.metrics.promptTokens } : {}),
          ...(result?.metrics?.completionTokens !== undefined ? { completionTokens: result.metrics.completionTokens } : {}),
          ...(result?.metrics?.cachedPromptTokens !== undefined ? { cachedPromptTokens: result.metrics.cachedPromptTokens } : {}),
          ...(result?.metrics?.costUsd !== undefined ? { costUsd: result.metrics.costUsd } : {}),
        });
      }
    })();

    activeTurn = turnPromise;
    void turnPromise.finally(() => {
      if (activeTurn === turnPromise) activeTurn = null;
      maybeAutoContinue();
    });
  };

  // After a stall stop, resume automatically while budget remains — the user
  // shouldn't have to babysit "continue". Bounded so a genuinely hard-stuck
  // task still comes back to them (with the "Stuck on:" detail in the pause).
  const maybeAutoContinue = () => {
    if (shuttingDown || activeTurn || !lastTurnStalled) return;
    if (autoContinuesLeft <= 0) return;
    autoContinuesLeft -= 1;
    lastTurnStalled = false;
    void emit({
      type: "status",
      message: `Paused on a stall — auto-continuing (${autoContinuesLeft} auto-resume${autoContinuesLeft === 1 ? "" : "s"} left before I ask you). Send a message anytime to take over.`,
    });
    void startTurn("continue", { auto: true });
  };

  const handleMessage = async (message: InboundMessage) => {
    switch (message.type) {
      case "user_message":
        if (typeof message.text !== "string") {
          await emitError("user_message.text must be a string.", "invalid_request");
          return;
        }
        await startTurn(message.text);
        return;
      case "permission_answer": {
        const id = typeof message.id === "string" ? message.id : "";
        const pending = pendingPermissions.get(id);
        if (!pending) {
          await emitError(`Unknown or stale permission request: ${id || "<missing>"}.`, "unknown_permission");
          return;
        }
        if (message.decision !== "allow" && message.decision !== "deny") {
          await emitError("permission_answer.decision must be allow or deny.", "invalid_request");
          return;
        }
        const persistAs = message.persistAs === "always" || message.persistAs === "never" ? message.persistAs : undefined;
        if (pending.timer) clearTimeout(pending.timer);
        pendingPermissions.delete(id);
        pending.resolve({ decision: message.decision, ...(persistAs ? { persistAs } : {}) });
        return;
      }
      case "interrupt":
        if (!activeAbortController || activeAbortController.signal.aborted) {
          await emitError("No active turn to interrupt.", "not_running");
          return;
        }
        activeAbortController.abort();
        return;
      case "command":
        if (typeof message.text !== "string" || !message.text.trim().startsWith("/")) {
          await emitError("command.text must be a slash command string.", "invalid_request");
          return;
        }
        if (activeTurn) {
          await emitError("A turn is already running.", "busy");
          return;
        }
        await dispatchInteractiveCommand(message.text.trim(), {
          provider: options.provider,
          cwd: workDir,
          sink: emit,
          output: commandOutput,
          history,
          ...(options.routing ? { routing: options.routing } : {}),
          sessionController,
          clearHistory: () => {
            history = [];
          },
          replaceHistory: (nextHistory) => {
            history = nextHistory;
          },
          onPermissionRequest,
        });
        return;
      case "list_commands":
        await emitCommands();
        return;
      case "shutdown":
        await shutdown();
        return;
      default:
        await emitError(`Unknown inbound message type: ${(message as { type?: unknown }).type ?? "<missing>"}.`, "unknown_message");
    }
  };

  if (sessionStart.resumedSession) {
    const resumed = sessionStart.resumedSession;
    // Seed the client's live footer with the session's persisted totals so a
    // resumed session shows its accumulated cost/tokens (matching the sidebar)
    // instead of resetting to zero until the next turn runs.
    const promptTokens = resumed.turns.reduce((sum, turn) => sum + (turn.metrics?.promptTokens ?? 0), 0);
    const completionTokens = resumed.turns.reduce((sum, turn) => sum + (turn.metrics?.completionTokens ?? 0), 0);
    // The replay goes out as ONE JSONL line; hosts frame stdout with bounded
    // line buffers, so an unbounded replay of a long session silently breaks
    // resume. Keep the most recent turns and truncate pathological messages.
    const replayTurns = resumed.turns.length > REPLAY_MAX_MESSAGES ? resumed.turns.slice(-REPLAY_MAX_MESSAGES) : resumed.turns;
    if (replayTurns.length < resumed.turns.length) {
      await emit({ type: "status", message: `Replaying the last ${replayTurns.length} of ${resumed.turns.length} messages; older history stays in the session file.` });
    }
    await emit({
      type: "session_replay",
      messages: replayTurns.map((turn) => ({
        role: turn.role,
        content: turn.content.length > REPLAY_MAX_MESSAGE_CHARS
          ? `${turn.content.slice(0, REPLAY_MAX_MESSAGE_CHARS)}\n… [truncated for replay]`
          : turn.content,
        timestampMs: turn.timestampMs,
      })),
      stats: {
        promptTokens,
        completionTokens,
        costUsd: resumed.sessionStats.costUsd,
        elapsedMs: resumed.sessionStats.elapsedMs,
        turnCount: resumed.sessionStats.turnCount,
      },
    });
  }
  await emit({
    type: "session_ready",
    sessionId: sessionController.session.id,
    cwd: workDir,
    provider: options.provider.id,
    model: options.provider.model,
    protocolVersion: 1,
    ...(worktreePath ? { worktree: worktreePath } : {}),
  });

  // Stale-binary guard: if dist/ was rebuilt after this process loaded, warn up
  // front. A serve process never re-reads dist/, so without this it silently
  // runs the old code (gates included) until restarted.
  const startupStale = staleBinaryWarning(detectStaleBinary());
  if (startupStale) await emit({ type: "status", message: startupStale });

  const handleSigterm = () => {
    void shutdown().then(() => {
      process.exit(0);
    });
  };
  if (options.installProcessHandlers ?? true) {
    process.once("SIGTERM", handleSigterm);
  }

  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (shuttingDown) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        await emitError("Malformed JSONL input.", "malformed_json", summarizeLine(trimmed, error));
        continue;
      }
      if (!isInboundMessage(parsed)) {
        await emitError("Inbound message must be an object with a string type.", "invalid_request", summarizeUnknown(parsed));
        continue;
      }
      await handleMessage(parsed);
      if (shuttingDown) break;
    }
  } finally {
    rl.close();
    if (options.installProcessHandlers ?? true) {
      process.off("SIGTERM", handleSigterm);
    }
    await shutdown();
  }
}

function isInboundMessage(value: unknown): value is InboundMessage {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

function summarizeLine(line: string, error: unknown): string {
  const compact = line.length > 160 ? `${line.slice(0, 157)}...` : line;
  return `${error instanceof Error ? error.message : String(error)}; line=${JSON.stringify(compact)}`;
}

function summarizeUnknown(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 160 ? `${json.slice(0, 157)}...` : json;
  } catch {
    return String(value);
  }
}
