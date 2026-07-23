import type { ExecutorTask, ExecutorResult } from "./types";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const TRANSCRIPT_MAX_BYTES = 200 * 1024; // 200 KB
const KILL_GRACE_MS = 5_000;

export function executorEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base ?? process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("TANYA_")) continue;
    if (key === "ANTHROPIC_API_KEY") continue;
    if (key === "ANTHROPIC_BASE_URL") continue;
    if (key === "OPENAI_API_KEY") continue;
    if (key === "OPENAI_BASE_URL") continue;
    if (key === "CURSOR_API_KEY") continue;
    env[key] = value;
  }
  return env;
}

export function spawnWithTimeout(
  command: string,
  args: string[],
  task: ExecutorTask,
  env: NodeJS.ProcessEnv,
): Promise<{ transcript: string; exitCode: number | null; signal: NodeJS.Signals | null; finalText: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    // detached:true puts the CLI in its own process GROUP so a timeout kill
    // reaches its whole tree. External CLIs spawn tool children; killing only
    // the leader leaves grandchildren holding the stdout/stderr pipes open,
    // and the `close` event (which waits for stdio drain) then never fires.
    const child = spawn(command, args, {
      cwd: task.cwd,
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    // Kill the whole group (negative pid); fall back to the leader alone.
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };

    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    // `child.killed` is true as soon as kill() is CALLED, whether or not the
    // process died (a shell waiting on a foreground command defers SIGTERM),
    // so the escalation must key on the close event, not on `killed`.
    let closed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!closed) killTree("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

    let transcript = "";
    let finalText = "";

    const appendStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      transcript += text;
      if (transcript.length > TRANSCRIPT_MAX_BYTES) {
        transcript = transcript.slice(transcript.length - TRANSCRIPT_MAX_BYTES);
      }
    };

    const appendStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      transcript += text;
      if (transcript.length > TRANSCRIPT_MAX_BYTES) {
        transcript = transcript.slice(transcript.length - TRANSCRIPT_MAX_BYTES);
      }
    };

    const forwardProgress = (source: string) => (chunk: Buffer) => {
      if (task.onProgress) {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let display = trimmed;
          // Try to parse JSONL events into human-readable lines
          try {
            const event = JSON.parse(trimmed);
            if (event && typeof event === "object") {
              display = formatProgressEvent(source, event);
            }
          } catch {
            // Not JSON — forward as-is
          }
          task.onProgress(`[${source}] ${display}`);
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      appendStdout(chunk);
      forwardProgress("stdout")(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      appendStderr(chunk);
      // Don't forward stderr as progress by default (it's usually MCP noise)
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      if (timedOut) {
        finalText = `Executor timed out after ${timeoutMs}ms.`;
      }
      resolve({ transcript, exitCode, signal, finalText, timedOut });
    });
  });
}

function formatProgressEvent(source: string, event: Record<string, unknown>): string {
  const type = String(event.type ?? "");
  const subtype = event.subtype ? String(event.subtype) : "";

  // Claude / cursor-agent stream-json events
  if (type === "assistant") {
    const content = extractAssistantText(event);
    if (content) return content;
    return "[assistant event]";
  }
  if (type === "result") {
    const reason = event.terminal_reason ?? event.subtype ?? "completed";
    return `[result: ${reason}]`;
  }
  if (type === "system") {
    if (subtype === "hook_started" || subtype === "hook_completed") return "";
    return `[system: ${subtype || "event"}]`;
  }

  // Codex JSONL events
  if (type === "thread.started") return "[thread started]";
  if (type === "turn.started") return "[turn started]";
  if (type === "turn.completed") return "[turn completed]";
  if (type === "thread.completed") return "[thread completed]";
  if (type === "assistant_message") {
    const content = extractAssistantText(event);
    if (content) return content;
    return "[assistant message]";
  }

  // Generic
  return `[${source}: ${type}]`;
}

function extractAssistantText(event: Record<string, unknown>): string {
  // Claude format: { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.content && Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const block of message.content) {
      if (typeof block !== "object" || !block) continue;
      const blockObj = block as Record<string, unknown>;
      if (blockObj.type === "text" && typeof blockObj.text === "string") {
        parts.push(blockObj.text);
      } else if (blockObj.type === "tool_use") {
        parts.push(`[tool: ${blockObj.name ?? "unknown"}]`);
      }
    }
    return parts.join(" ").trim();
  }

  // Codex format: { type: "assistant_message", content: "..." }
  if (typeof event.content === "string") {
    return event.content.trim();
  }

  // Flat text field
  if (typeof event.text === "string") {
    return event.text.trim();
  }

  return "";
}

export function isAuthExpiredError(transcript: string, exitCode: number | null, id: string): boolean {
  const lower = transcript.toLowerCase();

  if (id === "claude") {
    return lower.includes("authentication required") || lower.includes("not logged in") || lower.includes("invalid api key");
  }

  if (id === "codex") {
    return lower.includes("not logged in") || lower.includes("authentication required") || lower.includes("please run 'codex login'");
  }

  if (id === "cursor") {
    return lower.includes("authentication required") || lower.includes("agent login") || lower.includes("cursor_api_key");
  }

  return false;
}

export function stripAuthErrorForDisplay(transcript: string, id: string): string {
  // Keep the full transcript but provide a clean error message
  if (id === "claude") return "Claude authentication expired. Run: claude login";
  if (id === "codex") return "Codex authentication expired. Run: codex login";
  if (id === "cursor") return "Cursor Agent authentication required. Run: cursor-agent login or set CURSOR_API_KEY";
  return "Authentication expired.";
}
