import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExternalExecutor, ExecutorTask, ExecutorResult } from "./types";
import { executorEnv, spawnWithTimeout, isAuthExpiredError } from "./executorUtils";

const execFileAsync = promisify(execFile);

const BINARY = "cursor-agent";

export const cursorExecutor: ExternalExecutor = {
  id: "cursor" as const,
  binary: BINARY,

  async available(): Promise<boolean> {
    try {
      // Check binary exists by running --version
      await execFileAsync(BINARY, ["--version"], {
        env: executorEnv(),
        timeout: 10_000,
      });
      return true;
    } catch {
      return false;
    }
  },

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    const env = executorEnv();

    // cursor-agent -p requires CURSOR_API_KEY. The doctrine strips it,
    // so if it's not available, the run will fail with auth error.
    const args = [
      "-p", task.prompt,
      "--output-format", "stream-json",
      "--trust",
    ];

    const { transcript, exitCode, signal, finalText, timedOut } = await spawnWithTimeout(
      BINARY,
      args,
      task,
      env,
    );

    // cursor-agent returns exit 0 even on auth errors, so we must check the transcript
    const authExpired = isAuthExpiredError(transcript, exitCode, "cursor");
    // A trapped-SIGTERM CLI can exit 0 on a timeout kill — a timed-out run is
    // never ok, whatever the exit code says.
    const ok = !authExpired && !timedOut && exitCode === 0 && signal === null;

    return {
      ok,
      exitCode,
      transcript,
      finalText: finalText || extractCursorFinalText(transcript),
      ...(authExpired ? { authExpired: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    };
  },
};

function extractCursorFinalText(transcript: string): string {
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!);
      if (event && typeof event === "object" && event.type === "result") {
        const reason = event.terminal_reason ?? "completed";
        return `Cursor Agent finished: ${reason}`;
      }
    } catch {
      // Not JSON
    }
  }
  return "";
}
