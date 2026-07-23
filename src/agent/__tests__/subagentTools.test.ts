import { describe, expect, it } from "vitest";
import { SubAgentJobManager } from "../../tools/subagentJobManager";
import type { SubAgentTaskRequest, SubAgentTaskResult } from "../../tools/types";
import type { SubAgentJob } from "../../tools/subagentTypes";

// ── stub helpers ──────────────────────────────────────────────────────────

function stubResult(overrides: Partial<SubAgentTaskResult> = {}): SubAgentTaskResult {
  return {
    ok: true,
    subRunId: `r-${Math.random().toString(36).slice(2, 10)}`,
    verdict: "passed",
    blockers: [],
    changedFiles: [],
    summary: "done",
    tokensUsed: { in: 100, out: 50 },
    childRunIds: [],
    manifest: {
      schemaVersion: 1,
      changedFiles: [],
      uncommittedFiles: [],
      artifactsRead: [],
      artifactsCreated: [],
      contextFilesRead: [],
      verification: [],
      git: { root: "/tmp/repo", head: "abc1234" },
      toolErrors: 0,
      blockers: [],
    },
    runResult: {
      message: "ok",
      manifest: {} as any,
    },
    treatFailureAs: "blocker",
    ...overrides,
  };
}

function stubFailResult(blockers: string[]): SubAgentTaskResult {
  return stubResult({
    ok: false,
    verdict: "failed",
    blockers,
    summary: blockers.join("; "),
    treatFailureAs: "blocker",
  });
}

