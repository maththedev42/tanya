import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { EventSink } from "../events/types";
import type { TanyaRunContext } from "../context/runContext";
import type { PermissionContext } from "../safety/permissions/engine";
import type { TanyaTool, ToolResult } from "../tools/types";
import type { FileReadDedupCache } from "../memory/fileReadDedup";
import { appendAuditDecision } from "../memory/auditLog";
import { writeCachedToolResult } from "../memory/resultCache";
import { collectChangedFiles } from "./report";
import { pathIsGitTracked, uniqueSorted } from "./git";
import { flushExitSentinelHeartbeat, type ExitSentinelState } from "./exitSentinel";
import { detectProjectGenerator, type ProjectGenerator } from "./projectGenerators";
import { isFreshnessRelevantSource } from "./verificationFreshness";
import {
  allFailingPackagesUntouched,
  isBroadGoTestCommand,
  packagesTouchedByRun,
  parseGoTestFailures,
} from "./baselineFailures";
import { appendLedgerRecord } from "./runLedger";
import { buildStuckNudge, StuckGuard } from "./stuckGuard";
import { buildWrapUpDirective } from "./progressBudget";
import { snapshotForPaths } from "../snapshots/turnSnapshots";
import { collectWriteTargets } from "../tools/toolGate";

// Per-tool-result processor (R3a): everything that happens to a tool call
// AFTER the runner's parse/validation/permission gates — pre-execution guards
// (duplicate verification, shell spirals, repeated failures, read dedup,
// expand_result budget), the turn snapshot, execution via the runner-built
// thunk, and the whole post-execution pipeline (ledger, progress accounting,
// stuck guard, baseline classification, verification lines, advisory nudges,
// truncation, transcript + sink emission). The class owns the run-scoped
// counters and advisory flags that used to be ~25 coupled closure variables
// in runAgent; the runner reads accumulated state (changed files, error
// counts, verification bookkeeping) from its public fields at finalize.

export const TOOL_RESULT_TRUNCATE_THRESHOLD = 2_048;
export const TOOL_RESULT_HEAD_CHARS = 1_024;
export const TOOL_RESULT_TAIL_CHARS = 500;
export const EXPAND_RESULT_LIMIT_PER_TURN = 3;
// After this many identical failures with no code change in between, the
// runner stops re-running a command (build/test/verify) — another identical
// run cannot produce a different result. Editing code re-arms it.
export const REPEATED_FAILURE_ATTEMPT_LIMIT = 3;
export const NEAR_DUPLICATE_FAILURE_LIMIT = 3;

export function commandLabel(toolName: string, input: unknown): string | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (toolName === "run_shell") {
    const script = typeof record.script === "string"
      ? record.script.trim()
      : typeof record.command === "string"
        ? record.command.trim()
        : "";
    return script || null;
  }
  if (toolName === "run_command") {
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
    return command ? [command, ...args].join(" ") : null;
  }
  if (/^validate_/.test(toolName)) return toolName;
  return null;
}

// Near-duplicate retry breaker. The exact-label repeated-failure guard below
// only fires on a BYTE-IDENTICAL command (same label). A model chasing a bug
// by tweaking small variants — different flags, a slightly different pattern,
// a different directory — produces a fresh label each time and evades that
// guard, while re-triggering the exact same underlying failure over and over
// (observed: three grep variants hunting one missing symbol, each getting its
// own 3-strike budget). Fingerprint by (command family, failure text) instead
// of exact command text, so the variants collapse onto one counter.
function fingerprintBinary(label: string): string {
  let script = label.trim();
  const cdPrefix = script.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/);
  if (cdPrefix) script = script.slice(cdPrefix[0].length).trim();
  return (script.split(/\s+/, 1)[0] ?? "").split("/").pop() ?? "";
}

export function stableFailureText(result: { output?: unknown; error?: string; summary: string }): string {
  if (typeof result.output === "string" && result.output.trim()) return result.output;
  if (result.error) return result.error;
  return result.summary;
}

