import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExternalExecutor, ExecutorTask, ExecutorResult } from "./types";
import { executorEnv, spawnWithTimeout, isAuthExpiredError } from "./executorUtils";

const execFileAsync = promisify(execFile);

const BINARY = "codex";

export const codexExecutor: ExternalExecutor = {
  id: "codex" as const,
  binary: BINARY,

  async available(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(BINARY, ["login", "status"], {
        env: executorEnv(),
        timeout: 10_000,
      });
      return stdout.toLowerCase().includes("logged in");
    } catch {
      return false;
    }
  },

  async run(task: ExecutorTask): Promise<ExecutorResult> {
    const env = executorEnv();

    const args = [
      "exec", task.prompt,
      "--json",
      "--sandbox", "workspace-write",
    ];

    const { transcript, exitCode, signal, finalText, timedOut } = await spawnWithTimeout(
      BINARY,
      args,
      task,
      env,
    );

    const authExpired = isAuthExpiredError(transcript, exitCode, "codex");
    // A trapped-SIGTERM CLI can exit 0 on a timeout kill — a timed-out run is
    // never ok, whatever the exit code says.
    const ok = !authExpired && !timedOut && exitCode === 0 && signal === null;

    return {
      ok,
      exitCode,
      transcript,
      finalText: finalText || extractCodexFinalText(transcript),
      ...(authExpired ? { authExpired: true } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    };
  },
};

function extractCodexFinalText(transcript: string): string {
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]!);
      if (event && typeof event === "object") {
        if (event.type === "thread.completed") return "Codex finished: thread completed";
        if (event.type === "turn.completed") return "Codex finished: turn completed";
      }
    } catch {
      // Not JSON
    }
  }
  return "";
}