function makeRunSubAgent(result: SubAgentTaskResult) {
  return async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
    return result;
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("SubAgentJobManager", () => {
  it("dispatch returns a jobId immediately", async () => {
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(stubResult()) });
    const { jobId } = await mgr.dispatch({ prompt: "do work" });
    expect(jobId).toMatch(/^sj-/);
  });

  it("dispatch → status(running) → result roundtrip (passed)", async () => {
    let resolveRunner!: () => void;
    const controllableRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { resolveRunner = r; });
      return stubResult({ subRunId: "r-abc", changedFiles: ["ok.txt"] });
    };
    const mgr = new SubAgentJobManager({ runSubAgent: controllableRunner });

    const { jobId } = await mgr.dispatch({ prompt: "create ok.txt", label: "writer" });

    // Wait for the runner to start, then its status is "running"
    await new Promise((r) => setTimeout(r, 10));
    const status = mgr.status(jobId) as { status: string };
    expect(status.status).toBe("running");

    // Release the runner and wait for completion
    resolveRunner();
    await new Promise((r) => setTimeout(r, 50));

    const job = mgr.result(jobId)!;
    expect(job.status).toBe("completed");
    expect(job.result!.ok).toBe(true);
    expect(job.result!.subRunId).toBe("r-abc");
    expect(job.result!.changedFiles).toContain("ok.txt");
  });

  it("dispatch → result roundtrip (failed)", async () => {
    const result = stubFailResult(["compile error"]);
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(result) });

    const { jobId } = await mgr.dispatch({ prompt: "break it", label: "breaker" });

    await new Promise((r) => setTimeout(r, 100));

    const job = mgr.result(jobId)!;
    expect(job.status).toBe("failed");
    expect(job.result!.ok).toBe(false);
    expect(job.result!.blockers).toContain("compile error");
  });

  it("status() without jobId returns all jobs summary", async () => {
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(stubResult()) });

    await mgr.dispatch({ prompt: "a" });
    await mgr.dispatch({ prompt: "b" });

    await new Promise((r) => setTimeout(r, 100));

    const summaries = mgr.status() as Array<{ jobId: string }>;
    expect(summaries.length).toBe(2);
  });

  it("collectChildVerdicts surfaces completed children", async () => {
    const result = stubResult({ subRunId: "r-ok" });
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(result) });

    await mgr.dispatch({ prompt: "do work", label: "worker" });

    await new Promise((r) => setTimeout(r, 100));

    const verdicts = mgr.collectChildVerdicts();
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]!.subRunId).toBe("r-ok");
    expect(verdicts[0]!.verdict).toBe("passed");
  });

  it("collectChildVerdicts surfaces failed child as blocker", async () => {
    const result = stubFailResult(["missing file"]);
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(result) });

    await mgr.dispatch({ prompt: "fail" });

    await new Promise((r) => setTimeout(r, 100));

    const verdicts = mgr.collectChildVerdicts();
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]!.verdict).toBe("failed");
    expect(verdicts[0]!.blockers).toContain("missing file");
    expect(verdicts[0]!.treatFailureAs).toBe("blocker");
  });

  it("cancel aborts a queued job", async () => {
    // Block the semaphore by dispatching 3 jobs with a slow runner
    let firstResolve!: () => void;
    const slowRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { firstResolve = r; });
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: slowRunner, maxConcurrency: 1 });

    // Dispatch one that blocks the semaphore
    const { jobId: slowJobId } = await mgr.dispatch({ prompt: "slow" });

    // Dispatch a second that will be queued
    const { jobId: queuedId } = await mgr.dispatch({ prompt: "queued" });

    // The second job should be queued
    const queuedStatus = mgr.status(queuedId) as { status: string };
    expect(queuedStatus.status).toBe("queued");

    // Cancel the queued job
    const cancelled = mgr.cancel(queuedId);
    expect(cancelled).toBe(true);

    const afterCancel = mgr.status(queuedId) as { status: string };
    expect(afterCancel.status).toBe("cancelled");

    // Cancel cannot re-cancel
    const reCancel = mgr.cancel(queuedId);
    expect(reCancel).toBe(false);

    // Release the slow job
    firstResolve();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("cancel on a running job aborts it", async () => {
    let started = false;
    let abortChecked = false;
    const controllableRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      started = true;
      // Simulate work that checks abort signal
      await new Promise((r) => setTimeout(r, 100));
      abortChecked = true;
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: controllableRunner, maxConcurrency: 1 });

    const { jobId } = await mgr.dispatch({ prompt: "runnable" });

    // Wait for it to start
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);

    // Cancel the running job (sets status to cancelled, aborts controller)
    const cancelled = mgr.cancel(jobId);
    expect(cancelled).toBe(true);

    // Status reflects cancelled
    const jobStatus = mgr.status(jobId) as { status: string };
    expect(jobStatus.status).toBe("cancelled");
  });

  it("dispatchForbidden blocks dispatch", async () => {
    const mgr = new SubAgentJobManager({
      runSubAgent: makeRunSubAgent(stubResult()),
      dispatchForbidden: true,
    });

    await expect(mgr.dispatch({ prompt: "nested" })).rejects.toThrow(
      "Subagent dispatch is forbidden at this depth",
    );
  });

  it("concurrency queueing: excess jobs are queued", async () => {
    let running = 0;
    let maxRunning = 0;
    const resolves: Array<() => void> = [];

    const slowRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise<void>((r) => { resolves.push(r); });
      running -= 1;
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: slowRunner, maxConcurrency: 2 });

    // Dispatch 4 jobs with concurrency cap of 2
    const p1 = mgr.dispatch({ prompt: "1" });
    const p2 = mgr.dispatch({ prompt: "2" });
    const p3 = mgr.dispatch({ prompt: "3" });
    const p4 = mgr.dispatch({ prompt: "4" });

    await Promise.all([p1, p2, p3, p4]);

    // At no point should more than 2 be running
    expect(maxRunning).toBeLessThanOrEqual(2);

    // Release resolves in a loop — dequeued jobs push new resolves
    for (let i = 0; i < 4; i++) {
      // Wait for the next resolve to appear (or timeout)
      await new Promise((r) => setTimeout(r, 10));
      while (resolves.length > 0) {
        resolves.shift()!();
      }
    }

    // All jobs completed
    await new Promise((resolve) => setTimeout(resolve, 50));
    const summaries = mgr.status() as Array<{ status: string }>;
    expect(summaries.length).toBe(4);
    for (const s of summaries) {
      expect(s.status).toBe("completed");
    }
  });

  it("external backend dispatches via runExternalBackend", async () => {
    let called = false;
    let receivedParams: any = null;
    const externalFn = async (
      backend: "claude" | "codex" | "cursor",
      params: { prompt: string; cwd: string; label?: string; signal?: AbortSignal; onProgress?: (line: string) => void },
    ): Promise<SubAgentTaskResult> => {
      called = true;
      receivedParams = { backend, ...params };
      return stubResult({ subRunId: "r-ext-1" });
    };

    const mgr = new SubAgentJobManager({
      runSubAgent: makeRunSubAgent(stubResult()),
      runExternalBackend: externalFn,
    });

    const { jobId } = await mgr.dispatch({
      prompt: "ext work",
      backend: "claude",
      label: "ext-worker",
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(called).toBe(true);
    expect(receivedParams.backend).toBe("claude");
    expect(receivedParams.prompt).toBe("ext work");
    expect(receivedParams.label).toBe("ext-worker");

    const job = mgr.result(jobId)!;
    expect(job.status).toBe("completed");
    expect(job.backend).toBe("claude");
  });

  it("external backend unavailable returns failed job", async () => {
    const mgr = new SubAgentJobManager({
      runSubAgent: makeRunSubAgent(stubResult()),
      // No runExternalBackend provided
    });

    const { jobId } = await mgr.dispatch({
      prompt: "ext work",
      backend: "codex",
    });

    await new Promise((r) => setTimeout(r, 100));

    const job = mgr.result(jobId)!;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("not available");

    const verdicts = mgr.collectChildVerdicts();
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]!.verdict).toBe("failed");
  });

  it("runningCount reflects active jobs", async () => {
    const resolves: Array<() => void> = [];
    const slowRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { resolves.push(r); });
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: slowRunner, maxConcurrency: 3 });

    await mgr.dispatch({ prompt: "a" });
    await mgr.dispatch({ prompt: "b" });

    // Allow time for both to start
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.runningCount).toBe(2);

    // Release
    for (const r of resolves) r();
    await new Promise((r) => setTimeout(r, 100));
    expect(mgr.runningCount).toBe(0);
  });

  it("label is preserved on the job", async () => {
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(stubResult()) });

    const { jobId } = await mgr.dispatch({ prompt: "tagged", label: "my-label" });

    await new Promise((r) => setTimeout(r, 100));

    const job = mgr.result(jobId)!;
    // job.label is preserved via SubAgentJob
    const rawJob = (mgr as any).jobs.get(jobId) as SubAgentJob;
    expect(rawJob.label).toBe("my-label");
  });

  it("collectChildVerdicts is empty when no children dispatched", () => {
    const mgr = new SubAgentJobManager({ runSubAgent: makeRunSubAgent(stubResult()) });
    expect(mgr.collectChildVerdicts()).toEqual([]);
  });

  // ── Task 03c regression tests ─────────────────────────────────────────

  it("cancel-resurrect: cancelled running job stays cancelled after child resolves", async () => {
    let resolveChild!: () => void;
    const controllableRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { resolveChild = r; });
      return stubResult({ subRunId: "r-resurrect", changedFiles: ["unwanted.txt"] });
    };

    const mgr = new SubAgentJobManager({ runSubAgent: controllableRunner, maxConcurrency: 1 });
    const { jobId } = await mgr.dispatch({ prompt: "will be cancelled" });

    // Wait for the runner to start.
    await new Promise((r) => setTimeout(r, 20));
    const runningStatus = mgr.status(jobId) as { status: string };
    expect(runningStatus.status).toBe("running");

    // Cancel.
    mgr.cancel(jobId);
    const cancelledStatus = mgr.status(jobId) as { status: string };
    expect(cancelledStatus.status).toBe("cancelled");

    // Now let the child resolve.
    resolveChild();
    await new Promise((r) => setTimeout(r, 50));

    // Status must remain cancelled — NOT completed or failed.
    const finalJob = ((mgr as any).jobs.get(jobId) as SubAgentJob);
    expect(finalJob.status).toBe("cancelled");
    // No childVerdict attached to the resurrected job.
    expect(finalJob.childVerdict).toBeUndefined();
    // collectChildVerdicts must not surface the cancelled job.
    expect(mgr.collectChildVerdicts()).toEqual([]);
  });

  it("cancel-queued regression: cancelled queued job never invokes runner", async () => {
    let firstStarted = false;
    let firstResolve!: () => void;
    const slowRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      firstStarted = true;
      await new Promise<void>((r) => { firstResolve = r; });
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: slowRunner, maxConcurrency: 1 });
    // Fill the single slot.
    await mgr.dispatch({ prompt: "blocker" });
    await new Promise((r) => setTimeout(r, 20));
    expect(firstStarted).toBe(true);

    // Queue a second job — use a separate manager with its own blocking
    // runner so "queued-target" genuinely sits in the queue.
    let queuedInvoked = false;
    let mgr2Blocker!: () => void;
    const mgr2SlowRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { mgr2Blocker = r; });
      queuedInvoked = true;
      return stubResult();
    };
    const mgr2 = new SubAgentJobManager({ runSubAgent: mgr2SlowRunner, maxConcurrency: 1 });
    await mgr2.dispatch({ prompt: "blocker2" });
    await new Promise((r) => setTimeout(r, 20));
    const { jobId: queuedId } = await mgr2.dispatch({ prompt: "queued-target" });

    const queuedStatus = mgr2.status(queuedId) as { status: string };
    expect(queuedStatus.status).toBe("queued");

    // Cancel the queued job.
    mgr2.cancel(queuedId);

    // Release the blocker.
    // Since the queued job was cancelled, its runner should NOT fire,
    // but the blocker finish will dequeue next.
    // Actually, the cancelled check happens inside the runner closure,
    // so we need to verify the runner doesn't overwrite the slot.
    // Release both managers.
    firstResolve();
    mgr2Blocker();
    // Wait for dequeue to process.
    await new Promise((r) => setTimeout(r, 50));

    // The queued job should still be cancelled.
    const finalStatus = mgr2.status(queuedId) as { status: string };
    expect(finalStatus.status).toBe("cancelled");
  });

  it("cancel-queued single manager: cancelled queued job skipped when slot frees", async () => {
    let blockerResolve!: () => void;
    const blockerRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { blockerResolve = r; });
      return stubResult();
    };

    let queuedInvoked = false;
    const trackedRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      queuedInvoked = true;
      return stubResult({ subRunId: "r-should-not-run" });
    };

    const mgr = new SubAgentJobManager({
      runSubAgent: async (req) => {
        // Route the blocker to the slow path and the queued to the tracked path.
        if (req.prompt === "blocker") return blockerRunner(req);
        return trackedRunner(req);
      },
      maxConcurrency: 1,
    });

    await mgr.dispatch({ prompt: "blocker" });
    await new Promise((r) => setTimeout(r, 20));

    const { jobId: queuedId } = await mgr.dispatch({ prompt: "queued" });
    expect((mgr.status(queuedId) as any).status).toBe("queued");

    // Cancel the queued job.
    mgr.cancel(queuedId);

    // Release the blocker.
    blockerResolve();
    await new Promise((r) => setTimeout(r, 100));

    // The queued runner must NOT have been invoked.
    expect(queuedInvoked).toBe(false);
    // Status must remain cancelled.
    expect((mgr.status(queuedId) as any).status).toBe("cancelled");
  });

  it("signal delivery: cancelled tanya-backend stub receives aborted signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    let childStarted = false;
    let childResolve!: () => void;

    const signalTrackingRunner = async (req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      childStarted = true;
      receivedSignal = req.signal;
      await new Promise<void>((r) => { childResolve = r; });
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: signalTrackingRunner, maxConcurrency: 1 });
    const { jobId } = await mgr.dispatch({ prompt: "signal-test" });

    await new Promise((r) => setTimeout(r, 20));
    expect(childStarted).toBe(true);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    // Cancel the job.
    mgr.cancel(jobId);
    // The abortController has been aborted — the signal must reflect that.
    expect(receivedSignal!.aborted).toBe(true);

    // Release the child; status stays cancelled.
    childResolve();
    await new Promise((r) => setTimeout(r, 50));
    expect((mgr.status(jobId) as any).status).toBe("cancelled");
    expect(mgr.collectChildVerdicts()).toEqual([]);
  });

  it("budget: dispatch with token_budget produces token_budget on request", async () => {
    let receivedRequest: SubAgentTaskRequest | undefined;
    const trackingRunner = async (req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      receivedRequest = req;
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: trackingRunner });
    await mgr.dispatch({
      prompt: "budgeted",
      token_budget: { max_tokens: 8000, max_usd: 0.50 },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedRequest).toBeDefined();
    expect(receivedRequest!.token_budget).toEqual({ max_tokens: 8000, max_usd: 0.50 });
  });

  it("progress tail: subagent_status returns non-empty tail after progress", async () => {
    let childResolve!: () => void;
    const slowRunner = async (_req: SubAgentTaskRequest): Promise<SubAgentTaskResult> => {
      await new Promise<void>((r) => { childResolve = r; });
      return stubResult();
    };

    const mgr = new SubAgentJobManager({ runSubAgent: slowRunner });
    const { jobId } = await mgr.dispatch({ prompt: "progress-test" });

    await new Promise((r) => setTimeout(r, 20));

    // Status should have a progress tail (the synthetic progress line from runTanyaBackend).
    const summary = mgr.status(jobId) as { status: string; progressTail: string[] };
    expect(summary.progressTail).toBeDefined();
    expect(summary.progressTail.length).toBeGreaterThanOrEqual(1);
    expect(summary.progressTail[0]).toContain("tanya:");

    childResolve();
    await new Promise((r) => setTimeout(r, 50));
  });
});
