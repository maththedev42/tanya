import type { TanyaTool, ToolContext, ToolResult } from "./types";
import type { SubAgentManager } from "./subagentTypes";
import { decide } from "../safety/permissions/engine";
import { runIdDepth } from "../agent/subAgentContext";
import { envValue } from "../config/envCompat";

// ── Helpers ──────────────────────────────────────────────────────────

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function subagentDepthLimit(): number {
  const raw = envValue(process.env, "TANYA_SUBAGENT_DEPTH").trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
}

function getManager(context: ToolContext): SubAgentManager {
  if (!context.subAgentManager) {
    throw new Error("Subagent manager is not available in this context.");
  }
  return context.subAgentManager;
}

// ── dispatch_subagent ────────────────────────────────────────────────

export const dispatchSubagentTool: TanyaTool = {
  name: "dispatch_subagent",
  description:
    "Dispatch an async subagent worker (tanya or external CLI). Returns a jobId immediately.",
  definition: {
    type: "function",
    function: {
      name: "dispatch_subagent",
      description:
        "Spawn an async subagent worker that runs in parallel. Returns immediately with a jobId. " +
        "Use subagent_status to check progress and subagent_result to collect the final verdict.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Task prompt for the worker. Write it as a real task spec with numbered deliverables (## Part N) and a ## Verify section with runnable commands.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory for the worker. Defaults to the parent workspace.",
          },
          backend: {
            type: "string",
            enum: ["tanya", "claude", "codex", "cursor"],
            description: 'Backend to run. "tanya" (default) spawns a child Tanya agent. Others use external CLI executors.',
          },
          label: {
            type: "string",
            description: "Optional human label for the job.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
  },
  async canRun(_input, context) {
    if (runIdDepth(context.runId ?? "") >= subagentDepthLimit()) {
      return {
        decision: "deny",
        reason: "subagent-depth-limit",
        matchedRule: "dispatch_subagent:<depth>",
      };
    }
    return decide("dispatch_subagent", _input, context);
  },
  async run(input, context) {
    const record = asRecord(input);
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) {
      return { ok: false, summary: "Missing required field: prompt", error: "prompt is required" };
    }

    try {
      const manager = getManager(context);
      const cwd = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd.trim() : undefined;
      const backend = isValidBackend(record.backend) ? record.backend : undefined;
      const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
      const result = await manager.dispatch({
        prompt,
        ...(cwd ? { cwd } : {}),
        ...(backend ? { backend } : {}),
        ...(label ? { label } : {}),
      });
      return {
        ok: true,
        summary: `Subagent dispatched: ${result.jobId}`,
        output: result,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: msg, error: msg };
    }
  },
};

// ── subagent_status ──────────────────────────────────────────────────

export const subagentStatusTool: TanyaTool = {
  name: "subagent_status",
  description:
    "Check the status of one subagent job (or all jobs when no jobId is given).",
  definition: {
    type: "function",
    function: {
      name: "subagent_status",
      description:
        "Get status and a progress tail for one subagent job by jobId, or a summary of all jobs when jobId is omitted.",
      parameters: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "Optional job id. When omitted, returns a summary of all jobs.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  async canRun(input, context) {
    return decide("subagent_status", input, context);
  },
  async run(input, context) {
    const record = asRecord(input);
    const jobId = typeof record.jobId === "string" && record.jobId.trim()
      ? record.jobId.trim()
      : undefined;

    try {
      const manager = getManager(context);
      const status = manager.status(jobId);
      const isSingle = !!jobId;
      return {
        ok: true,
        summary: isSingle
          ? `Job ${jobId}: ${(status as { status: string }).status}`
          : `${(status as Array<{ status: string }>).length} jobs`,
        output: status,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: msg, error: msg };
    }
  },
};

// ── subagent_result ──────────────────────────────────────────────────

export const subagentResultTool: TanyaTool = {
  name: "subagent_result",
  description:
    "Collect the final result and manifest from a completed subagent job. Errors if the job is still running.",
  keepFullForVerifier: true,
  definition: {
    type: "function",
    function: {
      name: "subagent_result",
      description:
        "Get the final result (message + manifest with verdict, blockers, changedFiles) for a completed subagent job.",
      parameters: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "The job id returned by dispatch_subagent.",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  },
  async canRun(input, context) {
    return decide("subagent_result", input, context);
  },
  async run(input, context) {
    const record = asRecord(input);
    const jobId = typeof record.jobId === "string" && record.jobId.trim()
      ? record.jobId.trim()
      : "";

    if (!jobId) {
      return { ok: false, summary: "Missing required field: jobId", error: "jobId is required" };
    }

    try {
      const manager = getManager(context);
      const job = manager.result(jobId);
      if (!job) {
        return { ok: false, summary: `No job found: ${jobId}`, error: `No job found: ${jobId}` };
      }

      const result = job.result;
      if (!result) {
        return {
          ok: false,
          summary: `Job ${jobId} has no result (status: ${job.status}).`,
          error: `Job ${jobId} status is ${job.status}.`,
        };
      }

      return {
        ok: result.ok,
        summary: result.ok
          ? `Subagent ${jobId} passed.`
          : `Subagent ${jobId} failed: ${result.blockers.join("; ")}`,
        output: {
          ok: result.ok,
          subRunId: result.subRunId,
          verdict: result.verdict,
          blockers: result.blockers,
          changedFiles: result.changedFiles,
          summary: result.summary,
          tokensUsed: result.tokensUsed,
          childRunIds: result.childRunIds,
          treatFailureAs: result.treatFailureAs,
          ...(result.cancelled ? { cancelled: result.cancelled, reason: result.reason } : {}),
        },
        files: result.changedFiles,
        ...(result.ok ? {} : { error: result.blockers.join("; ") }),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: msg, error: msg };
    }
  },
};

// ── subagent_cancel ──────────────────────────────────────────────────

export const subagentCancelTool: TanyaTool = {
  name: "subagent_cancel",
  description: "Cancel a running or queued subagent job.",
  definition: {
    type: "function",
    function: {
      name: "subagent_cancel",
      description:
        "Cancel a subagent job by jobId. Works for queued and running jobs; has no effect on already-finished jobs.",
      parameters: {
        type: "object",
        properties: {
          jobId: {
            type: "string",
            description: "The job id returned by dispatch_subagent.",
          },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  },
  async canRun(input, context) {
    return decide("subagent_cancel", input, context);
  },
  async run(input, context) {
    const record = asRecord(input);
    const jobId = typeof record.jobId === "string" && record.jobId.trim()
      ? record.jobId.trim()
      : "";

    if (!jobId) {
      return { ok: false, summary: "Missing required field: jobId", error: "jobId is required" };
    }

    try {
      const manager = getManager(context);
      const cancelled = manager.cancel(jobId);
      return {
        ok: true,
        summary: cancelled ? `Job ${jobId} cancelled.` : `Job ${jobId} could not be cancelled (already finished or not found).`,
        output: { jobId, cancelled },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: msg, error: msg };
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

function isValidBackend(value: unknown): value is "tanya" | "claude" | "codex" | "cursor" {
  if (typeof value !== "string") return false;
  return value === "tanya" || value === "claude" || value === "codex" || value === "cursor";
}

// ── Export all ───────────────────────────────────────────────────────

export function subagentTools(): TanyaTool[] {
  return [dispatchSubagentTool, subagentStatusTool, subagentResultTool, subagentCancelTool];
}
