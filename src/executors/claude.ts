import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExternalExecutor, ExecutorTask, ExecutorResult } from "./types";
import { executorEnv, spawnWithTimeout, isAuthExpiredError } from "./executorUtils";

const execFileAsync = promisify(execFile);

const BINARY = "claude";

export const claudeExecutor: ExternalExecutor = {
  id: "claude" as const,
  binary: BINARY,

  async available(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(BINARY, ["auth", "status"], {
        env: executorEnv(),
        timeout: 10_000,
      });
      const status = JSON.parse(stdout) as { loggedIn?: boolean };
      return status.loggedIn === true;
    } catch {
      return false;
    }
  },

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    const env = executorEnv();

    const args = [
      "-p", task.prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "acceptEdits",
    ];

    const { transcript, exitCode, signal, finalText, timedOut } = await spawnWithTimeout(
      BINARY,
      args,
      task,
      env,
    );

    const authExpired = isAuthExpiredError(transcript, exitCode, "claude");
    // A trapped-SIGTERM CLI can exit 0 on a timeout kill — a timed-out run is
    // never ok, whatever the exit code says.
    const ok = !authExpired && !timedOut && exitCode === 0 && signal === null;

    return {
      ok,
      exitCode,
      transcript,
      finalText: finalText || extractClaudeFinalText(transcript),
      ...(authExpired ? { authExpired: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    };
  },
};

function extractClaudeFinalText(transcript: string): string {
  // Look for the "result" event which contains terminal info
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!);
      if (event && typeof event === "object" && event.type === "result") {
        const reason = event.terminal_reason ?? "completed";
        return `Claude finished: ${reason}`;
      }
    } catch {
      // Not JSON
    }
  }
  return "";
}
