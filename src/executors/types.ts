import type { ChildProcess } from "node:child_process";

export type ExecutorId = "claude" | "codex" | "cursor";

export type ExecutorTask = {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  onProgress?: (line: string) => void;
};

export type ExecutorResult = {
  ok: boolean;
  exitCode: number | null;
  transcript: string;
  finalText: string;
  authExpired?: boolean;
  timedOut?: boolean;
};

export interface ExternalExecutor {
  readonly id: ExecutorId;
  readonly binary: string;
  available(): Promise<boolean>;
  run(task: ExecutorTask): Promise<ExecutorResult>;
}

export type SpawnResult = {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};
