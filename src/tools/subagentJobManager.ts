import { randomUUID } from "node:crypto";
import type { SubAgentTaskRequest, SubAgentTaskResult } from "./types";
import type { SubAgentDispatchParams, SubAgentJob, SubAgentManager, JobSummary } from "./subagentTypes";
import type { ChildVerdict } from "../agent/verifier/types";
import type { EventSink } from "../events/types";

export interface SubAgentJobManagerOptions {
  /** Callback for tanya-backend dispatch. */
  runSubAgent: (request: SubAgentTaskRequest) => Promise<SubAgentTaskResult>;
  /** Callback for external-backend dispatch (claude/codex/cursor). */
  runExternalBackend?: (
    backend: "claude" | "codex" | "cursor",
    params: {
      prompt: string;
      cwd: string;
      label?: string;
      signal?: AbortSignal;
      onProgress?: (line: string) => void;
    },
  ) => Promise<SubAgentTaskResult>;
  /** Max concurrent jobs. Default 3. */
  maxConcurrency?: number;
  /** When true, dispatch is forbidden (subagent depth guard). */
  dispatchForbidden?: boolean;
  /** Optional event sink for emitting subagent lifecycle events. */
  sink?: EventSink;
}

export class SubAgentJobManager implements SubAgentManager {
  private readonly jobs = new Map<string, SubAgentJob>();
  private readonly runSubAgent: (request: SubAgentTaskRequest) => Promise<SubAgentTaskResult>;
  private readonly runExternalBackend?: SubAgentJobManagerOptions["runExternalBackend"];
  private readonly maxConcurrency: number;
  private readonly semaphore: { running: number; queue: Array<() => void> } = {
    running: 0,
    queue: [],
  };
  readonly dispatchForbidden: boolean;
  private readonly sink?: EventSink | undefined;

  constructor(options: SubAgentJobManagerOptions) {
    this.runSubAgent = options.runSubAgent;
    this.runExternalBackend = options.runExternalBackend;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    this.dispatchForbidden = options.dispatchForbidden ?? false;
    this.sink = options.sink;
  }

  get runningCount(): number {
    return this.semaphore.running;
  }

  async dispatch(params: SubAgentDispatchParams): Promise<{ jobId: string }> {
    if (this.dispatchForbidden) {
      throw new Error("Subagent dispatch is forbidden at this depth.");
    }

    const jobId = `sj-${randomUUID().slice(0, 8)}`;
    const backend = params.backend ?? "tanya";
    const job: SubAgentJob = {
      jobId,
      ...(params.label ? { label: params.label } : {}),
      backend,
      status: "queued",
      startedAt: Date.now(),
      progressLines: [],
      abortController: new AbortController(),
    };
    this.jobs.set(jobId, job);

    // Emit dispatched event so the UI can create the card immediately.
    this.emitSubAgentEvent(job);

    // Enqueue: acquire semaphore slot then run.
    this.enqueue(jobId, job, params);

    return { jobId };
  }

