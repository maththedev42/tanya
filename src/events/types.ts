export type TanyaEvent = ( 
  | { type: "status"; message: string }
  | { type: "session_ready"; sessionId: string; cwd: string; provider: string; model: string; protocolVersion: 1; worktree?: string }
  | { type: "session_replay"; messages: Array<{ role: "user" | "assistant"; content: string; timestampMs: number }>; stats?: { promptTokens: number; completionTokens: number; costUsd: number; elapsedMs: number; turnCount: number } }
  | { type: "message_start"; elapsedMs?: number; headingStartedAt?: number }
  | { type: "message_delta"; text: string }
  | { type: "message_end" }
  | { type: "reasoning_chunk"; content: string; provider: string; model: string; runId: string; turn?: number; tokens?: number }
  | { type: "reasoning_truncated"; provider: string; model: string; usedTokens: number; capTokens: number; stepType: "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown" }
  | { type: "tool_call"; id: string; tool: string; input: unknown }
  | { type: "tool_progress"; toolCallId: string; chunk: string; timestamp: string; stream: "stdout" | "stderr" }
  | { type: "tool_cancel_requested"; toolCallId: string; tool?: string; timestamp: string }
  | { type: "tool_cancelled"; toolCallId: string; tool?: string; timestamp: string; partialOutput?: string }
  | {
      type: "permission_request";
      id: string;
      tool: string;
      input: unknown;
      matchedRule?: string;
      projectedCostUsd?: number;
      projectedTokens?: number;
    }
  | {
      type: "permission_decision";
      id: string;
      decision: "allow" | "deny";
      source: "user" | "rule" | "engine" | "bypass";
      persistAs?: "always" | "never";
      matchedRule?: string;
      projectedCostUsd?: number;
      projectedTokens?: number;
      thresholdUsd?: number;
      thresholdTokens?: number;
    }
  | {
      type: "tool_result";
      id: string;
      tool: string;
      ok: boolean;
      summary: string;
      output?: unknown;
      error?: string;
      reason?: string;
      modelView?: unknown;
      verifierView?: unknown;
    }
  | {
      type: "tool_call_parse_warning";
      reason: string;
      provider?: string;
      turn?: number;
      attempt?: number;
      toolCallId?: string;
      tool?: string;
    }
  | {
      type: "schema_flatten_warning";
      reason: string;
      path: string;
      provider?: string;
      tool?: string;
    }
  | { type: "provider_throttle"; provider: string; attempt: number; waitMs: number }
  | {
      type: "model_routed";
      stepType: "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";
      provider: string;
      model: string;
      reason: string;
      cacheImpact?: "hit" | "miss" | "unknown";
    }
  | {
      type: "provider.raw";
      provider?: string;
      model?: string;
      event: Record<string, unknown>;
    }
  | {
      type: "escalation_event";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      reason: "parse_failure" | "schema_failure" | "context_too_small";
      stepType: "planning" | "tool_call" | "synthesis" | "verification" | "reasoning" | "unknown";
    }
  | {
      type: "compact_event";
      compactType: "auto" | "micro" | "snip" | "clear_tool_results";
      removedTokens: number;
      summaryTokens?: number;
      aggression?: "normal" | "heavy";
    }
  | {
      type: "prompt_budget_exceeded";
      droppedSections: string[];
      totalTokens: number;
      cap: number;
    }
  | {
      type: "subtask_started";
      subRunId: string;
      parentRunId: string;
      prompt: string;
      workspace: string;
    }
  | {
      type: "subtask_completed";
      subRunId: string;
      parentRunId: string;
      verdict: "passed" | "failed";
      summary: string;
      tokensUsed: { in: number; out: number; reasoning?: number };
    }
  | { type: "command_invoked"; name: string; args: string[]; runId?: string }
  | { type: "subtask_start"; subtask_id: string; title: string; files: string[] }
  | { type: "subtask_done"; subtask_id: string; files_changed: string[]; summary: string; ok: boolean }
  | {
      type: "subagent";
      jobId: string;
      status: "dispatched" | "queued" | "running" | "completed" | "failed" | "cancelled";
      label?: string;
      backend?: string;
      progressLine?: string;
      error?: string;
      subRunId?: string;
      verdict?: string;
      blockers?: string[];
    }
  | {
      type: "final";
      message: string;
      suppressHumanMessage?: boolean;
      files?: string[];
      manifest?: Record<string, unknown>;
      metrics?: {
        durationMs: number;
        toolCallCount: number;
        toolErrorCount: number;
        changedFileCount: number;
        repairAttemptCount?: number;
        retryAttemptCount?: number;
        promptTokens?: number;
        completionTokens?: number;
        reasoningTokens?: number;
        cachedPromptTokens?: number;
        costUsd?: number;
        systemPromptTokens?: number;
        repoMapTokens?: number;
        toolResultTokens?: number;
      };
    }
  | { type: "turn_complete"; elapsedMs: number; promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number; costUsd?: number }
  | { type: "commands"; commands: Array<{ name: string; description: string; category: string }> }
  | { type: "error"; message: string; detail?: string; code?: string }
) & { subRunId?: string };

export type EventSink = (event: TanyaEvent) => void | Promise<void>;

/** Every discriminant in the TanyaEvent union, as a runtime value. The mac
 *  app's ServerEvent.swift knownTypes block is GENERATED from this list
 *  (scripts/gen-server-event-types.ts) and a test pins the Swift file to it —
 *  protocol drift fails the suite instead of silently decoding as .unknown.
 *  The `satisfies` clause rejects any name not in the union; the `_covers`
 *  assignment fails to compile when a union member is missing here. */
export const SERVER_EVENT_TYPES = [
  "status",
  "session_ready",
  "session_replay",
  "message_start",
  "message_delta",
  "message_end",
  "reasoning_chunk",
  "reasoning_truncated",
  "tool_call",
  "tool_progress",
  "tool_cancel_requested",
  "tool_cancelled",
  "permission_request",
  "permission_decision",
  "tool_result",
  "tool_call_parse_warning",
  "schema_flatten_warning",
  "provider_throttle",
  "model_routed",
  "provider.raw",
  "escalation_event",
  "compact_event",
  "prompt_budget_exceeded",
  "subtask_started",
  "subtask_completed",
  "command_invoked",
  "subtask_start",
  "subtask_done",
  "subagent",
  "final",
  "turn_complete",
  "commands",
  "error",
] as const satisfies readonly TanyaEvent["type"][];

const _covers: [TanyaEvent["type"]] extends [(typeof SERVER_EVENT_TYPES)[number]] ? true : never = true;
void _covers;
