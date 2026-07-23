import type { ChildVerdict } from "../agent/verifier/types";
import type { SubAgentTaskResult } from "./types";

export type SubAgentJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SubAgentJob {
  jobId: string;
  label?: string;
  backend: "tanya" | "claude" | "codex" | "cursor";
  status: SubAgentJobStatus;
  startedAt: number;
  finishedAt?: number;
  progressLines: string[];
  result?: SubAgentTaskResult;
  error?: string;
  /** AbortController for cancelling running jobs. */
  abortController: AbortController;
  /** The child verdict once the job completes, for parent-manifest integration. */
  childVerdict?: ChildVerdict;
}

export interface JobSummary {
  jobId: string;
  label?: string;
  backend: string;
  status: SubAgentJobStatus;
  progressTail: string[];
}

export interface SubAgentManager {
  dispatch(params: SubAgentDispatchParams): Promise<{ jobId: string }>;
  status(jobId?: string): JobSummary | JobSummary[];
  result(jobId: string): SubAgentJob | undefined;
  cancel(jobId: string): boolean;
  /** All completed child verdicts for parent-manifest integration. */
  collectChildVerdicts(): ChildVerdict[];
  /** True when this manager forbids dispatching (depth guard). */
  readonly dispatchForbidden: boolean;
  readonly runningCount: number;
}

export interface SubAgentDispatchParams {
  prompt: string;
  cwd?: string;
  /** "tanya" (default) or an executor id. */
  backend?: "tanya" | "claude" | "codex" | "cursor";
  label?: string;
  /** Token budget for child run. */
  token_budget?: { max_usd?: number; max_tokens?: number };
}