export function failureFingerprint(label: string, result: { output?: unknown; error?: string; summary: string }): string {
  const binary = fingerprintBinary(label);
  const normalized = stableFailureText(result).replace(/\s+/g, " ").trim().slice(0, 4_000);
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${binary}::${hash}`;
}

export function appendResultNudge(result: ToolResult, nudge: string): ToolResult {
  if (typeof result.output === "string") return { ...result, output: `${result.output}\n\n${nudge}` };
  if (result.output && typeof result.output === "object") {
    return { ...result, output: { ...(result.output as Record<string, unknown>), near_duplicate_nudge: nudge } };
  }
  return { ...result, output: nudge };
}

export function toolResultMutatedFiles(toolName: string, result: { ok: boolean; files?: string[] }): boolean {
  if (!result.ok) return false;
  if ((result.files ?? []).length > 0) return true;
  return mutatingToolNames.has(toolName);
}

export const mutatingToolNames = new Set([
    "write_file",
    "apply_patch",
    "search_replace",
    "copy_file",
    "copy_dir",
    "apply_artifact",
    "commit_platform_changes",
    "create_apple_app_icon_set",
    "create_android_launcher_icon_set",
    "create_android_foundation",
    "render_svg_to_png",
    "resize_image",
]);

export function toolCallMayMutate(toolName: string, input: unknown): boolean {
  if (mutatingToolNames.has(toolName)) return true;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (toolName === "run_shell") {
    const script = typeof record.script === "string" ? record.script : "";
    return /\b(?:cat|printf|echo)\b[\s\S]{0,200}>\s*[^&|;\n]|\btee\s+[^|;\n]+|\b(?:mkdir|touch|rm|mv|cp)\s+|\bsed\s+-i\b|\bperl\s+-pi\b|\bktlintFormat\b/.test(script);
  }
  if (toolName === "run_command") {
    const command = typeof record.command === "string" ? record.command : "";
    const args = Array.isArray(record.args) ? record.args.join(" ") : "";
    return /\b(?:git|npm|pnpm|yarn|gradle|\.\/gradlew)\b/.test(command) && /\b(?:add|commit|install|ktlintFormat)\b/.test(args);
  }
  return false;
}

export function verificationKey(label: string): string {
  const isUnsafeXcodebuildPipe = /\bxcodebuild\b/i.test(label) && /\|/.test(label) && !/set\s+-o\s+pipefail/.test(label);
  const usesGradle = /(?:^|[\s;&|])(?:\.\/gradlew|gradle)\b/i.test(label);
  const usesMobileBuildTool = /(?:^|[\s;&|])(?:\.\/gradlew|gradle|xcodebuild)\b/i.test(label);
  const isUnsafeGradlePipe = usesGradle && /\|/.test(label) && !/set\s+-o\s+pipefail/.test(label);
  const masksExitCode = usesMobileBuildTool && /;\s*echo\s+["']?EXIT_CODE=\$\?["']?/i.test(label);
  if (isUnsafeGradlePipe || masksExitCode) return label.replace(/\s+/g, " ").trim();
  if (!isUnsafeXcodebuildPipe && /\bxcodebuild\s+build\b/i.test(label)) return "xcodebuild build";
  if (!isUnsafeXcodebuildPipe && /\bxcodebuild\s+test\b/i.test(label)) return "xcodebuild test";
  if (/\bxcodebuild\s+-list\b/i.test(label)) return "xcodebuild -list";
  if (/\bfastlane\s+lanes\b/i.test(label)) return "fastlane lanes";
  if (/\bgit\s+rev-parse\s+--show-toplevel\b/i.test(label)) return "git root";
  if (/\bgit\s+rev-parse\s+--short\s+HEAD\b/i.test(label)) return "git head";
  return label.replace(/\s+/g, " ").trim();
}

function shellCommandSpiralKey(input: unknown): string | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const script = typeof record.script === "string"
    ? record.script
    : typeof record.command === "string"
      ? record.command
      : "";
  const normalized = script
    .replace(/\$\(\s*go\s+env\s+GOMODCACHE\s*\)/g, "$(go env GOMODCACHE)")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function shouldApplyShellSpiralDetector(command: string): boolean {
  return /\bgrep\b/i.test(command) &&
    /\b(?:GOMODCACHE|go env GOMODCACHE|pkg\/mod|github\.com\/danielgtaylor\/huma\/v2|huma\/v2)\b/i.test(command);
}

function artifactPathFromRead(toolName: string, input: unknown): string | null {
  if (toolName !== "read_file") return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return null;
  if (path.startsWith(".tanya/artifacts/")) return path;
  if (path.startsWith("artifacts/")) return path;
  return null;
}

function contextPathFromRead(toolName: string, input: unknown, runContext?: TanyaRunContext): string | null {
  if (toolName !== "read_file") return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return null;
  if (path.startsWith(".tanya/context/")) return path;
  if ((runContext?.contextFiles ?? []).some((contextFile) => contextFile.path === path)) return path;
  return null;
}

function outsideWorkspaceReadMessage(workspace: string, toolName: string, input: unknown): string | null {
  if (toolName !== "read_file") return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path || !isAbsolute(path)) return null;
  const target = resolve(path);
  const rel = relative(workspace, target);
  if (!rel.startsWith("..") && rel !== "..") return null;
  return [
    `Skipped external path outside workspace: ${path}.`,
    "The caller should materialize external context inside the workspace or embed it in the prompt.",
    "Do not retry this absolute path; continue with the workspace-local context and report the skipped external read only if it matters.",
  ].join(" ");
}

function outputRecord(result: ToolResult): Record<string, unknown> {
  return result.output && typeof result.output === "object" && !Array.isArray(result.output)
    ? result.output as Record<string, unknown>
    : {};
}

function withEditBlockRepairHint(tool: string, result: ToolResult): ToolResult {
  if (tool !== "edit_block" || result.ok) return result;
  const output = outputRecord(result);
  const candidateExcerpt = typeof output.candidateExcerpt === "string" && output.candidateExcerpt.trim()
    ? output.candidateExcerpt.trim()
    : "";
  const hint = candidateExcerpt
    ? `consider re-reading the file and emitting a closer search block. Closest candidate excerpt:\n${candidateExcerpt}`
    : "consider re-reading the file and emitting a closer search block";
  return {
    ...result,
    error: result.error ? `${result.error}; ${hint}` : hint,
    output: { ...output, repairHint: hint },
  };
}

const shellSafetyRepairHint = [
  "Your cleanup command was blocked by Tanya's safety policy.",
  "Safer alternatives:",
  "- For build artifacts: rely on the next run's clean step; don't manually rm",
  "- For temporary files: use mktemp -d and let the OS clean /tmp eventually",
  "- For workspace state: use git clean -fd inside the workspace instead",
  "Re-attempt the task; cleanup isn't required for verification.",
].join("\n");

export function toolResultReason(result: ToolResult): string | undefined {
  const output = outputRecord(result);
  const reason = output.reason;
  return typeof reason === "string" ? reason : undefined;
}

function withShellSafetyRepairHint(result: ToolResult): ToolResult {
  if (result.ok || toolResultReason(result) !== "shell_safety_block") return result;
  const output = outputRecord(result);
  const error = result.error && result.error.includes(shellSafetyRepairHint)
    ? result.error
    : [result.error, shellSafetyRepairHint].filter(Boolean).join("\n\n");
  return {
    ...result,
    error,
    output: { ...output, repairHint: shellSafetyRepairHint },
  };
}

export function withRunnerRepairHints(tool: string, result: ToolResult): ToolResult {
  return withShellSafetyRepairHint(withEditBlockRepairHint(tool, result));
}

function networkFailureCommandText(toolName: string, input: unknown): string {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (toolName === "run_shell") {
    return typeof record.script === "string"
      ? record.script
      : typeof record.command === "string" ? record.command : "";
  }
  if (toolName === "run_command") {
    const command = typeof record.command === "string" ? record.command : "";
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string").join(" ") : "";
    return `${command} ${args}`.trim();
  }
  return "";
}

function looksLikeNetworkOrDependencyFailure(toolName: string, input: unknown, result: ToolResult): boolean {
  if (result.ok) return false;
  if (toolName !== "run_shell" && toolName !== "run_command") return false;
  const command = networkFailureCommandText(toolName, input);
  const output = [result.summary, result.error, typeof result.output === "string" ? result.output : ""].join("\n");
  return /\b(?:pip3?|python3?\s+-m\s+pip|npm\s+(?:install|i)|pnpm\s+install|yarn\s+install|bun\s+install|curl|wget|requests|beautifulsoup|bs4)\b/i.test(command) ||
    /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|DNS|timeout|certificate|Could not resolve|Temporary failure|No matching distribution|command not found: pip|pip: command not found)\b/i.test(output);
}

function auditEditBlockCandidate(workspace: string, context: PermissionContext, input: unknown, result: ToolResult): void {
  const output = outputRecord(result);
  if (output.matchPolicy !== "fuzzy") return;
  if (output.recoveredVia === undefined || output.recoveredVia === "exact") return;
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool: "edit_block",
    input: {
      path: typeof output.path === "string" ? output.path : undefined,
      requested: input,
      fuzzyCandidate: {
        recoveredVia: output.recoveredVia,
        confidence: output.confidence,
        candidateExcerpt: output.candidateExcerpt,
      },
    },
    decision: "allow",
    source: "engine",
    mode: context.mode,
    reason: "fuzzy-candidate-applied",
  });
}

function resultOutputText(result: ToolResult): string | null {
  if (result.output === undefined || result.output === null) return null;
  if (typeof result.output === "string") return result.output;
  try {
    return JSON.stringify(result.output, null, 2);
  } catch {
    return String(result.output);
  }
}

export function truncateToolResultForModel(params: {
  tool: TanyaTool;
  result: ToolResult;
  workspace: string;
  runId: string;
  toolCallId: string;
  expandCallsRemaining: number;
}): { modelResult: ToolResult; truncated: boolean } {
  if (params.tool.truncateLargeResults === false) {
    return { modelResult: params.result, truncated: false };
  }
  const output = resultOutputText(params.result);
  if (!output || output.length <= TOOL_RESULT_TRUNCATE_THRESHOLD) {
    return { modelResult: params.result, truncated: false };
  }

  writeCachedToolResult(params.workspace, params.runId, params.toolCallId, output);
  const omittedChars = Math.max(0, output.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS);
  const marker = [
    `<truncated ${omittedChars} chars; ask for more (tool_call_id=${params.toolCallId}; `,
    `you have ${Math.max(0, params.expandCallsRemaining)} expand_result call${params.expandCallsRemaining === 1 ? "" : "s"} left this turn)>`,
  ].join("");
  const modelOutput = [
    output.slice(0, TOOL_RESULT_HEAD_CHARS),
    marker,
    output.slice(-TOOL_RESULT_TAIL_CHARS),
  ].join("\n");
  return {
    modelResult: {
      ...params.result,
      summary: `${params.result.summary} Output was truncated for the model; use expand_result if more is needed.`,
      output: modelOutput,
    },
    truncated: true,
  };
}

/** The runner-side seams the processor needs: the live transcript (which
 *  compaction reassigns, so pushes go through closures) and the wrap-up
 *  window state owned by the turn loop. */
export interface ToolResultHost {
  pushUserMessage(content: string): void;
  pushToolMessage(toolCallId: string, content: string): void;
  wrapUpActive(): boolean;
  grantWrapUp(startedTurn: number): void;
}

export interface ToolResultProcessorOptions {
  workspace: string;
  runId: string;
  sink: EventSink;
  runContext?: TanyaRunContext;
  permissionContext: PermissionContext;
  fileReadDedup: FileReadDedupCache;
  exitSentinelState: ExitSentinelState;
  /** The array registerExitSentinel already holds, so its live view and the
   *  processor start out pointing at the same object. */
  initialChangedFiles: string[];
  verificationLines: string[];
  verificationEvents: { line: string; atMs: number }[];
  requiredTool: string | null;
  snapshotsEnabled: boolean;
  stuckGuardEnabled: boolean;
  sentinelFlushEvery: number;
  firstBuildNudgeAfter: number;
  host: ToolResultHost;
}

export interface ProcessCallContext {
  toolCallId: string;
  tool: TanyaTool;
  toolName: string;
  callInput: unknown;
  turn: number;
  /** Runner-built thunk that actually executes the tool (abort wiring and
   *  progress forwarding stay on the runner side). Called at most once, and
   *  only when no guard produced a synthetic result. */
  execute: () => Promise<ToolResult>;
}

export class ToolResultProcessor {
  // Accumulated run state the runner reads (finalize, reminders, budgets).
  changedFiles: string[];
  toolErrorCount = 0;
  readArtifactPaths: string[] = [];
  readContextPaths: string[] = [];
  lastProgressTurn = 0;
  firstMutationTurn: number | null = null;
  totalToolResultTokens = 0;
  requiredToolUsed: boolean;

  readonly verificationLines: string[];
  readonly verificationEvents: { line: string; atMs: number }[];

  private readonly passedVerificationKeys = new Map<string, number>();
  private readonly skippedDuplicateKeys = new Map<string, number>();
  private readonly shellCommandSpiralCounts = new Map<string, number>();
  private shellCommandSpiralAdvisorySent = false;
  // Generic repeated-failure guard: how many times each labelled command
  // (build/test/verify) has failed with NO file mutation in between. Re-running
  // an identical command that keeps failing without any code change cannot
  // produce a different result — it just burns turns/tokens (the 2026-05-09
  // `go build ./...` spiral). The count resets whenever files change (a real
  // fix attempt) because the entry is keyed to the mutation revision.
  private readonly repeatedFailureAttempts = new Map<string, { count: number; revision: number }>();
  private repeatedFailureAdvisorySent = false;
  private readonly nearDuplicateFailures = new Map<string, { count: number; revision: number }>();
  private readonly nearDuplicateAdvisorySent = new Set<string>();
  private consecutiveNetworkFailures = 0;
  private networkFallbackReminderSent = false;
  private networkFallbackReminderPendingFlag = false;
  private mutationRevision = 0;
  // Early-nudge state (PROMPT B2 items 3–4): generated-project detection is
  // cached per run; each nudge fires at most once.
  private cachedProjectGenerator: ProjectGenerator | null | undefined;
  private readonly sentinelSeenFiles = new Set<string>();
  private generatorNudgeSent = false;
  private firstBuildNudgeSent = false;
  private sentinelMutationCount = 0;
  private readonly stuckGuard = new StuckGuard();
  private expandResultCallsThisTurn = 0;
  private turnSnapshotTaken = false;

  constructor(private readonly options: ToolResultProcessorOptions) {
    this.changedFiles = options.initialChangedFiles;
    this.verificationLines = options.verificationLines;
    this.verificationEvents = options.verificationEvents;
    this.requiredToolUsed = options.requiredTool ? false : true;
  }

  /** Reset per-turn budgets (expand_result cap, one-snapshot-per-turn). */
  beginTurn(): void {
    this.expandResultCallsThisTurn = 0;
    this.turnSnapshotTaken = false;
  }

  get networkFallbackReminderPending(): boolean {
    return this.networkFallbackReminderPendingFlag && !this.networkFallbackReminderSent;
  }

  markNetworkFallbackReminderSent(): void {
    this.networkFallbackReminderPendingFlag = false;
    this.networkFallbackReminderSent = true;
  }

  repeatedDuplicateSkips(): number {
    return [...this.skippedDuplicateKeys.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  }

  clearDuplicateSkips(): void {
    this.skippedDuplicateKeys.clear();
  }

  async processCall(ctx: ProcessCallContext): Promise<void> {
    const { toolName, callInput, tool, turn } = ctx;
    const { workspace, runId, sink, host } = this.options;
    const label = commandLabel(toolName, callInput);
    const key = label ? verificationKey(label) : null;
    const outsideReadMessage = outsideWorkspaceReadMessage(workspace, toolName, callInput);
    let duplicateVerification = key ? this.passedVerificationKeys.get(key) === this.mutationRevision : false;
    const dedupedReadResult = !outsideReadMessage && toolName === "read_file"
      ? await this.options.fileReadDedup.lookup(callInput)
      : null;
    let spiralResult: ToolResult | null = null;
    if (!outsideReadMessage && toolName === "run_shell") {
      const spiralKey = shellCommandSpiralKey(callInput);
      if (spiralKey && shouldApplyShellSpiralDetector(spiralKey)) {
        const previousExecutions = this.shellCommandSpiralCounts.get(spiralKey) ?? 0;
        if (previousExecutions >= 5) {
          duplicateVerification = false;
          const advisory = `Detected repeated verification of ${spiralKey} — embed result in prompt or move on. Skipping further attempts.`;
          if (!this.shellCommandSpiralAdvisorySent) {
            this.shellCommandSpiralAdvisorySent = true;
            await sink({ type: "status", message: advisory });
          }
          spiralResult = {
            ok: true,
            summary: "Skipped repeated shell command: verification spiral detected.",
            output: `skipped: spiral detected\n${advisory}`,
          };
        } else {
          this.shellCommandSpiralCounts.set(spiralKey, previousExecutions + 1);
          duplicateVerification = false;
        }
      }
    }
    // Generic repeated-failure guard (covers run_command too, not just the
    // narrow grep/GOMODCACHE spiral above): skip a labelled command that has
    // already failed REPEATED_FAILURE_ATTEMPT_LIMIT times at the current
    // mutation revision — with no code change since, it will fail
    // identically. The skip is a FAILURE, never a pass, so the real blocker
    // stays and the run can't go falsely green; the agent is nudged to fix
    // the code (which bumps the revision and re-arms the command) or to
    // report the blocker instead of re-running it forever.
    if (!spiralResult && label) {
      const prior = this.repeatedFailureAttempts.get(label);
      if (prior && prior.revision === this.mutationRevision && prior.count >= REPEATED_FAILURE_ATTEMPT_LIMIT) {
        duplicateVerification = false;
        const advisory = `\`${label}\` has failed ${prior.count} times with no code change in between — re-running it will not help. Fix the underlying code or approach, or report it as a blocker; do not run it again unchanged.`;
        if (!this.repeatedFailureAdvisorySent) {
          this.repeatedFailureAdvisorySent = true;
          await sink({ type: "status", message: advisory });
        }
        spiralResult = {
          ok: false,
          summary: "Skipped repeated failing command: no change since the last identical failure.",
          output: `skipped: repeated failure\n${advisory}`,
        };
      }
    }
    const wasSpiralSkip = spiralResult !== null;
    if (toolName === "expand_result" && this.expandResultCallsThisTurn >= EXPAND_RESULT_LIMIT_PER_TURN) {
      const result = {
        ok: false,
        summary: "expand_result limit reached for this turn.",
        error: `Only ${EXPAND_RESULT_LIMIT_PER_TURN} expand_result calls are allowed per turn.`,
        output: { ok: false, error: "expand_result limit reached for this turn" },
      } satisfies ToolResult;
      this.toolErrorCount += 1;
      host.pushToolMessage(ctx.toolCallId, JSON.stringify(result));
      await sink({
        type: "tool_result",
        id: ctx.toolCallId,
        tool: toolName,
        ok: false,
        summary: result.summary,
        output: result.output,
        error: result.error,
      });
      return;
    }
    const willExecute = !outsideReadMessage && !duplicateVerification && !spiralResult && !dedupedReadResult;
    // Turn snapshot (P2-A): before the FIRST mutating tool of a turn,
    // snapshot the repo(s) the call is about to touch into the side
    // snapshot store, so `tanya restore` can undo the turn. Lazy (read-
    // only turns cost nothing), once per turn, never fatal.
    if (willExecute && this.options.snapshotsEnabled && !this.turnSnapshotTaken && toolCallMayMutate(toolName, callInput)) {
      this.turnSnapshotTaken = true;
      try {
        snapshotForPaths(workspace, collectWriteTargets(toolName, callInput), `pre-turn:${turn}`);
      } catch {
        // Snapshots must never break a run.
      }
    }
    const rawResult = outsideReadMessage
      ? {
          ok: true,
          summary: outsideReadMessage,
          output: outsideReadMessage,
        }
      : duplicateVerification
        ? {
          ok: true,
          summary: "Skipped duplicate verification; the previous matching command already exited 0 and is authoritative.",
          output: "Already verified in this run. Do not call this verification again; produce the final report now.",
        }
        : spiralResult
          ? spiralResult
          : dedupedReadResult
            ? dedupedReadResult
            : await ctx.execute();
    let result = withRunnerRepairHints(toolName, rawResult);
    if (toolName === "commit_platform_changes" && result.ok) {
      const commitOutput = (result.output && typeof result.output === "object" ? result.output : {}) as Record<string, unknown>;
      appendLedgerRecord(workspace, {
        type: "commit",
        runId,
        ts: new Date().toISOString(),
        sha: typeof commitOutput.head === "string" ? commitOutput.head : "",
        files: result.files ?? [],
        message: typeof commitOutput.message === "string" ? commitOutput.message.slice(0, 120) : "",
      });
    }
    if (toolName === "expand_result" && result.ok) this.expandResultCallsThisTurn += 1;
    if (duplicateVerification && key) {
      this.skippedDuplicateKeys.set(key, (this.skippedDuplicateKeys.get(key) ?? 0) + 1);
    }
    if (toolName === "edit_block" && result.ok) {
      auditEditBlockCandidate(workspace, this.options.permissionContext, callInput, result);
    }
    if (result.ok) {
      this.changedFiles = collectChangedFiles(this.changedFiles, result.files);
      // collectChangedFiles returns a NEW array — keep the exit sentinel's
      // live view pointed at the current one.
      this.options.exitSentinelState.changedFiles = this.changedFiles;
      if (toolResultMutatedFiles(toolName, result)) {
        this.sentinelMutationCount += 1;
        if (this.firstMutationTurn === null) this.firstMutationTurn = turn;
        if (this.sentinelMutationCount === 1 || this.sentinelMutationCount % this.options.sentinelFlushEvery === 0) {
          flushExitSentinelHeartbeat(this.options.exitSentinelState);
        }
      }
      if (toolName === this.options.requiredTool) this.requiredToolUsed = true;
      // A successful GENUINELY-EXECUTED tool counts as progress and resets
      // the stall budget. Synthetic ok-results (deduped re-reads, skipped
      // duplicate verifications, spiral advisories, outside-workspace-read
      // notices) must NOT count: with an unbounded turn ceiling, a model
      // looping on already-answered calls would otherwise "progress" forever.
      const syntheticResult = Boolean(outsideReadMessage) || Boolean(duplicateVerification) || Boolean(spiralResult) || Boolean(dedupedReadResult);
      if (!syntheticResult) {
        this.lastProgressTurn = turn;
      }
    }
    if (looksLikeNetworkOrDependencyFailure(toolName, callInput, result)) {
      this.consecutiveNetworkFailures += 1;
      if (this.consecutiveNetworkFailures >= 2 && !this.networkFallbackReminderSent) {
        this.networkFallbackReminderPendingFlag = true;
      }
    } else if (result.ok && toolName !== "read_file" && toolName !== "list_files" && toolName !== "search") {
      this.consecutiveNetworkFailures = 0;
    }
    if (toolName === "read_file" && result.ok && !dedupedReadResult && !outsideReadMessage) {
      await this.options.fileReadDedup.remember(callInput, ctx.toolCallId, turn);
    }
    if (toolResultMutatedFiles(toolName, result)) {
      this.mutationRevision += 1;
      this.options.fileReadDedup.clear();
      // Real progress unsticks: every StuckGuard streak resets.
      this.stuckGuard.reset();
    }
    // Unified StuckGuard (R3b): fingerprint REAL failed executions by
    // {tool, canonical args, error signature}; warn once per fingerprint,
    // then stop via the standard wrap-up window. Never fails a run.
    if (this.options.stuckGuardEnabled && willExecute && !result.ok) {
      const observation = this.stuckGuard.observeFailure(toolName, callInput, stableFailureText(result));
      if (observation.action === "warn" && !observation.repeatedWarn) {
        result = appendResultNudge(result, buildStuckNudge(observation.reason ?? "repeated identical failure"));
        await sink({ type: "status", message: `stuck guard: ${observation.reason}` });
      } else if (observation.action === "stop" && !host.wrapUpActive()) {
        host.grantWrapUp(turn);
        host.pushUserMessage(
          [buildStuckNudge(observation.reason ?? "repeated identical failure"), "", buildWrapUpDirective("no_progress")].join("\n"),
        );
        await sink({ type: "status", message: `stuck guard: ${observation.reason} — wrap-up window granted` });
      }
    }
    const artifactPath = artifactPathFromRead(toolName, callInput);
    if (artifactPath && result.ok) this.readArtifactPaths = uniqueSorted([...this.readArtifactPaths, artifactPath]);
    const contextPath = contextPathFromRead(toolName, callInput, this.options.runContext);
    if (contextPath && result.ok) this.readContextPaths = uniqueSorted([...this.readContextPaths, contextPath]);
    // Baseline-aware verification (early classification, Go-first): a
    // broad `go test ./...` failure whose failing packages are ALL
    // untouched by this run is very likely a pre-existing red test, not
    // something this run broke — the exact shape that stalled a run on
    // `internal/store/apple` while the task never touched that package.
    // Computed here (before the verification line below) so the SHORT tag
    // reaches `Stuck on:` in the interactive pause message, not just the
    // model-facing tool output. Advisory only — never changes result.ok.
    // The rigorous, worktree-verified check that can actually drop the
    // blocker runs at finalize (report.ts); this just classifies sooner.
    let baselineTag: string | null = null;
    let baselineNudge: string | null = null;
    if (label && !wasSpiralSkip && !result.ok && isBroadGoTestCommand(label)) {
      const failingPackages = parseGoTestFailures(stableFailureText(result));
      const touchedDirs = packagesTouchedByRun(this.changedFiles);
      if (allFailingPackagesUntouched(failingPackages, touchedDirs)) {
        baselineTag = `likely pre-existing failure in ${failingPackages.join(", ")} — not caused by this run`;
        const scopedHint = touchedDirs.length > 0
          ? `go test ${touchedDirs.map((dir) => `./${dir}/...`).join(" ")}`
          : "go test <the package(s) you actually changed>";
        baselineNudge = `The failing package(s) ${failingPackages.join(", ")} were not touched by this run — this is likely a pre-existing failure. Do NOT fix unrelated packages. Re-run scoped to what you changed (e.g. \`${scopedHint}\`); if the scoped run passes, state the pre-existing failure in your report instead of retrying the broad command.`;
      }
    }
    if (label) {
      const summaryForLine = baselineTag ? `${result.summary} — ${baselineTag}` : result.summary;
      const line = `Verification: ${label} -> ${result.ok ? "passed" : "failed"} (${summaryForLine})`;
      this.verificationEvents.push({ line, atMs: Date.now() });
      if (!wasSpiralSkip && !duplicateVerification) {
        appendLedgerRecord(workspace, {
          type: "verification",
          runId,
          ts: new Date().toISOString(),
          command: label,
          result: result.ok ? "passed" : "failed",
        });
      }
      const existingIndex = this.verificationLines.findIndex((existing) => existing.includes(label));
      if (existingIndex === -1) {
        this.verificationLines.push(line);
      } else if (result.ok && /->\s*failed\b/i.test(this.verificationLines[existingIndex] ?? "")) {
        this.verificationLines[existingIndex] = line;
      }
    }
    // Track consecutive identical failures for the repeated-failure guard.
    // A pass clears the streak; a failure at the same mutation revision
    // extends it, and a failure after files changed starts a fresh streak.
    // Skips (wasSpiralSkip) are not real executions, so they don't count.
    if (label && !wasSpiralSkip) {
      if (result.ok) {
        this.repeatedFailureAttempts.delete(label);
      } else {
        const prior = this.repeatedFailureAttempts.get(label);
        this.repeatedFailureAttempts.set(
          label,
          prior && prior.revision === this.mutationRevision
            ? { count: prior.count + 1, revision: this.mutationRevision }
            : { count: 1, revision: this.mutationRevision },
        );
      }
    }
    if (key && result.ok) this.passedVerificationKeys.set(key, this.mutationRevision);
    if (!result.ok) this.toolErrorCount += 1;
    if (result.cancelled) {
      const cancelledEvent = {
        type: "tool_cancelled",
        toolCallId: ctx.toolCallId,
        tool: toolName,
        timestamp: new Date().toISOString(),
      } as const;
      await sink(result.partial_output !== undefined
        ? { ...cancelledEvent, partialOutput: result.partial_output }
        : cancelledEvent);
    }
    // baselineNudge was computed above (before the verification line) so
    // its short tag could reach `Stuck on:` too; apply the full nudge text
    // to the model-facing output here.
    let modelFacingResult = baselineNudge ? appendResultNudge(result, baselineNudge) : result;
    // Near-duplicate retry breaker: fingerprint by (binary, failure text),
    // NOT exact label, so slightly-varied commands hunting the same failure
    // collapse onto one counter. Never skips the command (that stays the
    // exact-label guard's job above) — only appends a strategy-change nudge
    // once the count crosses the limit, so the model self-corrects instead
    // of grinding through more near-identical variants.
    if (label && !wasSpiralSkip && !result.ok) {
      const fingerprint = failureFingerprint(label, result);
      const prior = this.nearDuplicateFailures.get(fingerprint);
      const nextCount = prior && prior.revision === this.mutationRevision ? prior.count + 1 : 1;
      this.nearDuplicateFailures.set(fingerprint, { count: nextCount, revision: this.mutationRevision });
      if (nextCount >= NEAR_DUPLICATE_FAILURE_LIMIT) {
        const nudge = "Third failure with effectively the same command and identical error. Stop retrying variants. Change approach: read the file directly, use the dedicated grep/read tools, scope the command differently, or record the blocker and continue.";
        modelFacingResult = appendResultNudge(modelFacingResult, nudge);
        if (!this.nearDuplicateAdvisorySent.has(fingerprint)) {
          this.nearDuplicateAdvisorySent.add(fingerprint);
          await sink({ type: "status", message: nudge });
        }
      }
    }
    // Early build-hygiene nudges (PROMPT B2 items 3–4) — at WRITE time, not
    // report time, because a run that dies mid-work never reaches the
    // report gates (the audited run created 6 files and never built once).
    if (result.ok && toolResultMutatedFiles(toolName, result)) {
      // 3. Generated-project nudge: a NEW source file in an xcodegen/tuist
      // repo is invisible to the build until the generator reruns.
      if (!this.generatorNudgeSent) {
        if (this.cachedProjectGenerator === undefined) this.cachedProjectGenerator = detectProjectGenerator(workspace);
        const generator = this.cachedProjectGenerator;
        if (generator) {
          for (const file of result.files ?? []) {
            if (this.sentinelSeenFiles.has(file)) continue;
            this.sentinelSeenFiles.add(file);
            if (!generator.sourcePattern.test(file)) continue;
            if (await pathIsGitTracked(workspace, file)) continue; // existed before — not new
            this.generatorNudgeSent = true;
            modelFacingResult = appendResultNudge(
              modelFacingResult,
              `New source file in a ${generator.id}-generated project (${generator.marker} present): the build will NOT see ${file} until you run \`${generator.regenCommand}\`. Run it before the next build.`,
            );
            break;
          }
        }
      }
      // 4. First-build-early nudge: many source files changed and not one
      // build/verify has run — compile now, not after 800 more lines.
      if (!this.firstBuildNudgeSent && this.verificationEvents.length === 0) {
        const changedSourceCount = this.changedFiles.filter(isFreshnessRelevantSource).length;
        if (changedSourceCount > this.options.firstBuildNudgeAfter) {
          this.firstBuildNudgeSent = true;
          modelFacingResult = appendResultNudge(
            modelFacingResult,
            `You have changed ${changedSourceCount} source files without running any build or test yet. Run the project's build NOW before writing more code — compile errors found late cost the whole run.`,
          );
        }
      }
    }
    const rendered = truncateToolResultForModel({
      tool,
      result: modelFacingResult,
      workspace,
      runId,
      toolCallId: ctx.toolCallId,
      expandCallsRemaining: EXPAND_RESULT_LIMIT_PER_TURN - this.expandResultCallsThisTurn,
    });
    this.totalToolResultTokens += Math.ceil(JSON.stringify(rendered.modelResult).length / 4);
    host.pushToolMessage(ctx.toolCallId, JSON.stringify(rendered.modelResult));
    const reason = toolResultReason(result);
    const event = {
      type: "tool_result",
      id: ctx.toolCallId,
      tool: toolName,
      ok: result.ok,
      summary: rendered.modelResult.summary,
      output: rendered.modelResult.output,
      ...(reason ? { reason } : {}),
      ...(rendered.truncated ? { modelView: rendered.modelResult, verifierView: result } : {}),
    } as const;
    await sink(result.error ? { ...event, error: result.error } : event);
  }
}