  status(jobId?: string): JobSummary | JobSummary[] {
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`No subagent job found: ${jobId}`);
      return jobToSummary(job);
    }
    return [...this.jobs.values()].map(jobToSummary);
  }

  result(jobId: string): SubAgentJob | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (job.status === "queued" || job.status === "running") {
      throw new Error(`Job ${jobId} is still ${job.status}.`);
    }
    return job;
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      return false;
    }
    job.abortController.abort();
    job.status = "cancelled";
    job.finishedAt = Date.now();
    this.emitSubAgentEvent(job);
    return true;
  }

  collectChildVerdicts(): ChildVerdict[] {
    const verdicts: ChildVerdict[] = [];
    for (const job of this.jobs.values()) {
      if (job.childVerdict) {
        verdicts.push(job.childVerdict);
      }
    }
    return verdicts;
  }

  private emitSubAgentEvent(job: SubAgentJob): void {
    if (!this.sink) return;
    const tail = job.progressLines.slice(-1);
    this.sink({
      type: "subagent",
      jobId: job.jobId,
      status: job.status,
      ...(job.label !== undefined ? { label: job.label } : {}),
      ...(job.backend ? { backend: job.backend } : {}),
      ...(tail.length > 0 ? { progressLine: tail[0] } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.childVerdict ? {
        subRunId: job.childVerdict.subRunId,
        verdict: job.childVerdict.verdict,
        blockers: job.childVerdict.blockers,
      } : {}),
    });
  }

  private enqueue(jobId: string, job: SubAgentJob, params: SubAgentDispatchParams): void {
    const runner = async () => {
      // If the job was cancelled while queued, release the slot and skip.
      if (job.status === "cancelled") {
        this.semaphore.running -= 1;
        this.dequeueNext();
        return;
      }
      try {
        job.status = "running";
        this.emitSubAgentEvent(job);
        if (job.backend === "tanya") {
          await this.runTanyaBackend(job, params);
        } else if (this.runExternalBackend) {
          await this.runExternal(job, params);
        } else {
          job.status = "failed";
          job.error = `External backend "${job.backend}" is not available.`;
          job.finishedAt = Date.now();
          job.childVerdict = {
            subRunId: job.jobId,
            verdict: "failed",
            blockers: [`External backend "${job.backend}" is not available.`],
            summary: job.error!,
            changedFiles: [],
            treatFailureAs: "blocker",
            ...(job.label !== undefined ? { label: job.label } : {}),
            ...(job.backend ? { backend: job.backend } : {}),
          };
        }
      } catch (err: unknown) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = Date.now();
        job.childVerdict = {
          subRunId: job.jobId,
          verdict: "failed",
          blockers: [job.error!],
          summary: job.error!,
          changedFiles: [],
          treatFailureAs: "blocker",
          ...(job.label !== undefined ? { label: job.label } : {}),
          ...(job.backend ? { backend: job.backend } : {}),
        };
      } finally {
        this.semaphore.running -= 1;
        this.dequeueNext();
      }
    };

    if (this.semaphore.running < this.maxConcurrency) {
      this.semaphore.running += 1;
      runner();
    } else {
      this.semaphore.queue.push(runner);
    }
  }

  private dequeueNext(): void {
    const next = this.semaphore.queue.shift();
    if (next) {
      this.semaphore.running += 1;
      next();
    }
  }

  private async runTanyaBackend(job: SubAgentJob, params: SubAgentDispatchParams): Promise<void> {
    const request: SubAgentTaskRequest = {
      prompt: params.prompt,
      ...(params.cwd ? { workspace: params.cwd } : {}),
      signal: job.abortController.signal,
      ...(params.token_budget ? { token_budget: params.token_budget } : {}),
    };
    pushProgress(job, "tanya: dispatching child agent...");
    const result = await this.runSubAgent(request);
    // Do not overwrite if the job was cancelled while the child ran.
    if (job.status === "cancelled") return;
    pushProgress(job, `tanya: child ${result.subRunId} verdict=${result.verdict}`);
    job.status = result.ok ? "completed" : "failed";
    job.result = result;
    job.finishedAt = Date.now();
    job.childVerdict = {
      subRunId: result.subRunId,
      verdict: result.verdict,
      blockers: result.blockers,
      summary: result.summary,
      changedFiles: result.changedFiles,
      treatFailureAs: result.treatFailureAs,
      ...(job.label !== undefined ? { label: job.label } : {}),
      ...(job.backend ? { backend: job.backend } : {}),
    };
    this.emitSubAgentEvent(job);
  }

  private async runExternal(job: SubAgentJob, params: SubAgentDispatchParams): Promise<void> {
    pushProgress(job, `${job.backend}: dispatching...`);
    const result = await this.runExternalBackend!(
      job.backend as "claude" | "codex" | "cursor",
      {
        prompt: params.prompt,
        cwd: params.cwd ?? process.cwd(),
        ...(params.label ? { label: params.label } : {}),
        signal: job.abortController.signal,
        onProgress: (line: string) => pushProgress(job, line),
      },
    );
    // Do not overwrite if the job was cancelled while the child ran.
    if (job.status === "cancelled") return;
    pushProgress(job, `${job.backend}: verdict=${result.verdict}`);
    job.status = result.ok ? "completed" : "failed";
    job.result = result;
    job.finishedAt = Date.now();
    job.childVerdict = {
      subRunId: result.subRunId,
      verdict: result.verdict,
      blockers: result.blockers,
      summary: result.summary,
      changedFiles: result.changedFiles,
      treatFailureAs: result.treatFailureAs,
      ...(job.label !== undefined ? { label: job.label } : {}),
      ...(job.backend ? { backend: job.backend } : {}),
    };
  }
}

const PROGRESS_CAP = 100;

function pushProgress(job: SubAgentJob, line: string): void {
  if (job.progressLines.length >= PROGRESS_CAP) {
    job.progressLines.shift();
  }
  job.progressLines.push(line);
}

function jobToSummary(job: SubAgentJob): JobSummary {
  const tail = job.progressLines.slice(-5);
  return {
    jobId: job.jobId,
    ...(job.label ? { label: job.label } : {}),
    backend: job.backend,
    status: job.status,
    progressTail: tail,
  };
}
