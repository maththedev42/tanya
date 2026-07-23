import type { EventSink } from "../events/types";
import { createSubAgentSink } from "../events/subAgentSink";
import type { TanyaRunContext } from "../context/runContext";
import type { FinalStateVerification, VerifierShell } from "./verifier";
import { isContextWindowExceededError, type ChatMessage, type ChatProvider, type ToolCall } from "../providers/types";
import {
  TOOL_CALL_CORRECTION_LIMIT,
  malformedToolCallCorrectionMessage,
  parseProviderToolCalls,
  parseToolArguments,
} from "../providers/parser";
import { resolveWorkspace } from "../safety/workspace";
import { decide, inputShape, type Decision, type PermissionContext } from "../safety/permissions/engine";
import type { HostPermissionAnswer, PermissionRequest, PermissionRequestHandler } from "../safety/permissions/host";
import { loadPermissionRules, mergeInheritedPermissionRules, stricterPermissionMode } from "../safety/permissions/rules";
import type { PermissionMode } from "../safety/permissions/schema";
import { ToolRegistry } from "../tools/registry";
import { type RepairAttemptSnapshot } from "../memory/repairRuns";
import { buildHistoryBlock, readRecentTaskHistory } from "../memory/taskHistory";
import { recordRunMemorySideEffects, writeRunArchive } from "./runLifecycle";
import { appendLedgerRecord } from "./runLedger";
import { ToolResultProcessor, toolCallMayMutate } from "./toolResultProcessor";
// Re-exported for existing importers (tests); the implementations moved to
// the shared run lifecycle module.
export { RUN_SUMMARY_MAX_FILES, rotateRunSummaryFiles } from "./runLifecycle";
import { envValue, numberEnvValue } from "../config/envCompat";
import {
  clampedIntFlag,
  offFlag,
  offablePositiveIntFlag,
  onFlag,
  optionalPositiveIntFlag,
  positiveIntFlag,
  ratioFlag,
} from "../config/runtimeFlags";
import { safeAppendArchive, toArchivedMessages } from "../memory/runArchive";
import { appendAuditDecision } from "../memory/auditLog";
import { estimateRunCost } from "../memory/runLogs";
import { FileReadDedupCache } from "../memory/fileReadDedup";
import { buildRepoMap } from "../context/repoMap";
import { appendReasoningChunk, evictReasoningFromArchive } from "../memory/reasoningArchive";
import { loadMcpToolsForWorkspace } from "../mcp/client";
import type { SubAgentTaskRequest, SubAgentTaskResult, TanyaTool } from "../tools/types";
import { SubAgentJobManager } from "../tools/subagentJobManager";
import { runWithExternalBackend } from "./externalRun";
import {
  classifyStep,
  contextWindowForTarget,
  EscalationExhaustedError,
  resolveRouteWithContextGuard,
  type EffectiveRouteTable,
  type ResolvedRoute,
  type RouteTarget,
  type StepType,
} from "../router";
import type { ValidationSummary } from "./validators";
import {
  autoCompact,
  clearOldToolResults,
  CompactionExhaustedError,
  estimateCompactTokens,
  microcompact,
  snipLowSignal,
  type CompactionAggression,
} from "./compact";
import {
  buildFallbackCodingReport,
  buildFinalManifest,
  ensureCodingReport,
  failedVerificationBlockers,
  hasRequiredCodingReport,
  isCodingTask,
} from "./report";
import { captureGitSnapshot, commitStillRequired, hasTrackedPathUnder, listFilesRecursive, type RepoUncommitted, uniqueSorted } from "./git";
import { clearExitSentinelHeartbeats, clearRunFailedMarker, registerExitSentinel, writeExitSentinel, writeRunFailedMarker, type ExitSentinelState } from "./exitSentinel";
import { interactiveTaskGatesArmed } from "./taskGating";
import type { GateReport } from "./gateReport";
import { recoveryPreflight } from "./runRecovery";
import { prependRecoveryBlock } from "./recoveryPrompt";
import type { CoverageItem, SpecRequirement } from "./specCoverage";
import { buildSystemPrompt } from "./systemPrompt";
import {
  applyTokenBudgetRule,
  childRunId,
  createRootRunId,
  mergeRunContexts,
  resolveSubAgentWorkspace,
  runIdDepth,
  type RunAgentParentContext,
} from "./subAgentContext";
import { AsyncSemaphore, BudgetLedger } from "./budgetLedger";
import { isLikelySubtaskCycle } from "./cycleDetect";
import { buildDriftNudge, buildDriftWrapUpDirective, buildWrapUpDirective, DRIFT_WRAP_UP_TURN, readOnlyDriftAction, resolveProgressBudget, shouldStopAfterBudget, wrapUpExpired, WRAP_UP_TURNS, type WrapUpState } from "./progressBudget";
import type { ChildVerdict, ReasoningAnnotation } from "./verifier/types";
import { existsSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const CONTEXT_TOKEN_LIMIT = 48_000;
const CONTEXT_SUMMARY_KEEP_RECENT = 6;
const permissionModes = new Set<PermissionMode>(["default", "ask", "bypass", "plan"]);
let sessionSpendTokens = 0;
let sessionSpendUsd = 0;
let sessionEscalations = 0;

// Cumulative prompt-token ceiling for a STALLED run. Per-turn context is already
// bounded by microcompaction (~48K), but a run that keeps re-sending a large
// context while making no progress can still balloon to millions of tokens
// before the turn-based stall stop fires at the soft-budget floor (the 2026-05-09
// ~6M-token runs that ended blocked). Once a run is stalled (no progress for 2+
// turns) AND has spent more than this many prompt tokens, stop now instead of
// grinding to the turn ceiling. Productive runs (still making progress) never hit
// this. Tunable via TANYA_MAX_STALL_TOKENS; 0/off disables.
function stallTokenCeiling(): number {
  return offablePositiveIntFlag("TANYA_MAX_STALL_TOKENS", 1_500_000);
}

// Optional absolute turn ceiling for extended (interactive) runs. Unset means
// UNBOUNDED: a run that keeps making progress keeps going — a task never fails
// just because it is long. Stall detection (no-progress stop past the soft
// budget + the token-runaway backstop above) is what ends a bad run, not a
// step count. Set TANYA_HARD_TURN_CEILING to restore a fixed ceiling.
function hardTurnCeilingFromEnv(): number | undefined {
  return optionalPositiveIntFlag("TANYA_HARD_TURN_CEILING");
}

export type TanyaFinalManifest = {
  schemaVersion: 1;
  changedFiles: string[];
  uncommittedFiles: string[];
  artifactsRead: string[];
  artifactsCreated: string[];
  contextFilesRead: string[];
  verification: string[];
  git: {
    root: string | null;
    head: string | null;
  };
  toolErrors: number;
  blockers: string[];
  childRunIds?: string[];
  childVerdicts?: ChildVerdict[];
  childWarnings?: string[];
  reasoningAnnotations?: ReasoningAnnotation[];
  validation?: ValidationSummary;
  finalStateVerification?: FinalStateVerification;
  // Why the run ended early, when it did. "turn_budget_exhausted" marks a
  // stall stop (no-progress or token backstop) — hosts use it to auto-continue.
  terminationReason?: string;
  // The run's id, when known at manifest-build time. Lets the FAIL report
  // point at `tanya doctor --run <id>` from ensureCodingReport.
  runId?: string;
  // External backend that performed the work, when the run was driven by
  // `tanya run --backend <cli>` rather than Tanya's own agent loop. Absent
  // when Tanya itself performed the work (or for runs predating this field).
  backend?: string;
  // Definition-of-done runtime gate: behaviour was never exercised at runtime.
  // Advisory only — it drives a one-shot nudge to run `tanya test-app`, and
  // NEVER gates the verdict (a real runtime failure is a blocker instead).
  runtimeUnverified?: boolean;
  runtimeUnverifiedReason?: string;
  // Files the run wrote that are still uncommitted, grouped by repo root (incl.
  // nested repos). Set by the commit-completeness gate; a non-empty value has a
  // matching "Commit incomplete: …" blocker, so it also forces FAIL.
  uncommittedSessionFiles?: RepoUncommitted[];
  // Deliverable sections parsed from the task prompt (## Part N, ### G1, …). Set
  // in buildFinalManifest when the prompt has ≥2; the report accounts for each.
  specRequirements?: SpecRequirement[];
  // Per-requirement coverage (done/skipped/pending) assessed against the final
  // report. A pending item forces FAIL via a matching "Spec coverage …" blocker.
  specCoverage?: CoverageItem[];
  // `git log --stat` of the commits this run created (SHAs + files touched), so
  // the report shows what actually landed. Empty/absent when HEAD did not move.
  commitSummary?: string;
  // HEAD at run start — baseline for the deleted-analytics reachability check.
  sessionBaseHead?: string;
  // Human-readable breadcrumbs of which gates armed and how they voted, so a
  // forensic starts from data (present in the manifest JSON), not inference.
  gateLog?: string[];
  // Structured, machine-readable gate verdicts (armed/reason + per-gate status
  // and evidence) persisted into the run archive so an external audit is a
  // lookup, not a git reverse-engineer. Observability only; see gateReport.ts.
  gates?: GateReport;
  // True when this (serve) process is running an older build than the one now on
  // disk — a mid-session upgrade. Non-gating nudge; see buildInfo.ts.
  binaryStale?: boolean;
  // Distinct git repo roots this run wrote into. Used to drop archive-pointer
  // files so a run driven from a workspace root is discoverable from each
  // touched repo's .tanya/runs/ (see runArchivePointer.ts).
  touchedRepos?: string[];
  // Baseline-aware verification notes (Go-first): a `failed verification:`
  // blocker that was reclassified as pre-existing (worktree-verified against
  // the session's starting commit) is removed from `blockers` and its honest
  // explanation lands here instead — visible in the report without silently
  // erasing that a test is red. See report.ts reclassifyPreExistingGoTestFailures.
  baselineNotes?: string[];
  // Non-gating nudges from the honesty gates (artifact hygiene, deferral
  // citations, prerequisite downgrades). Rendered as `Note:` lines in the
  // deterministic footer; never blockers, so they can never flip the verdict.
  reportNudges?: string[];
};

export type RunAgentResult = {
  message: string;
  manifest: TanyaFinalManifest;
  metrics?: FinalMetrics;
};

export type FinalMetrics = {
  durationMs: number;
  toolCallCount: number;
  toolErrorCount: number;
  changedFileCount: number;
  repairAttemptCount: number;
  retryAttemptCount: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedPromptTokens: number;
  costUsd: number;
  systemPromptTokens: number;
  repoMapTokens: number;
  toolResultTokens: number;
};

export interface RunAgentOptions {
  provider: ChatProvider;
  prompt: string;
  cwd: string;
  sink: EventSink;
  maxTurns?: number;
  // Opt in to progress-aware budget extension: a productive run may continue
  // past maxTurns up to a hard ceiling while it keeps making progress. Off by
  // default so explicit caps (eval, sub-agents, --max-turns) stay exact.
  extendBudgetOnProgress?: boolean;
  // Interactive chat mode. Verification, validation-repair, and the
  // forbidden-pattern scan still run, but the CLI-batch surface is suppressed:
  // no commit-required gating, no machine `Verification: -> ` report format on
  // the user-facing reply, and a friendly (not alarming) budget-reached message.
  interactive?: boolean;
  // Pre-built system prompt to use verbatim instead of building one from the
  // current prompt/run-context. Multi-turn hosts (serve) pass a session-pinned
  // prompt so the conversation prefix stays byte-identical across turns —
  // provider prefix caches (DeepSeek bills cache hits at ~1/100th the fresh
  // rate) only hit on identical bytes, and a prompt-dependent system message
  // re-bills the entire conversation every turn.
  systemPromptOverride?: string;
  history?: ChatMessage[];
  runContext?: TanyaRunContext;
  parentContext?: RunAgentParentContext;
  runId?: string;
  repairAttempts?: number;
  retryAttempt?: number;
  signal?: AbortSignal;
  onPermissionRequest?: PermissionRequestHandler;
  verifierShell?: VerifierShell | undefined;
  routing?: {
    enabled: boolean;
    table: EffectiveRouteTable;
    providerFactory: (target: RouteTarget) => ChatProvider;
  };
}

function findSafeCompressionBoundary(messages: ChatMessage[], desiredKeepCount: number): number {
  if (messages.length <= desiredKeepCount + 1) return Math.max(1, messages.length - desiredKeepCount);
  let startIndex = messages.length - desiredKeepCount;
  // Cap how many leading tool messages we'll walk past — a runaway loop of
  // back-to-back tool results without an assistant tool_calls header indicates
  // a corrupt history; in that case fall back to the original boundary.
  const maxWalk = Math.min(8, messages.length - startIndex);
  let walked = 0;
  while (startIndex < messages.length && messages[startIndex]?.role === "tool" && walked < maxWalk) {
    const prev = messages[startIndex - 1];
    if (prev?.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0) {
      startIndex -= 1;
      break;
    }
    startIndex += 1;
    walked += 1;
  }
  if (startIndex >= messages.length) return messages.length - 1;
  return Math.max(1, startIndex);
}

function fieldMatchesType(value: unknown, expectedType: string): boolean {
  if (expectedType === "array") return Array.isArray(value);
  return typeof value === expectedType;
}

function validateToolInput(
  input: unknown,
  definition: { function: { parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } } },
): string | null {
  const params = definition.function.parameters;
  if (!params) return null;
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const key of params.required ?? []) {
    if (!(key in record) || record[key] === undefined || record[key] === null) {
      return `Missing required field: "${key}"`;
    }
    const expectedType = params.properties?.[key]?.type;
    if (expectedType && !fieldMatchesType(record[key], expectedType)) {
      const actualType = Array.isArray(record[key]) ? "array" : typeof record[key];
      return `Field "${key}" must be ${expectedType}, got ${actualType}`;
    }
  }
  return null;
}

function materializedContextCleanupEnabled(manifest: TanyaFinalManifest, runContext?: TanyaRunContext): boolean {
  const metadata = runContext?.metadata ?? {};
  if (metadata.tanyaMaterializedContext !== true) return false;
  if (metadata.keepMaterializedContext === true) return false;
  if (manifest.blockers.length > 0) return false;
  if (manifest.validation && !manifest.validation.passed) return false;
  return true;
}

async function cleanupMaterializedContext(workspace: string, manifest: TanyaFinalManifest, runContext?: TanyaRunContext): Promise<void> {
  if (!materializedContextCleanupEnabled(manifest, runContext)) return;
  const tanyaDir = resolve(workspace, ".tanya");
  if (!existsSync(tanyaDir)) return;
  if (await hasTrackedPathUnder(workspace, ".tanya")) return;
  try {
    await rm(tanyaDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; successful task output should not fail because temp cleanup failed.
  }
}

function buildFinalReportReminder(changedFiles: string[], toolErrorCount: number): string {
  return [
    "You must now stop using tools and produce the final coding report.",
    "Use the caller's required final report format.",
    "Include either `Artifact reused: <artifact-path> -> <target-path>` for adapted artifacts or exactly `Artifact reused: none`.",
    "Include either `Artifact created: <artifact-path> -> reusable artifact` for reusable artifacts created or exactly `Artifact created: none`.",
    "Include one `Verification: <command> -> <result>` line for every verification command you ran.",
    "Include one plain `Artifact reused: <artifact-path> -> <target-path>` line for every artifact you adapted.",
    "Only attribute files directly adapted from an artifact; do not list unrelated config, formatter-only files, generated icons, or source files under an artifact just because the artifact was read.",
    changedFiles.length > 0
      ? "Include one `Modified: <path>` line for every changed file."
      : "If no files needed changes because the existing setup already satisfied the task, include exactly: `Verification-only: existing setup satisfied`.",
    "Do not create or keep backup files such as `.orig`, `.bak`, `.backup`, or `.tmp`.",
    toolErrorCount > 0
      ? `Mention the ${toolErrorCount} tool error${toolErrorCount === 1 ? "" : "s"} as recovered issues if later verification passed; only list active blockers under Blocked.`
      : "If there are no blockers, say so briefly.",
    "Do not call more tools unless the final report is impossible without one specific missing fact.",
  ].join("\n");
}

export function buildCommitRequiredReminder(manifest: TanyaFinalManifest): string {
  const uncommitted = manifest.uncommittedFiles.length > 0 ? manifest.uncommittedFiles : manifest.changedFiles;
  return [
    manifest.uncommittedFiles.length > 0
      ? "The caller requires a git commit, and there are still in-scope changed files that are not included in the task commit."
      : "You changed files and the caller requires a git commit, but HEAD has not changed yet.",
    "Do not produce the final report until the commit is created.",
    manifest.git.head
      ? "Call `commit_platform_changes` with `amend: true` to add the remaining in-scope files to the existing task commit."
      : "Call `commit_platform_changes` now with the in-scope changed files and the exact required commit-message prefix from the prompt.",
    "Files you CREATED this run are untracked — git only commits them after an explicit `git add` / inclusion in commit_platform_changes `files`. Check `git status --porcelain` for `??` entries before reporting done.",
    `Files that must be committed: ${uncommitted.join(", ") || "none"}`,
    "After the commit succeeds, run `git rev-parse --short HEAD`, then produce the final report.",
  ].join("\n");
}

function inScopeUncommitted(manifest: TanyaFinalManifest): string[] {
  return manifest.uncommittedFiles.length > 0 ? manifest.uncommittedFiles : manifest.changedFiles;
}

// FIX 3: the commit gate's repair attempts are spent but files are still
// uncommitted. Record a blocker so the verdict cannot read as a clean pass, and
// return the required lead block the report must START with.
function markCommitIncomplete(manifest: TanyaFinalManifest): string {
  const files = inScopeUncommitted(manifest);
  manifest.blockers = uniqueSorted([
    ...manifest.blockers,
    `Commit incomplete: in-scope files from this run are not in any commit (${files.join(", ")}).`,
  ]);
  return ["⚠ COMMIT INCOMPLETE — these in-scope files are not in any commit:", ...files.map((file) => `- ${file}`)].join("\n");
}

// FIX 2: interactive sessions get a single warning line instead of a hard
// repair loop. Only this run's uncommitted files, never pre-existing dirt (the
// manifest's uncommittedFiles are already scoped to this run's changes).
function interactiveCommitWarning(manifest: TanyaFinalManifest): string {
  if (manifest.uncommittedFiles.length === 0) return "";
  return `⚠ Uncommitted changes from this task: ${manifest.uncommittedFiles.join(", ")} — commit them or say they're intentionally left dirty.`;
}

function buildRuntimeVerifyReminder(manifest: TanyaFinalManifest): string {
  const behaviors = manifest.runtimeUnverifiedReason?.trim();
  return [
    "The code builds, but the running app's behaviour has not been verified yet — and \"it compiled\" is not \"it works\".",
    behaviors
      ? `Verify these against the RUNNING app, not just that it compiles: ${behaviors}`
      : "Verify the app's actual behaviour against the RUNNING app, not just that it compiles.",
    "Run `tanya test-app --tier1` — it boots the app and taps real buttons to check actual results (e.g. that 2 + 2 shows 4, not 22 or \\(n)).",
    "If it reports issues, fix them in code and re-run until TANYA RESULT: PASSED, then produce the final report.",
    "If this host cannot run the app (no simulator/SDK), the command reports SKIPPED — that is fine; note it and proceed to the final report.",
  ].join("\n");
}

function buildValidationRepairReminder(manifest: TanyaFinalManifest, attempt: number, maxAttempts: number): string {
  const issues = manifest.validation?.issues ?? [];
  const issueLines = issues.length > 0
    ? issues.map((issue) => `- ${issue.id}: ${issue.message}${issue.files?.length ? ` (${issue.files.join(", ")})` : ""}`)
    : ["- validation failed without detailed issues"];
  const blockerLines = manifest.blockers.length > 0
    ? manifest.blockers.map((blocker) => `- ${blocker}`)
    : [];
  const repairHints: string[] = [];
  const issueIds = new Set(issues.map((issue) => issue.id));
  if (issueIds.has("apple-app-icon-xcodebuild-missing")) {
    repairHints.push("For Apple app icon verification, run a direct `xcodebuild build` command with an available scheme and a concrete or generic simulator destination. Report the exact command only after it passes.");
  }
  if (manifest.blockers.some((blocker) => /^behavior failed:/i.test(blocker))) {
    repairHints.push("The running app failed a runtime behaviour check. Run `tanya test-app --tier1`, fix the reported UI/logic issues in code, and re-run until TANYA RESULT: PASSED.");
  }
  if (manifest.blockers.some((blocker) => /failed verification:/i.test(blocker))) {
    repairHints.push("Resolve every failed verification with a later passing rerun of the same check, or keep the task blocked and do not claim completion.");
  }
  if (issueIds.has("core-verification-requested-command-missing")) {
    repairHints.push("Run every missing requested verification command exactly as named in the issue message. Do not substitute file-existence probes, package-lock checks, or equivalent commands for required commands such as `npm install`.");
  }
  if (issueIds.has("core-artifact-provenance-missing")) {
    repairHints.push("READ at least one caller-provided artifact NOW using read_file on a path under .tanya/artifacts/, then report it as `Artifact reused: <artifact-path> -> <target-file-or-verification-only>`. This applies even when the existing setup is already complete: pick one artifact under .tanya/artifacts/ and read it to confirm the canonical pattern, then report the line.");
  }
  if (issueIds.has("android-gradle-assembledebug-missing")) {
    repairHints.push("For Android Gradle verification, run `./gradlew assembleDebug --no-daemon` from the Android workspace root and report it only after it exits successfully.");
  }
  if (issueIds.has("android-gradle-ktlintcheck-missing")) {
    repairHints.push("For Android ktlint verification, run `./gradlew ktlintCheck --no-daemon` from the Android workspace root and report it only after it exits successfully.");
  }
  if (issueIds.has("ios-splash-solid-background-violated")) {
    repairHints.push("For iOS splash solid-background violations, remove LinearGradient/RadialGradient/AngularGradient and use a single explicit brand Color value.");
  }
  if (issueIds.has("ios-splash-text-forbidden")) {
    repairHints.push("For iOS splash text-forbidden violations, remove all Text(...) views, taglines, labels, and captions from SplashScreenView.swift.");
  }
  if (issueIds.has("ios-splash-extra-animation")) {
    repairHints.push("For iOS splash extra-animation violations, keep only the brief icon fade-in; remove pulse, scale, rotation, shimmer, and repeatForever animations.");
  }
  if (issueIds.has("ios-splash-icon-image")) {
    repairHints.push("For iOS splash icon-image violations, render Image(\"SplashIcon\") from SplashIcon.imageset instead of app names, SF Symbols, or remote images.");
  }
  if ([...issueIds].some((id) => /onboarding-final-cta-slide-missing/.test(id))) {
    repairHints.push("For onboarding CTA violations, make the final pager page a dedicated CTA slide with `Começar grátis` and `Já tenho conta`; do not use a normal feature slide with CTA buttons only in the footer.");
  }
  if ([...issueIds].some((id) => /onboarding-skip-not-top-right/.test(id))) {
    repairHints.push("For onboarding skip placement violations, move `Pular` into a top-right overlay aligned to the safe area and hide it on the final CTA slide.");
  }
  if ([...issueIds].some((id) => /onboarding-storage-key-missing/.test(id))) {
    repairHints.push("For onboarding persistence violations, use the exact completion key `hasSeenOnboarding` in UserDefaults/AppStorage or DataStore.");
  }
  if (issueIds.has("android-base-layout-feature-missing")) {
    repairHints.push("For Android base layout feature coverage, derive the tabs/routes from every named feature in the prompt. Do not use generic buckets like Settings unless Settings is explicitly one of the requested app features.");
  }
  if (issueIds.has("android-base-layout-premium-gate-missing")) {
    repairHints.push("For Android premium feature coverage, wrap premium feature placeholder content with PremiumGate or an equivalent entitlement-state gate. Premium placeholders can show locked/paywall states until RevenueCat is fully configured.");
  }
  return [
    `Tanya validation found task-specific problems before finalization. Repair attempt ${attempt} of ${maxAttempts}.`,
    "Fix the implementation directly, rerun the relevant verification commands, then produce the required final report.",
    "If you already created a task commit before this validation repair, amend that task commit after fixing the files instead of creating a second task commit.",
    "Use `commit_platform_changes` with `amend: true` when amending is needed.",
    "",
    "Validation issues:",
    ...issueLines,
    ...(blockerLines.length > 0 ? ["", "Blocking verification failures:", ...blockerLines] : []),
    ...(repairHints.length > 0 ? ["", "Targeted repair instructions:", ...repairHints.map((hint) => `- ${hint}`)] : []),
    "",
    "Current changed files:",
    manifest.changedFiles.length > 0 ? manifest.changedFiles.map((file) => `- ${file}`).join("\n") : "- none",
  ].join("\n");
}

function validationRepairSignature(manifest: TanyaFinalManifest): string {
  const issueIds = manifest.validation?.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.id}:${issue.files?.join(",") ?? ""}`) ?? [];
  return [...issueIds, ...manifest.blockers].sort().join("|") || "unknown-validation-failure";
}

function pruneStaleRepairReminders(messages: ChatMessage[]): ChatMessage[] {
  const isRepairReminder = (msg: ChatMessage | undefined): boolean => {
    if (!msg) return false;
    if (msg.role !== "user") return false;
    if (typeof msg.content !== "string") return false;
    return /Tanya validation found task-specific problems before finalization\. Repair attempt/i.test(msg.content);
  };
  let lastIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (isRepairReminder(messages[i])) lastIndex = i;
  }
  if (lastIndex === -1) return messages;
  return messages.filter((msg, idx) => idx === lastIndex || !isRepairReminder(msg));
}

function isTypeScriptProject(workspace: string): boolean {
  return existsSync(join(workspace, "tsconfig.json"));
}

export function repairAttemptBudget(options: RunAgentOptions, interactiveTaskArmed = false): number {
  const configured = typeof options.runContext?.metadata?.repairAttempts === "number"
    ? options.runContext.metadata.repairAttempts
    : typeof options.runContext?.metadata?.repairAttempts === "string"
      ? Number(options.runContext.metadata.repairAttempts)
      : options.repairAttempts;
  if (typeof configured === "number" && Number.isFinite(configured)) return Math.max(0, Math.min(5, Math.floor(configured)));
  // Interactive task-shaped runs (the mac app dispatches everything
  // interactive) get the same repair budget as pipeline coding tasks: the
  // gates already arm for them, and a gate that fires without a repair
  // budget just finalizes FAIL on top of the broken tree.
  if (!isCodingTask(options.runContext) && !interactiveTaskArmed) return 0;
  return isTypeScriptProject(options.cwd) ? 3 : 2;
}

function repairAttemptSnapshot(attempt: number, manifest: TanyaFinalManifest): RepairAttemptSnapshot {
  return {
    attempt,
    issueIds: manifest.validation?.issues.filter((issue) => issue.severity === "error").map((issue) => issue.id).sort() ?? [],
    blockerCount: manifest.blockers.length,
    changedFileCount: manifest.changedFiles.length,
  };
}

function requiredHighLevelTool(runContext: TanyaRunContext | undefined, prompt = ""): string | null {
  const includeRawPrompt = runContext?.metadata?.caller === "cosmochat";
  const text = [
    includeRawPrompt ? prompt : "",
    runContext?.task?.title,
    runContext?.task?.summary,
    ...(runContext?.instructions ?? []),
  ].filter(Boolean).join("\n").toLowerCase();
  if (/\b(?:android\s+foundation|foundation\s+(?:—|-|for)\s+android|fundações\s+(?:—|-)\s+android|build android foundation)\b/.test(text)) {
    return "create_android_foundation";
  }
  if (/\b(?:ios\s+splash|splash\s+screen\s+(?:—|-|for)\s+ios|splash\s+screen.*\bios\b|create the splash screen.*\bios\b)\b/.test(text)) {
    return "create_ios_splash";
  }
  return null;
}

function resolvePermissionMode(loadedMode: PermissionMode): PermissionMode {
  const rawMode = envValue(process.env, "TANYA_MODE")?.trim();
  return rawMode && permissionModes.has(rawMode as PermissionMode) ? rawMode as PermissionMode : loadedMode;
}

function permissionEventSource(decision: Decision, mode: PermissionMode): "rule" | "engine" | "bypass" {
  if (mode === "bypass" && decision.decision === "allow" && decision.reason === "bypass-mode") return "bypass";
  return decision.matchedRule ? "rule" : "engine";
}

function auditPermissionDecision(workspace: string, context: PermissionContext, tool: string, input: unknown, decision: Decision, source: "user" | "rule" | "engine" | "bypass"): void {
  const auditSource = mcpAuditSource(tool) ?? source;
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool,
    input,
    decision: decision.decision,
    source: auditSource,
    mode: context.mode,
    ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.projectedCostUsd !== undefined ? { projectedCostUsd: decision.projectedCostUsd } : {}),
    ...(decision.projectedTokens !== undefined ? { projectedTokens: decision.projectedTokens } : {}),
    ...(decision.thresholdUsd !== undefined ? { thresholdUsd: decision.thresholdUsd } : {}),
    ...(decision.thresholdTokens !== undefined ? { thresholdTokens: decision.thresholdTokens } : {}),
  });
}

function mcpAuditSource(tool: string): `mcp:${string}` | null {
  if (!tool.startsWith("mcp:")) return null;
  const [, server] = tool.split(":");
  return server ? `mcp:${server}` : "mcp:unknown";
}

function providerKey(provider: ChatProvider): string {
  return `${provider.id}/${provider.model}`;
}

function auditModelRouted(workspace: string, context: PermissionContext, event: {
  stepType: StepType;
  provider: string;
  model: string;
  reason: string;
  cacheImpact?: "hit" | "miss" | "unknown";
}): void {
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool: "model_routed",
    input: event,
    decision: "allow",
    source: "engine",
    mode: context.mode,
    reason: event.reason,
  });
}

function forcedRouteFromRunContext(runContext: TanyaRunContext | undefined): RouteTarget | null {
  const metadata = runContext?.metadata;
  if (!metadata) return null;
  const forcedModel = stringMetadata(metadata, "forced_model") ?? stringMetadata(metadata, "forcedModel");
  const forcedProvider = stringMetadata(metadata, "forced_cli") ??
    stringMetadata(metadata, "forcedCli") ??
    stringMetadata(metadata, "forced_provider") ??
    stringMetadata(metadata, "forcedProvider");
  if (!forcedModel && !forcedProvider) return null;
  if (forcedModel?.includes("/") && !forcedProvider) {
    const [provider, model] = forcedModel.split("/", 2);
    if (provider?.trim() && model?.trim()) return { provider: provider.trim(), model: model.trim() };
  }
  const provider = forcedProvider ?? inferForcedProvider(forcedModel ?? "");
  if (!provider || !forcedModel) return null;
  return { provider, model: forcedModel };
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferForcedProvider(model: string): string | null {
  if (/^deepseek-/i.test(model)) return "deepseek";
  if (/^(?:gpt-|o\d|o\d-|chatgpt)/i.test(model)) return "openai";
  if (/^claude-/i.test(model)) return "claude";
  if (/^gemini-/i.test(model)) return "gemini";
  if (/^qwen/i.test(model)) return "qwen";
  return null;
}

function auditEscalation(workspace: string, context: PermissionContext, event: {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  reason: "parse_failure" | "schema_failure" | "context_too_small";
  stepType: StepType;
}): void {
  appendAuditDecision(workspace, {
    ts: new Date().toISOString(),
    runId: context.runId,
    ...(context.parentContext?.runId ? { parentRunId: context.parentContext.runId } : {}),
    tool: "escalation_event",
    input: event,
    decision: "allow",
    source: "engine",
    mode: context.mode,
    reason: event.reason,
  });
}

function buildNetworkFallbackReminder(): string {
  return [
    "Network or dependency operations failed twice.",
    "Stop retrying the same live network/install path in this run.",
    "Scaffold a local mock fallback so the task can complete:",
    "- include deterministic sample data or a mock response path",
    "- keep the real network code path when practical",
    "- document mock versus live behavior and the network/dependency limitation in README.md",
    "Then run a local verification command that does not require the unavailable network path.",
  ].join("\n");
}

function deniedPermissionResult(decision: Decision, fallback = "permission denied"): {
  ok: false;
  summary: string;
  error: string;
  output: { ok: false; error: string; rule?: string; reason?: string };
} {
  const matched = decision.matchedRule ?? decision.reason;
  const error = matched ? `denied by rule: ${matched}` : fallback;
  return {
    ok: false,
    summary: error,
    error,
    output: {
      ok: false,
      error,
      ...(decision.matchedRule ? { rule: decision.matchedRule } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    },
  };
}

function permissionCacheKey(tool: string, input: unknown): string {
  return `${tool}:${inputShape(input)}`;
}

function permissionRequestFromDecision(id: string, tool: string, input: unknown, decision: Decision): PermissionRequest {
  return {
    id,
    tool,
    input,
    ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    ...(decision.projectedCostUsd !== undefined ? { projectedCostUsd: decision.projectedCostUsd } : {}),
    ...(decision.projectedTokens !== undefined ? { projectedTokens: decision.projectedTokens } : {}),
  };
}

function projectedToolSpend(input: unknown, provider: ChatProvider): { projectedTokens: number; projectedUsd: number } {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const projectedTokens = numberField(record, "projectedTokens") ??
    numberField(record, "estimatedTokens") ??
    numberField(record, "estimatedOutputTokens") ??
    0;
  const explicitUsd = numberField(record, "projectedCostUsd") ?? numberField(record, "estimatedCostUsd");
  const projectedUsd = explicitUsd ?? (
    projectedTokens > 0
      ? estimateRunCost({
        provider: provider.id,
        model: provider.model,
        promptTokens: 0,
        completionTokens: projectedTokens,
      }).usd ?? 0
      : 0
  );
  return { projectedTokens, projectedUsd };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function promptBudgetRatio(): number {
  return ratioFlag("TANYA_PROMPT_BUDGET_RATIO", 0.25);
}

function subtaskMaxParallel(): number {
  return clampedIntFlag("TANYA_SUBTASK_MAX_PARALLEL", 3, 1);
}

function subtaskCycleCheckEnabled(): boolean {
  return offFlag("TANYA_SUBTASK_CYCLE_CHECK");
}

function escalationCap(): number {
  return clampedIntFlag("TANYA_ESCALATION_CAP", 5, 0);
}

// reasoningCapForTurn picks the per-turn reasoning-token budget. An explicit
// per-route reasoningCap always wins. Otherwise the budget falls back to two
// env-configurable tiers — short (planning / tool_call / unknown) and long
// (synthesis / verification / reasoning) — so heavier reasoning models can be
// given more headroom without hand-writing a full routes.json route table.
export function reasoningCapForTurn(stepType: StepType, route?: ResolvedRoute): number {
  if (route?.reasoningCap?.maxTokens) return route.reasoningCap.maxTokens;
  const shortCap = clampedIntFlag("TANYA_REASONING_CAP_SHORT", 2_000, 1);
  const longCap = clampedIntFlag("TANYA_REASONING_CAP_LONG", 8_000, 1);
  return stepType === "planning" || stepType === "tool_call" || stepType === "unknown" ? shortCap : longCap;
}

// Build the system prompt a multi-turn host should pin for a whole session.
// Deliberately prompt- and run-context-independent: everything task-specific
// (artifact index hints, DoD block, repo-map ranking) is either generic here or
// delivered at runtime by the runner's own nudges, so the bytes never change
// between turns and the provider's prefix cache covers the full conversation.
export async function buildSessionSystemPrompt(cwd: string, provider?: ChatProvider): Promise<string> {
  const workspace = resolveWorkspace(cwd);
  const historyBlock = buildHistoryBlock(await readRecentTaskHistory(workspace));
  const litePrompt = onFlag("TANYA_LITE_PROMPT");
  if (litePrompt) {
    try {
      await buildRepoMap(workspace, { writeCache: true });
    } catch {
      // Repo-map is advisory context. Indexing failures should not block a session.
    }
  }
  return buildSystemPrompt(workspace, undefined, historyBlock, "", {
    lite: litePrompt,
    ...(provider?.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    promptBudgetRatio: promptBudgetRatio(),
    subagentToolsEnabled: false, // init prompt never orchestrates
  });
}

// Thin wrapper so the exit sentinel sees EVERY way out of a run. The core can
// exit via return (normal finalize, which archives), via a thrown exception
// (provider failure past retries, tool crash, sink error), or via a
// terminating signal (registered inside the core). The wrapper owns the
// exception path: it stamps the reason and writes the minimal aborted-run
// archive before re-throwing, so a run that dies mid-work always leaves a
// trace in .tanya/runs/ — the audited failure left none.
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const sentinelBox: { state?: ExitSentinelState } = {};
  try {
    return await runAgentCore(options, sentinelBox);
  } catch (err) {
    if (sentinelBox.state && !sentinelBox.state.archived) {
      sentinelBox.state.terminationReason = `exception: ${err instanceof Error ? err.message : String(err)}`;
      writeExitSentinel(sentinelBox.state);
    }
    throw err;
  } finally {
    if (sentinelBox.state) {
      clearExitSentinelHeartbeats(sentinelBox.state);
      sentinelBox.state.unregister();
    }
  }
}

async function runAgentCore(options: RunAgentOptions, sentinelBox: { state?: ExitSentinelState }): Promise<RunAgentResult> {
  const parentContext = options.parentContext;
  const workspace = parentContext
    ? resolveSubAgentWorkspace(parentContext.workspace, options.cwd)
    : resolveWorkspace(options.cwd);

  // ── Recovery preflight ──────────────────────────────────────────────────
  // If the last run in this workspace FAILed (LAST_RUN_FAILED.md marker),
  // call the doctor and prepend a RECOVERY block to the task prompt so the
  // agent stabilizes the tree BEFORE executing the actual task.
  const recovery = recoveryPreflight(workspace, {
    sink: options.sink,
    ...(options.runContext ? { runContext: options.runContext } : {}),
  });
  if (recovery) {
    options.prompt = prependRecoveryBlock(recovery.recoveryBlock, options.prompt);
  }
  // This run's recovery-attempt number (1 = first recovery of an earlier
  // FAIL). Recorded on the FAIL marker so the next preflight can brake a
  // non-converging recovery loop instead of grinding a 3rd full attempt.
  const recoveryAttemptNumber = recovery ? recovery.attempts + 1 : 0;
  // ─────────────────────────────────────────────────────────────────────────

  if (parentContext) {
    const mergedRunContext = mergeRunContexts(parentContext.runContext, options.runContext);
    if (mergedRunContext) options.runContext = mergedRunContext;
    options.history = [...(parentContext.history ?? []), ...(options.history ?? [])];
  }
  const beforeGitSnapshot = await captureGitSnapshot(workspace);
  const registry = new ToolRegistry();
  await loadMcpToolsForWorkspace({ cwd: workspace, registry, sink: options.sink });
  const runStartedAt = new Date();
  const startedAt = runStartedAt.getTime();
  const runId = options.runId ?? (parentContext
    ? childRunId(parentContext.runId, parentContext.childIndex ?? 1)
    : createRootRunId(runStartedAt));
  const loadedPermissions = loadPermissionRules({ cwd: workspace });
  const inheritedPermissions = parentContext
    ? mergeInheritedPermissionRules(parentContext.permissionContext.rules, loadedPermissions.rules)
    : { rules: loadedPermissions.rules, warnings: [] };
  const rulesWithBudget = applyTokenBudgetRule(inheritedPermissions.rules, parentContext?.tokenBudget);
  const localMode = resolvePermissionMode(rulesWithBudget.mode);
  const permissionMode = parentContext
    ? stricterPermissionMode(parentContext.permissionContext.mode, localMode)
    : localMode;
  const permissionContext: PermissionContext = {
    mode: permissionMode,
    rules: { ...rulesWithBudget, mode: permissionMode },
    runId,
    cwd: workspace,
    ...(parentContext ? { parentContext: parentContext.permissionContext } : {}),
  };
  for (const warning of inheritedPermissions.warnings) {
    await options.sink({ type: "status", message: `Sub-agent permission inheritance warning: ${warning.reason}` });
  }
  const fileReadDedup = new FileReadDedupCache(workspace);
  // Archive append failures (permission denied, ENOSPC, EBUSY) must surface as
  // a warn through the run's event sink — silent drops produce gaps in the
  // audit trail that only show up later when readArchive returns less than
  // expected. They must NOT crash the run loop.
  const archiveErrorSink = async (err: Error) => {
    await options.sink({
      type: "status",
      message: `[warn] archive append failed: ${err.message}`,
    });
  };
  const appendRunArchive = (messagesToArchive: ChatMessage[]) =>
    safeAppendArchive(runId, toArchivedMessages(messagesToArchive), { workspace }, archiveErrorSink);
  const permissionAnswers = new Map<string, { answer: HostPermissionAnswer; source: "user" | "engine" }>();
  const changedFiles: string[] = [];
  let toolCallCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let totalCachedPromptTokens = 0;
  let runSpendTokens = 0;
  let runSpendUsd = 0;
  let activeProvider = options.provider;
  let lastProviderKey = providerKey(activeProvider);
  if (options.routing?.enabled) {
    try {
      const forcedRoute = forcedRouteFromRunContext(options.runContext);
      const initialRoute = resolveRouteWithContextGuard({
        stepType: "planning",
        table: options.routing.table,
        messages: [...(options.history ?? []), { role: "user", content: options.prompt }],
        ...(forcedRoute ? { forcedRoute } : {}),
      });
      activeProvider = options.routing.providerFactory(initialRoute);
      lastProviderKey = providerKey(activeProvider);
    } catch {
      activeProvider = options.provider;
      lastProviderKey = providerKey(activeProvider);
    }
  }
  const promptBudgetEvents: Array<{ droppedSections: string[]; totalTokens: number; cap: number }> = [];
  let repoMapTokens = 0;
  let systemPrompt: string;
  if (options.systemPromptOverride !== undefined) {
    systemPrompt = options.systemPromptOverride;
  } else {
    const historyBlock = buildHistoryBlock(await readRecentTaskHistory(workspace));
    const litePrompt = onFlag("TANYA_LITE_PROMPT");
    if (litePrompt) {
      try {
        await buildRepoMap(workspace, { writeCache: true });
      } catch {
        // Repo-map is advisory context. Indexing failures should not block a run.
      }
    }
    const subagentDepth = runIdDepth(runId);
    const subagentDepthLimitRaw = envValue(process.env, "TANYA_SUBAGENT_DEPTH").trim();
    const subagentDepthLimit = (() => {
      if (!subagentDepthLimitRaw) return 1;
      const parsed = Number(subagentDepthLimitRaw);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
    })();
    systemPrompt = buildSystemPrompt(workspace, options.runContext, historyBlock, options.prompt, {
      lite: litePrompt,
      ...(activeProvider.contextWindow ? { contextWindow: activeProvider.contextWindow } : {}),
      promptBudgetRatio: promptBudgetRatio(),
      subagentToolsEnabled: subagentDepth < subagentDepthLimit,
      onPromptBudgetExceeded: (event) => {
        promptBudgetEvents.push(event);
      },
      onRepoMapTokens: (tokens) => {
        repoMapTokens = tokens;
      },
    });
  }
  const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
  let messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...(options.history ?? []),
    { role: "user", content: options.prompt },
  ];
  // Default floor for callers that pass no budget (e.g. interactive chat without
  // an inferred coding context). 12 was far too low for any multi-step build and
  // caused runs to stop mid-task; 40 is a safe floor. Coding runs get a larger
  // phase-aware budget via phaseAwareMaxTurns/inferInteractiveRun.
  const maxTurns = options.maxTurns ?? 40;
  let finalText = "";
  let requestedFinalReport = false;
  // The commit gate re-arms: if the model's repair commit is itself incomplete
  // (commits edited files, forgets the new untracked ones — the field failure),
  // we remind again with the REMAINING paths, up to this cap. After the cap the
  // run finalizes but the report carries an explicit COMMIT INCOMPLETE block.
  let commitRepairAttempts = 0;
  const maxCommitRepairAttempts = 3;
  let requestedRuntimeVerify = false;
  let validationRepairAttempts = 0;
  let lastValidationRepairSignature: string | null = null;
  const seenValidationRepairSignatures = new Set<string>();
  const repairAttempts: RepairAttemptSnapshot[] = [];
  let consecutiveNoToolNoReportTurns = 0;
  const MAX_NO_TOOL_NO_REPORT_TURNS = 2;
  // NOTE: evaluated lazily at the repair trigger (repairBudget below) because
  // interactive-task arming depends on live run state (prompt shape + files
  // actually changed), which does not exist yet here at run start.
  const verificationLines: string[] = [];
  // Timestamped mirror of every verification line, append-only. Feeds the
  // verification-freshness gate: a passing build is proof only for the code
  // that existed when it ran, so the gate needs WHEN each pass happened, which
  // the plain lines don't carry. (A replaced failed→passed line still appends
  // here — chronology matters, not the deduped display list.)
  const verificationEvents: { line: string; atMs: number }[] = [];
  // Exit sentinel: from here on, ANY abnormal end (signal now; exception via
  // the runAgent wrapper) leaves an aborted-run archive + a loud dirty-tree
  // marker. finishRun flips `archived` so a completed run never double-writes.
  sentinelBox.state = registerExitSentinel({
    runId,
    workspace,
    prompt: options.prompt,
    changedFiles,
    verificationEvents,
  });
  const exitSentinelState = sentinelBox.state;
  appendLedgerRecord(workspace, {
    type: "run_start",
    runId,
    ts: new Date().toISOString(),
    prompt: options.prompt.slice(0, 200),
  });
  let createdArtifactPaths: string[] = [];
  const requiredTool = requiredHighLevelTool(options.runContext, options.prompt);
  let toolCallCorrectionAttempts = 0;
  let parseEscalationUsed = false;
  let forcedNextRoute: { target: RouteTarget; stepType: StepType; reason: string } | null = null;
  let childSequence = 0;
  const childVerdicts: ChildVerdict[] = [];
  const subtaskSemaphore = new AsyncSemaphore(subtaskMaxParallel());
  const budgetLedger = new BudgetLedger({
    ...(parentContext?.tokenBudget?.max_tokens !== undefined ? { maxTokens: parentContext.tokenBudget.max_tokens } : {}),
    ...(parentContext?.tokenBudget?.max_usd !== undefined ? { maxUsd: parentContext.tokenBudget.max_usd } : {}),
  });

  function evictReasoningArchiveForCompaction(): void {
    try {
      evictReasoningFromArchive(workspace, runId, 0);
    } catch {
      // Reasoning archive eviction is best-effort; compaction must still proceed.
    }
  }

  // The non-LLM compaction ladder (clear old tool results → microcompact →
  // snip low-signal), shared by the proactive pre-turn check and the reactive
  // context-window-exceeded handler. Proactive mode gates every tier on the
  // 85% threshold and keeps the clear-tier's minimum-saving guard (don't
  // invalidate the prefix cache for a trivial win). Reactive mode runs every
  // tier unconditionally with no minimum — the request already blew the
  // window, every freed token counts. The reactive-only LLM `auto` tier and
  // its throw-on-exhaustion stay at the reactive call site.
  async function applyCompaction(
    next: ChatMessage[],
    archived: ChatMessage[],
    event: { compactType: "clear_tool_results" | "micro" | "snip"; removedTokens: number },
  ): Promise<void> {
    evictReasoningArchiveForCompaction();
    await appendRunArchive(archived);
    messages = next;
    fileReadDedup.clear();
    await options.sink({ type: "compact_event", ...event });
  }

  async function runCompactionLadder({ reactive }: { reactive: boolean }): Promise<void> {
    const due = () => reactive || estimateCompactTokens(messages) >= CONTEXT_TOKEN_LIMIT * 0.85;
    if (due()) {
      const cleared = reactive ? clearOldToolResults(messages, { minSavedTokens: 0 }) : clearOldToolResults(messages);
      if (cleared.clearedCount > 0) {
        await applyCompaction(cleared.messages, cleared.archivedMessages, {
          compactType: "clear_tool_results",
          removedTokens: cleared.removedTokens,
        });
      }
    }
    if (due()) {
      const compacted = microcompact(messages, {
        tokenBudget: Math.floor(CONTEXT_TOKEN_LIMIT * 0.85),
        foldRatio: 0.2,
      });
      if (compacted.foldedPairs > 0) {
        await applyCompaction(compacted.messages, compacted.archivedMessages, {
          compactType: "micro",
          removedTokens: compacted.removedTokens,
        });
      }
    }
    if (due()) {
      const beforeSnipTokens = estimateCompactTokens(messages);
      const snipped = snipLowSignal(messages);
      if (snipped.snippedCount > 0) {
        await applyCompaction(snipped.messages, snipped.archivedMessages, {
          compactType: "snip",
          removedTokens: Math.max(0, beforeSnipTokens - estimateCompactTokens(snipped.messages)),
        });
      }
    }
  }

  for (const event of promptBudgetEvents) {
    await options.sink({ type: "prompt_budget_exceeded", ...event });
    auditPermissionDecision(
      workspace,
      permissionContext,
      "system_prompt",
      event,
      { decision: "allow", reason: "prompt-budget-enforced" },
      "engine",
    );
  }

  function mergeAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    if (a && b) return AbortSignal.any([a, b]);
    return a ?? b;
  }

  async function runSubAgentTask(request: SubAgentTaskRequest): Promise<SubAgentTaskResult> {
    childSequence += 1;
    const subRunId = childRunId(runId, childSequence);
    return subtaskSemaphore.run(async () => {
      const recentPrompts = [
        options.prompt,
        ...messages
          .filter((message) => message.role === "user" && typeof message.content === "string")
          .map((message) => message.content ?? ""),
      ].slice(-3);
      if (subtaskCycleCheckEnabled() && isLikelySubtaskCycle(request.prompt, recentPrompts)) {
        throw new Error("cycle_detected: child prompt is too similar to recent parent prompts");
      }

      const reservation = budgetLedger.reserve({
        ...(request.token_budget?.max_tokens !== undefined ? { maxTokens: request.token_budget.max_tokens } : {}),
        ...(request.token_budget?.max_usd !== undefined ? { maxUsd: request.token_budget.max_usd } : {}),
      });
      let usedForRelease: { maxTokens?: number; maxUsd?: number } = {};
      try {
        const childWorkspace = resolveSubAgentWorkspace(workspace, request.workspace);
        const historySnapshot = messages.filter((message) => message.role !== "system").map((message) => ({ ...message }));
        const childRunContext = {
          metadata: {
            subAgent: true,
            goldenTask: false,
            goldenTaskCandidate: false,
            ...(request.skill_pack_overrides?.length
              ? { subAgentSkillPackOverrides: request.skill_pack_overrides }
              : {}),
          },
        };
        await options.sink({
          type: "subtask_started",
          subRunId,
          parentRunId: runId,
          prompt: request.prompt,
          workspace: childWorkspace,
        });
        const childProvider = request.model && options.routing
          ? options.routing.providerFactory(request.model)
          : activeProvider;
        const childRouting = request.model ? undefined : options.routing;
        const runResult = await runAgent({
          provider: childProvider,
          prompt: request.prompt,
          cwd: childWorkspace,
          sink: createSubAgentSink(options.sink, subRunId),
          maxTurns: request.max_turns ?? 20,
          runContext: childRunContext,
          parentContext: {
            runId,
            workspace,
            permissionContext,
            history: historySnapshot,
            childIndex: childSequence,
            ...(options.runContext ? { runContext: options.runContext } : {}),
            ...(request.token_budget ? { tokenBudget: request.token_budget } : {}),
          },
          runId: subRunId,
          ...((() => { const s = mergeAbortSignals(options.signal, request.signal); return s ? { signal: s } : {}; })()),
          ...(options.onPermissionRequest ? { onPermissionRequest: options.onPermissionRequest } : {}),
          ...(childRouting ? { routing: childRouting } : {}),
        });
        const validationErrors = runResult.manifest.validation?.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message) ?? [];
        const tokensUsed = {
          in: runResult.metrics?.promptTokens ?? 0,
          out: runResult.metrics?.completionTokens ?? 0,
          reasoning: runResult.metrics?.reasoningTokens ?? 0,
        };
        const usedTokens = tokensUsed.in + tokensUsed.out + tokensUsed.reasoning;
        const usedUsd = estimateRunCost({
          provider: childProvider.id,
          model: childProvider.model,
          promptTokens: tokensUsed.in,
          completionTokens: tokensUsed.out,
          reasoningTokens: tokensUsed.reasoning,
          cachedPromptTokens: runResult.metrics?.cachedPromptTokens ?? 0,
        }).usd ?? 0;
        usedForRelease = {
          maxTokens: usedTokens,
          maxUsd: usedUsd,
        };
        const budgetExceeded = (request.token_budget?.max_tokens !== undefined && usedTokens > request.token_budget.max_tokens) ||
          (request.token_budget?.max_usd !== undefined && usedUsd > request.token_budget.max_usd);
        const budgetBlockers = budgetExceeded ? ["budget exceeded"] : [];
        const blockers = uniqueSorted([...runResult.manifest.blockers, ...validationErrors, ...budgetBlockers]);
        const verdict = blockers.length === 0 ? "passed" : "failed";
        const childVerdict: ChildVerdict = {
          subRunId,
          verdict,
          blockers,
          changedFiles: uniqueSorted(runResult.manifest.changedFiles),
          summary: budgetExceeded ? "Subtask exceeded its token budget." : runResult.message.slice(0, 2_000),
          treatFailureAs: request.treat_failure_as ?? "blocker",
        };
        childVerdicts.push(childVerdict);
        auditPermissionDecision(workspace, permissionContext, "task", {
          subRunId,
          verdict,
          blockers,
          treatFailureAs: childVerdict.treatFailureAs,
        }, {
          decision: verdict === "passed" ? "allow" : "deny",
          reason: "child-verdict",
        }, "engine");
        await options.sink({
          type: "subtask_completed",
          subRunId,
          parentRunId: runId,
          verdict,
          summary: runResult.message.slice(0, 500),
          tokensUsed,
        });
        return {
          ok: verdict === "passed",
          subRunId,
          verdict,
          blockers,
          changedFiles: childVerdict.changedFiles,
          summary: childVerdict.summary,
          tokensUsed,
          childRunIds: [],
          manifest: runResult.manifest,
          runResult,
          treatFailureAs: request.treat_failure_as ?? "blocker",
          ...(budgetExceeded ? { cancelled: true, reason: "budget" } : {}),
        };
      } finally {
        budgetLedger.release(reservation.id, usedForRelease);
      }
    });
  }

  // Sub-agent job manager for async dispatch/status/result/cancel tools.
  // Depth guard: sub-agents cannot themselves dispatch (depth ≤ 1) unless
  // TANYA_SUBAGENT_DEPTH raises the limit.
  const subagentDepth = runIdDepth(runId);
  const subagentDepthLimit = (() => {
    const raw = envValue(process.env, "TANYA_SUBAGENT_DEPTH").trim();
    if (!raw) return 1;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1;
  })();
  const subAgentConcurrency = positiveIntFlag("TANYA_SUBAGENT_CONCURRENCY", 3);

  const subAgentManager = new SubAgentJobManager({
    runSubAgent: runSubAgentTask,
    runExternalBackend: async (backend, params) => {
      // Wrap external run as a SubAgentTaskResult.
      const extResult = await runWithExternalBackend({
        backend,
        prompt: params.prompt,
        cwd: params.cwd,
        sink: options.sink,
        ...(options.runContext ? { runContext: options.runContext } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.onProgress ? { onProgress: params.onProgress } : {}),
      });
      const verdict = extResult.manifest.blockers.length === 0 ? "passed" as const : "failed" as const;
      return {
        ok: verdict === "passed",
        subRunId: extResult.manifest.childRunIds?.[0] ?? `ext-${backend}-${Date.now().toString(36)}`,
        verdict,
        blockers: extResult.manifest.blockers,
        changedFiles: extResult.manifest.changedFiles,
        summary: extResult.message.slice(0, 500),
        tokensUsed: { in: 0, out: 0 },
        childRunIds: extResult.manifest.childRunIds ?? [],
        manifest: extResult.manifest,
        runResult: extResult,
        treatFailureAs: "blocker",
      };
    },
    maxConcurrency: subAgentConcurrency,
    dispatchForbidden: subagentDepth >= subagentDepthLimit,
    sink: options.sink,
  });

  async function syncArtifactOutput(): Promise<string[]> {
    const outputRootValue = options.runContext?.metadata?.artifactOutputRoot;
    if (typeof outputRootValue !== "string" || !outputRootValue.trim()) return [];
    const localOutputRoot = resolve(workspace, ".tanya", "artifact-output");
    if (!existsSync(localOutputRoot)) return [];
    const localFiles = await listFilesRecursive(localOutputRoot);
    if (localFiles.length === 0) return [];
    const outputRoot = resolve(outputRootValue);
    const copied: string[] = [];
    for (const relPath of localFiles) {
      const source = resolve(localOutputRoot, relPath);
      const target = resolve(outputRoot, relPath);
      const sourceStat = await stat(source);
      if (!sourceStat.isFile()) continue;
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { force: true, recursive: true });
      copied.push(`artifacts/${relPath}`);
    }
    return uniqueSorted(copied);
  }

  function finalMetrics(manifest: TanyaFinalManifest): FinalMetrics {
    return {
      durationMs: Date.now() - startedAt,
      toolCallCount,
      toolErrorCount: processor.toolErrorCount,
      changedFileCount: manifest.changedFiles.length,
      repairAttemptCount: repairAttempts.length,
      retryAttemptCount: options.retryAttempt ?? 0,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      reasoningTokens: totalReasoningTokens,
      cachedPromptTokens: totalCachedPromptTokens,
      costUsd: runSpendUsd,
      systemPromptTokens,
      repoMapTokens,
      toolResultTokens: processor.totalToolResultTokens,
    };
  }

  async function finishRun(finalMessage: string, manifest: TanyaFinalManifest): Promise<FinalMetrics> {
    // Never end silently on top of a known FAIL: leave a structured marker
    // with the exact blockers, touched files, and repair attempts used. A
    // PASSED finalize with gates armed (a real verified task completion, not
    // a conversational turn) clears it.
    if (manifest.blockers.length > 0) {
      writeRunFailedMarker({
        workspace,
        runId,
        blockers: manifest.blockers,
        changedFiles: manifest.changedFiles,
        uncommittedFiles: manifest.uncommittedFiles,
        repairAttemptsUsed: validationRepairAttempts,
        ...(recoveryAttemptNumber > 0 ? { recoveryAttempts: recoveryAttemptNumber } : {}),
      });
    } else if (manifest.gates?.armed) {
      clearRunFailedMarker(workspace);
    }
    const metrics = finalMetrics(manifest);
    await options.sink({
      type: "final",
      message: finalMessage,
      files: manifest.changedFiles,
      manifest,
      metrics,
    });
    await cleanupMaterializedContext(workspace, manifest, options.runContext);
    // The real archive is about to land — the exit sentinel must never fire
    // after this point (it would shadow a completed run with an "aborted" one).
    exitSentinelState.archived = true;
    clearExitSentinelHeartbeats(exitSentinelState);
    writeRunArchive({
      workspace,
      runId,
      ...(parentContext?.runId ? { parentRunId: parentContext.runId } : {}),
      prompt: options.prompt,
      provider: activeProvider.id,
      model: activeProvider.model,
      metrics,
      manifest,
    });
    return metrics;
  }

  // The single finalize tail for every completed (non-cancelled) run: memory
  // side-effects first (golden tasks, task history, obsidian, repair memory),
  // then finishRun (marker + final event + archive). Cancelled runs call
  // finishRun directly — they intentionally record no memories.
  async function finalizeRun(finalMessage: string, manifest: TanyaFinalManifest): Promise<RunAgentResult> {
    await recordRunMemorySideEffects({
      workspace,
      prompt: options.prompt,
      manifest,
      ...(options.runContext ? { runContext: options.runContext } : {}),
      repairAttempts,
    });
    const metrics = await finishRun(finalMessage, manifest);
    return { message: finalMessage, manifest, metrics };
  }

  function pendingToolCallsForRouting(): Array<ToolCall & { preferredModel?: TanyaTool["preferredModel"] }> {
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return (lastAssistant?.tool_calls ?? []).map((call) => {
      const preferredModel = registry.get(call.function.name)?.preferredModel;
      return preferredModel ? { ...call, preferredModel } : call;
    });
  }

  function preferredRouteForStep(stepType: StepType): ResolvedRoute | null {
    if (stepType !== "tool_call" && stepType !== "verification") return null;
    const pending = pendingToolCallsForRouting();
    for (const call of pending) {
      const preferred = call.preferredModel;
      if (!preferred) continue;
      if (preferred.match && preferred.match !== stepType) continue;
      if (estimateCompactTokens(messages) > contextWindowForTarget(preferred)) continue;
      return {
        provider: preferred.provider,
        model: preferred.model,
        match: stepType,
        escalate: true,
        source: "session",
        reason: `preferred model for tool ${call.function.name}`,
      };
    }
    return null;
  }

  async function routeProviderForTurn(turn: number): Promise<{
    provider: ChatProvider;
    stepType: StepType;
    route?: ResolvedRoute;
  }> {
    if (!options.routing?.enabled) {
      return { provider: activeProvider, stepType: "unknown" };
    }

    if (forcedNextRoute) {
      const forced = forcedNextRoute;
      forcedNextRoute = null;
      const provider = options.routing.providerFactory(forced.target);
      const key = providerKey(provider);
      const cacheImpact: "hit" | "miss" = key === lastProviderKey ? "hit" : "miss";
      activeProvider = provider;
      lastProviderKey = key;
      const event = {
        type: "model_routed" as const,
        stepType: forced.stepType,
        provider: provider.id,
        model: provider.model,
        reason: forced.reason,
        cacheImpact,
      };
      await options.sink(event);
      auditModelRouted(workspace, permissionContext, event);
      return { provider, stepType: forced.stepType };
    }

    const classifierState = {
      messages,
      turnIndex: turn,
      pendingToolCalls: pendingToolCallsForRouting(),
      cwd: workspace,
      ...(options.prompt ? { prompt: options.prompt } : {}),
      ...(options.runContext ? { runContext: options.runContext } : {}),
    };
    const stepType = classifyStep(classifierState);
    const forcedRoute = forcedRouteFromRunContext(options.runContext);
    const route = forcedRoute
      ? resolveRouteWithContextGuard({
          stepType,
          table: options.routing.table,
          messages,
          prompt: options.prompt,
          cwd: workspace,
          ...(options.runContext ? { runContext: options.runContext } : {}),
          forcedRoute,
        })
      : preferredRouteForStep(stepType) ?? resolveRouteWithContextGuard({
          stepType,
          table: options.routing.table,
          messages,
          prompt: options.prompt,
          cwd: workspace,
          ...(options.runContext ? { runContext: options.runContext } : {}),
        });
    const provider = options.routing.providerFactory(route);
    const key = providerKey(provider);
    const cacheImpact: "hit" | "miss" = key === lastProviderKey ? "hit" : "miss";
    activeProvider = provider;
    lastProviderKey = key;
    const event = {
      type: "model_routed" as const,
      stepType,
      provider: provider.id,
      model: provider.model,
      reason: route.reason,
      cacheImpact,
    };
    await options.sink(event);
    if (route.cascade && route.cascade.selectedIndex > 0) {
      await options.sink({
        type: "provider.raw",
        provider: provider.id,
        model: provider.model,
        event: {
          type: "model_routed",
          reason: "cascade-fit",
          stepType,
          provider: provider.id,
          model: provider.model,
          attempted_routes: route.cascade.attemptedRoutes,
          estimated_tokens: route.cascade.estimatedTokens,
          safety_factor: route.cascade.safetyFactor,
          selected_route: route.cascade.selectedRoute,
        },
      });
    }
    auditModelRouted(workspace, permissionContext, event);
    return { provider, stepType, route };
  }

  async function routeFallbackProvider(params: {
    fallback: RouteTarget;
    stepType: StepType;
    reason: string;
  }): Promise<ChatProvider> {
    const provider = options.routing?.providerFactory(params.fallback) ?? activeProvider;
    const key = providerKey(provider);
    const cacheImpact: "hit" | "miss" = key === lastProviderKey ? "hit" : "miss";
    activeProvider = provider;
    lastProviderKey = key;
    const event = {
      type: "model_routed" as const,
      stepType: params.stepType,
      provider: provider.id,
      model: provider.model,
      reason: params.reason,
      cacheImpact,
    };
    await options.sink(event);
    auditModelRouted(workspace, permissionContext, event);
    return provider;
  }

  async function scheduleEscalation(params: {
    from: ChatProvider;
    route?: ResolvedRoute;
    stepType: StepType;
    reason: "parse_failure" | "schema_failure" | "context_too_small";
  }): Promise<boolean> {
    if (!options.routing?.enabled) return false;
    if (params.route?.escalate === false) return false;
    const target = params.route?.fallback ?? options.routing.table.defaults;
    if (`${target.provider}/${target.model}` === `${params.from.id}/${params.from.model}`) return false;
    const cap = escalationCap();
    if (sessionEscalations >= cap) {
      throw new EscalationExhaustedError(`Escalation cap reached (${cap}) for this session.`);
    }
    sessionEscalations += 1;
    const event = {
      type: "escalation_event" as const,
      from: { provider: params.from.id, model: params.from.model },
      to: { provider: target.provider, model: target.model },
      reason: params.reason,
      stepType: params.stepType,
    };
    await options.sink(event);
    auditEscalation(workspace, permissionContext, event);
    forcedNextRoute = {
      target,
      stepType: params.stepType,
      reason: `escalated after ${params.reason}`,
    };
    return true;
  }

  let compactionsThisRun = 0;
  const COMPACTION_LIMIT = 3;

  // Progress-aware budget: opt-in extension of a productive run past maxTurns,
  // UNBOUNDED by default — the run continues while it makes progress and stops
  // only when it stalls. See progressBudget.ts. Disabled unless the caller opts
  // in (interactive coding runs), so eval/sub-agents/explicit --max-turns keep
  // an exact cap. TANYA_HARD_TURN_CEILING restores a fixed ceiling if wanted.
  const envCeiling = hardTurnCeilingFromEnv();
  const progressBudget = resolveProgressBudget(maxTurns, {
    extendOnProgress: options.extendBudgetOnProgress ?? false,
    ...(envCeiling !== undefined ? { ceiling: envCeiling } : {}),
  });
  const hardCeiling = progressBudget.hardCeiling;
  const interactive = options.interactive ?? false;
  // An interactive turn that is really a TASK (mac-app pastes a spec / verify
  // contract, or a coding turn that wrote files) must be held to the same gates
  // and FAILED verdict as a `tanya run`; only a plain chat turn stays soft.
  // Evaluated lazily because the changed-file list grows during the run.
  const interactiveTask = () => interactiveTaskGatesArmed({
    interactive,
    ...(options.runContext ? { runContext: options.runContext } : {}),
    changed: processor.changedFiles,
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
  });
  const softInteractiveFinal = () => interactive && !interactiveTask();
  const maxStallTokens = stallTokenCeiling();
  let stoppedForStallTokens = false;
  let stoppedForNoProgress = false;
  // Non-null once a budget/stall stop tripped and the wrap-up window opened.
  let wrapUp: WrapUpState | null = null;
  const driftGuardDisabled = !offFlag("TANYA_DRIFT_GUARD");
  // Everything that happens to a tool call after the parse/validation/
  // permission gates — and the run-scoped counters it accumulates — lives in
  // the processor (R3a); finalize reads its public fields.
  const processor = new ToolResultProcessor({
    workspace,
    runId,
    sink: options.sink,
    ...(options.runContext ? { runContext: options.runContext } : {}),
    permissionContext,
    fileReadDedup,
    exitSentinelState,
    initialChangedFiles: changedFiles,
    verificationLines,
    verificationEvents,
    requiredTool,
    snapshotsEnabled: offFlag("TANYA_SNAPSHOTS"),
    stuckGuardEnabled: offFlag("TANYA_STUCK_GUARD"),
    sentinelFlushEvery: positiveIntFlag("TANYA_SENTINEL_FLUSH_EVERY", 8),
    firstBuildNudgeAfter: positiveIntFlag("TANYA_FIRST_BUILD_NUDGE_AFTER", 3),
    host: {
      pushUserMessage: (content) => {
        messages.push({ role: "user", content });
      },
      pushToolMessage: (toolCallId, content) => {
        messages.push({ role: "tool", tool_call_id: toolCallId, content });
      },
      wrapUpActive: () => wrapUp !== null,
      grantWrapUp: (startedTurn) => {
        wrapUp = { startedTurn, reason: "no_progress" };
      },
    },
  });

  for (let turn = 0; turn < hardCeiling; turn += 1) {
    if (parentContext && options.signal?.aborted) {
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot,
        changed: processor.changedFiles,
        verificationLines,
        verificationEvents,
        toolErrorCount: processor.toolErrorCount,
        readArtifactPaths: processor.readArtifactPaths,
        readContextPaths: processor.readContextPaths,
        createdArtifactPaths,
        blockers: ["run cancelled"],
        childVerdicts: [...childVerdicts, ...subAgentManager.collectChildVerdicts()],
        runContext: options.runContext,
        prompt: options.prompt,
        runId,
        verifierShell: options.verifierShell,
        runStartedAtMs: runStartedAt.getTime(),
        interactive,
      });
      const metrics = await finishRun("Run cancelled.", manifest);
      return { message: "Run cancelled.", manifest, metrics };
    }
    // A spent wrap-up window is a HARD stop: commits made during wrap-up count
    // as progress (they reset lastProgressTurn), so this check must come first
    // and ignore progress — otherwise a looping model rides commits forever.
    if (wrapUpExpired(wrapUp, turn)) {
      if (wrapUp?.reason === "stall_tokens") stoppedForStallTokens = true;
      else stoppedForNoProgress = true;
      break;
    }
    if (!wrapUp && shouldStopAfterBudget(turn, maxTurns, processor.lastProgressTurn, progressBudget)) {
      // Don't die silently with finished work uncommitted — grant one fixed
      // wrap-up window and tell the model to commit + report NOW.
      wrapUp = { startedTurn: turn, reason: "no_progress" };
      messages.push({ role: "user", content: buildWrapUpDirective("no_progress") });
      await options.sink({ type: "status", message: `budget wall: wrap-up window granted (${WRAP_UP_TURNS} turns) — commit completed work + final report` });
    }
    // Token-runaway backstop: a stalled run (no successful tool for 2+ turns)
    // that has already burned a large cumulative prompt-token budget will not
    // recover by grinding more turns — same wrap-up window, then a hard stop.
    // Productive runs never trip this because lastProgressTurn keeps advancing.
    if (!wrapUp && maxStallTokens > 0 && turn - processor.lastProgressTurn >= 2 && totalPromptTokens > maxStallTokens) {
      wrapUp = { startedTurn: turn, reason: "stall_tokens" };
      messages.push({ role: "user", content: buildWrapUpDirective("stall_tokens") });
      await options.sink({ type: "status", message: `token budget wall: wrap-up window granted (${WRAP_UP_TURNS} turns) — commit completed work + final report` });
    }
    // Read-only drift guard: a coding-classified run with ZERO edits gets told
    // to implement (turn 8), warned (16), and closed with an honest report
    // (24) — reads count as progress, so no other stop catches this shape.
    if (!driftGuardDisabled && !wrapUp && processor.firstMutationTurn === null) {
      const driftArmed = isCodingTask(options.runContext) || interactiveTask();
      const driftAction = readOnlyDriftAction(turn, false, driftArmed);
      if (driftAction === "nudge" || driftAction === "final_nudge") {
        messages.push({ role: "user", content: buildDriftNudge(driftAction) });
        await options.sink({ type: "status", message: `read-only drift: ${turn} turns with zero edits — nudging implementation` });
      } else if (driftAction === "wrap_up") {
        wrapUp = { startedTurn: turn, reason: "no_progress" };
        messages.push({ role: "user", content: buildDriftWrapUpDirective() });
        await options.sink({ type: "status", message: `read-only drift: ${DRIFT_WRAP_UP_TURN} turns with zero edits — demanding final report` });
      }
    }
    let turnSpendTokens = 0;
    let turnSpendUsd = 0;
    processor.beginTurn();
    // Cheapest pressure valves first (clear old tool results, keep-recent,
    // Claude-Code-style; then microcompact; then snip) — no LLM call, and in
    // proactive mode a minimum-saving guard keeps the prefix cache intact.
    await runCompactionLadder({ reactive: false });

    let routed = await routeProviderForTurn(turn);
    let turnProvider = routed.provider;
    const reasoningCapTokens = reasoningCapForTurn(routed.stepType, routed.route);
    let turnReasoningTokens = 0;
    let reasoningBudgetExceeded = false;

    await options.sink({ type: "message_start" });
    let assistantText = "";
    let assistantReasoningText = "";
    let rawToolCalls: unknown[] = [];
    let schemaFlattenedThisTurn = false;

    const codingProviderOptions = isCodingTask(options.runContext)
      ? { temperature: 0, topP: 0.2 }
      : {};
    // Provider transient retry: if the stream errors before any content or tool
    // call has been emitted (e.g. DeepSeek 'fetch failed' or 'timed out before
    // streaming a response'), retry the same turn once. Once content has been
    // streamed, retry would corrupt the conversation — fall through to the
    // existing repair-loop instead. This eliminates the most common case of
    // losing a whole loop cycle to a 1-second network blip.
    let providerAttempt = 0;
    let contextCompactionsThisTurn = 0;
    let routeFallbackIndex = 0;
    const routeFallbackTargets = [
      routed.route?.fallback,
      options.routing?.table.defaults,
    ].filter((target): target is RouteTarget => Boolean(target));
    const PROVIDER_TRANSIENT_RETRIES = 1;
    streamLoop: while (true) {
      try {
        for await (const delta of turnProvider.streamChat({
          messages,
          tools: registry.list().map((tool) => tool.definition),
          onProviderThrottle: (event) => {
            void Promise.resolve(options.sink({
              type: "provider_throttle",
              provider: event.provider,
              attempt: event.attempt,
              waitMs: event.waitMs,
            })).catch(() => {});
          },
          ...codingProviderOptions,
        })) {
          if (delta.usage) {
            totalPromptTokens += delta.usage.promptTokens;
            totalCompletionTokens += delta.usage.completionTokens;
            totalReasoningTokens += delta.usage.reasoningTokens ?? 0;
            totalCachedPromptTokens += delta.usage.cachedPromptTokens ?? 0;
            const usageTokens = delta.usage.promptTokens + delta.usage.completionTokens + (delta.usage.reasoningTokens ?? 0);
            const usageUsd = estimateRunCost({
              provider: turnProvider.id,
              model: turnProvider.model,
              promptTokens: delta.usage.promptTokens,
              completionTokens: delta.usage.completionTokens,
              reasoningTokens: delta.usage.reasoningTokens ?? 0,
              cachedPromptTokens: delta.usage.cachedPromptTokens ?? 0,
            }).usd ?? 0;
            turnSpendTokens += usageTokens;
            runSpendTokens += usageTokens;
            sessionSpendTokens += usageTokens;
            turnSpendUsd += usageUsd;
            runSpendUsd += usageUsd;
            sessionSpendUsd += usageUsd;
          }
          if (delta.schemaWarnings) {
            schemaFlattenedThisTurn = true;
            for (const warning of delta.schemaWarnings) {
              await options.sink({
                type: "schema_flatten_warning",
                reason: warning.reason,
                path: warning.path,
                provider: turnProvider.id,
                ...(warning.tool ? { tool: warning.tool } : {}),
              });
            }
          }
          if (delta.content) {
            assistantText += delta.content;
            finalText += delta.content;
            await options.sink({ type: "message_delta", text: delta.content });
          }
          if (delta.reasoningContent) {
            assistantReasoningText += delta.reasoningContent;
            const tokens = delta.usage?.reasoningTokens ?? Math.ceil(delta.reasoningContent.length / 4);
            if (delta.usage?.reasoningTokens === undefined) totalReasoningTokens += tokens;
            turnReasoningTokens += tokens;
            await appendReasoningChunk({
              workspace,
              runId,
              turn,
              provider: turnProvider.id,
              model: turnProvider.model,
              content: delta.reasoningContent,
              tokens,
            });
            if (!reasoningBudgetExceeded && turnReasoningTokens > reasoningCapTokens) {
              reasoningBudgetExceeded = true;
              await options.sink({
                type: "reasoning_truncated",
                provider: turnProvider.id,
                model: turnProvider.model,
                usedTokens: turnReasoningTokens,
                capTokens: reasoningCapTokens,
                stepType: routed.stepType,
              });
            }
            await options.sink({
              type: "reasoning_chunk",
              content: delta.reasoningContent,
              provider: turnProvider.id,
              model: turnProvider.model,
              runId,
              turn,
              tokens,
            });
          }
          if (delta.toolCalls?.length) rawToolCalls = delta.toolCalls;
        }
        break; // stream completed normally
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const noProgressYet = assistantText.length === 0 && assistantReasoningText.length === 0 && rawToolCalls.length === 0;
        if (isContextWindowExceededError(err)) {
          if (!noProgressYet || contextCompactionsThisTurn >= 2 || compactionsThisRun >= COMPACTION_LIMIT) {
            if (noProgressYet) {
              const escalated = await scheduleEscalation({
                from: turnProvider,
                ...(routed.route ? { route: routed.route } : {}),
                stepType: routed.stepType,
                reason: "context_too_small",
              });
              if (escalated && forcedNextRoute) {
                const forced = forcedNextRoute;
                forcedNextRoute = null;
                turnProvider = await routeFallbackProvider({
                  fallback: forced.target,
                  stepType: forced.stepType,
                  reason: forced.reason,
                });
                contextCompactionsThisTurn = 0;
                continue streamLoop;
              }
            }
            throw new CompactionExhaustedError(`Context compaction exhausted after ${compactionsThisRun} compaction(s): ${message}`);
          }

          // Already over the provider's window: run every non-LLM tier with no
          // minimum-saving guard — the prefix cache is a lost cause for this
          // request anyway, every freed token counts.
          await runCompactionLadder({ reactive: true });

          const aggression: CompactionAggression = contextCompactionsThisTurn === 0 ? "normal" : "heavy";
          const compacted = await autoCompact(messages, {
            provider: turnProvider,
            model: turnProvider.model,
            aggression,
            archive: { workspace, runId, onError: archiveErrorSink },
          });
          evictReasoningArchiveForCompaction();
          messages = compacted.messages;
          fileReadDedup.clear();
          compactionsThisRun += 1;
          contextCompactionsThisTurn += 1;
          await options.sink({
            type: "compact_event",
            compactType: "auto",
            removedTokens: compacted.removedTokens,
            summaryTokens: compacted.summaryTokens,
            aggression,
          });
          continue;
        }
        const isTransient = /timed out|fetch failed|ECONNRESET|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message);
        if (isTransient && noProgressYet && providerAttempt < PROVIDER_TRANSIENT_RETRIES) {
          providerAttempt += 1;
          await options.sink({ type: "status", message: `Provider transient error (${message.slice(0, 120)}); retrying same turn (${providerAttempt}/${PROVIDER_TRANSIENT_RETRIES}).` });
          continue;
        }
        if (options.routing?.enabled && noProgressYet) {
          while (routeFallbackIndex < routeFallbackTargets.length) {
            const fallback = routeFallbackTargets[routeFallbackIndex];
            routeFallbackIndex += 1;
            if (!fallback || `${fallback.provider}/${fallback.model}` === `${turnProvider.id}/${turnProvider.model}`) continue;
            turnProvider = await routeFallbackProvider({
              fallback,
              stepType: routed.stepType,
              reason: `fallback after provider error: ${message.slice(0, 120)}`,
            });
            routed = { provider: turnProvider, stepType: routed.stepType };
            providerAttempt = 0;
            continue streamLoop;
          }
        }
        throw err;
      }
    }

    await options.sink({ type: "message_end" });

    const assistantHistoryMessage = (toolCalls: ToolCall[] = []): ChatMessage => {
      const message: ChatMessage = {
        role: "assistant",
        content: assistantText || null,
      };
      if (assistantReasoningText.length > 0 && turnProvider.roundTripReasoning === true) {
        message.reasoning_content = assistantReasoningText;
      }
      if (toolCalls.length) message.tool_calls = toolCalls;
      return message;
    };

    if (reasoningBudgetExceeded && turn < hardCeiling - 1) {
      messages.push(assistantHistoryMessage());
      messages.push({
        role: "user",
        content: "[your reasoning budget for this turn is exhausted. Give your final answer now.]",
      });
      continue;
    }

    const parsedToolCalls = rawToolCalls.length > 0
      ? parseProviderToolCalls(rawToolCalls, { turn })
      : { toolCalls: [] as ToolCall[], warnings: [], failures: [] };
    for (const warning of parsedToolCalls.warnings) {
      await options.sink({
        type: "tool_call_parse_warning",
        reason: warning.reason,
        provider: turnProvider.id,
        turn,
        attempt: toolCallCorrectionAttempts,
        ...(warning.toolCallId ? { toolCallId: warning.toolCallId } : {}),
        ...(warning.tool ? { tool: warning.tool } : {}),
      });
    }
    for (const failure of parsedToolCalls.failures) {
      await options.sink({
        type: "tool_call_parse_warning",
        reason: failure.reason,
        provider: turnProvider.id,
        turn,
        attempt: toolCallCorrectionAttempts + 1,
        toolCallId: failure.toolCall.id,
        tool: failure.toolCall.function.name,
      });
    }

    if (
      parsedToolCalls.failures.length > 0 &&
      !parseEscalationUsed &&
      toolCallCorrectionAttempts + 1 >= TOOL_CALL_CORRECTION_LIMIT &&
      turn < hardCeiling - 1
    ) {
      const escalated = await scheduleEscalation({
        from: turnProvider,
        ...(routed.route ? { route: routed.route } : {}),
        stepType: routed.stepType,
        reason: schemaFlattenedThisTurn ? "schema_failure" : "parse_failure",
      });
      if (escalated) {
        parseEscalationUsed = true;
        toolCallCorrectionAttempts += 1;
        messages.push(assistantHistoryMessage());
        messages.push({
          role: "user",
          content: malformedToolCallCorrectionMessage(parsedToolCalls.failures.map((failure) => failure.reason).join("; ")),
        });
        continue;
      }
    }

    if (parsedToolCalls.failures.length > 0 && toolCallCorrectionAttempts < TOOL_CALL_CORRECTION_LIMIT && turn < hardCeiling - 1) {
      toolCallCorrectionAttempts += 1;
      messages.push(assistantHistoryMessage());
      messages.push({
        role: "user",
        content: malformedToolCallCorrectionMessage(parsedToolCalls.failures.map((failure) => failure.reason).join("; ")),
      });
      continue;
    }

    if (parsedToolCalls.failures.length > 0) {
      const failedToolCalls = parsedToolCalls.failures.map((failure) => failure.toolCall);
      processor.toolErrorCount += failedToolCalls.length;
      messages.push(assistantHistoryMessage(failedToolCalls));
      for (const failure of parsedToolCalls.failures) {
        const error = `malformed tool call after ${TOOL_CALL_CORRECTION_LIMIT} correction attempts: ${failure.reason}`;
        messages.push({ role: "tool", tool_call_id: failure.toolCall.id, content: JSON.stringify({ ok: false, error }) });
        await options.sink({
          type: "tool_result",
          id: failure.toolCall.id,
          tool: failure.toolCall.function.name,
          ok: false,
          summary: "Malformed tool call after correction attempts.",
          error,
        });
      }
      continue;
    }

    const toolCalls = parsedToolCalls.toolCalls;
    if (toolCalls.length > 0) {
      toolCallCorrectionAttempts = 0;
      parseEscalationUsed = false;
    }

    messages.push(assistantHistoryMessage(toolCalls));

    if (
      toolCalls.length === 0 &&
      !interactive &&
      isCodingTask(options.runContext) &&
      !hasRequiredCodingReport(assistantText || finalText)
    ) {
      consecutiveNoToolNoReportTurns += 1;
      if (!requestedFinalReport && consecutiveNoToolNoReportTurns < MAX_NO_TOOL_NO_REPORT_TURNS && turn < hardCeiling - 1) {
        requestedFinalReport = true;
        messages.push({
          role: "user",
          content: buildFinalReportReminder(processor.changedFiles, processor.toolErrorCount),
        });
        continue;
      }
    } else {
      consecutiveNoToolNoReportTurns = 0;
    }

    if (toolCalls.length === 0) {
      createdArtifactPaths = uniqueSorted([...createdArtifactPaths, ...await syncArtifactOutput()]);
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot,
        changed: processor.changedFiles,
        verificationLines,
        verificationEvents,
        toolErrorCount: processor.toolErrorCount,
        readArtifactPaths: processor.readArtifactPaths,
        readContextPaths: processor.readContextPaths,
        createdArtifactPaths,
        blockers: failedVerificationBlockers(verificationLines, assistantText || finalText),
        childVerdicts: [...childVerdicts, ...subAgentManager.collectChildVerdicts()],
        runContext: options.runContext,
        prompt: options.prompt,
        runId,
        verifierShell: options.verifierShell,
        runStartedAtMs: runStartedAt.getTime(),
        interactive,
      });
      // Commit gate. NOT nested under isCodingTask: ad-hoc coding runs have no
      // runContext, so isCodingTask is false for them — the exact runs whose
      // finished work was left uncommitted. commitStillRequired now encodes the
      // default-on-for-ad-hoc / opt-in-for-pipeline decision itself.
      if (
        !interactive &&
        commitRepairAttempts < maxCommitRepairAttempts &&
        commitStillRequired(manifest, beforeGitSnapshot, options.runContext) &&
        turn < hardCeiling - 1
      ) {
        commitRepairAttempts += 1;
        messages.push({
          role: "user",
          content: buildCommitRequiredReminder(manifest),
        });
        continue;
      }
      const repairBudget = repairAttemptBudget(options, interactiveTask());
      if (
        (isCodingTask(options.runContext) || interactiveTask()) &&
        ((manifest.validation && !manifest.validation.passed) || manifest.blockers.length > 0) &&
        validationRepairAttempts < repairBudget &&
        !seenValidationRepairSignatures.has(validationRepairSignature(manifest)) &&
        turn < hardCeiling - 1
      ) {
        validationRepairAttempts += 1;
        const signature = validationRepairSignature(manifest);
        lastValidationRepairSignature = signature;
        seenValidationRepairSignatures.add(signature);
        repairAttempts.push(repairAttemptSnapshot(validationRepairAttempts, manifest));
        messages = pruneStaleRepairReminders(messages);
        messages.push({
          role: "user",
          content: buildValidationRepairReminder(manifest, validationRepairAttempts, repairBudget),
        });
        continue;
      }
      // Definition-of-done: the build is green and there are no real failures,
      // but the running app's behaviour was never exercised. Nudge once to run
      // the runtime test. This never gates the verdict — if the agent still
      // doesn't test (or can't), the run still finalizes PASS (no false-FAIL);
      // a genuine runtime failure would have surfaced as a blocker above.
      if (
        !interactive &&
        isCodingTask(options.runContext) &&
        manifest.runtimeUnverified &&
        !requestedRuntimeVerify &&
        turn < hardCeiling - 1
      ) {
        requestedRuntimeVerify = true;
        messages.push({
          role: "user",
          content: buildRuntimeVerifyReminder(manifest),
        });
        continue;
      }
      let finalMessage: string;
      if (softInteractiveFinal()) {
        const warning = interactiveCommitWarning(manifest);
        const base = assistantText || finalText || "Done.";
        finalMessage = warning ? `${base}\n\n${warning}` : base;
      } else {
        // markCommitIncomplete mutates manifest.blockers, so run it BEFORE the
        // report is built so the verdict reflects the incomplete commit.
        const lead = !interactive && commitStillRequired(manifest, beforeGitSnapshot, options.runContext)
          ? `${markCommitIncomplete(manifest)}\n\n`
          : "";
        const base = (isCodingTask(options.runContext) || interactiveTask())
          ? ensureCodingReport(assistantText || finalText || "Done.", manifest, options.runContext, { concise: interactive, workspace, prompt: options.prompt })
          : assistantText || finalText || "Done.";
        finalMessage = `${lead}${base}`;
      }
      return finalizeRun(finalMessage, manifest);
    }

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const tool = registry.get(toolName);
      const parsedInput = parseToolArguments(toolCall.function.arguments);
      if (!parsedInput.ok) {
        processor.toolErrorCount += 1;
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            ok: false,
            error: parsedInput.reason,
            rawArguments: parsedInput.rawArguments,
          }),
        });
        await options.sink({
          type: "tool_result",
          id: toolCall.id,
          tool: toolName,
          ok: false,
          summary: "Invalid tool arguments (malformed JSON).",
          output: `raw arguments (preview): ${parsedInput.rawArguments}`,
          error: parsedInput.reason,
        });
        continue;
      }
      const callInput = parsedInput.input;
      toolCallCount += 1;
      await options.sink({ type: "tool_call", id: toolCall.id, tool: toolName, input: callInput });

      if (!tool) {
        const error = toolName.startsWith("mcp:")
          ? `MCP tool is not configured or allowlisted: ${toolName}`
          : `Unknown tool: ${toolName}`;
        processor.toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: error, error });
        continue;
      }

      const validationError = validateToolInput(callInput, tool.definition as {
        function: { parameters?: { properties?: Record<string, { type?: string }>; required?: string[] } };
      });
      if (validationError) {
        processor.toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: validationError }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: validationError, error: validationError });
        continue;
      }

      if (requiredTool && !processor.requiredToolUsed && toolCallMayMutate(toolName, callInput) && toolName !== requiredTool) {
        const error = `This task must use ${requiredTool} before manual file mutation. Read context/artifacts first if needed, then call ${requiredTool}.`;
        processor.toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, summary: "Required high-level tool not used.", error }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: "Required high-level tool not used.", error });
        continue;
      }

      const projectedSpend = projectedToolSpend(callInput, turnProvider);
      permissionContext.spendState = {
        turnTokens: turnSpendTokens,
        runTokens: runSpendTokens,
        sessionTokens: sessionSpendTokens,
        projectedTokens: projectedSpend.projectedTokens,
        turnUsd: turnSpendUsd,
        runUsd: runSpendUsd,
        sessionUsd: sessionSpendUsd,
        projectedUsd: projectedSpend.projectedUsd,
      };
      const permissionDecision: Decision = tool.canRun
        ? await tool.canRun(callInput, permissionContext)
        : permissionContext.mode === "bypass"
          ? { decision: "allow", reason: "bypass-mode" }
          : decide(toolName, callInput, permissionContext);
      let finalPermissionDecision: Decision = permissionDecision;
      let finalPermissionSource: "user" | "rule" | "engine" | "bypass" = permissionEventSource(permissionDecision, permissionContext.mode);
      if (permissionContext.mode !== "bypass") {
        if (permissionDecision.decision === "ask") {
          const permissionKey = permissionCacheKey(toolName, callInput);
          let cached = permissionAnswers.get(permissionKey);
          if (!cached) {
            await options.sink({ type: "permission_request", ...permissionRequestFromDecision(toolCall.id, toolName, callInput, permissionDecision) });
            const answer = options.onPermissionRequest
              ? await options.onPermissionRequest(permissionRequestFromDecision(toolCall.id, toolName, callInput, permissionDecision))
              : { decision: "deny" as const };
            cached = { answer, source: options.onPermissionRequest ? "user" : "engine" };
            permissionAnswers.set(permissionKey, cached);
          }
          finalPermissionDecision = {
            ...permissionDecision,
            decision: cached.answer.decision,
            reason: cached.answer.decision === "allow" ? "user-approved" : (permissionDecision.reason ?? "permission-denied"),
          };
          finalPermissionSource = cached.source;
          await options.sink({
            type: "permission_decision",
            id: toolCall.id,
            decision: cached.answer.decision,
            source: cached.source,
            ...(cached.answer.persistAs ? { persistAs: cached.answer.persistAs } : {}),
            ...(permissionDecision.matchedRule ? { matchedRule: permissionDecision.matchedRule } : {}),
            ...(permissionDecision.projectedCostUsd !== undefined ? { projectedCostUsd: permissionDecision.projectedCostUsd } : {}),
            ...(permissionDecision.projectedTokens !== undefined ? { projectedTokens: permissionDecision.projectedTokens } : {}),
            ...(permissionDecision.thresholdUsd !== undefined ? { thresholdUsd: permissionDecision.thresholdUsd } : {}),
            ...(permissionDecision.thresholdTokens !== undefined ? { thresholdTokens: permissionDecision.thresholdTokens } : {}),
          });
        } else {
          await options.sink({
            type: "permission_decision",
            id: toolCall.id,
            decision: permissionDecision.decision,
            source: permissionEventSource(permissionDecision, permissionContext.mode),
            ...(permissionDecision.matchedRule ? { matchedRule: permissionDecision.matchedRule } : {}),
            ...(permissionDecision.projectedCostUsd !== undefined ? { projectedCostUsd: permissionDecision.projectedCostUsd } : {}),
            ...(permissionDecision.projectedTokens !== undefined ? { projectedTokens: permissionDecision.projectedTokens } : {}),
            ...(permissionDecision.thresholdUsd !== undefined ? { thresholdUsd: permissionDecision.thresholdUsd } : {}),
            ...(permissionDecision.thresholdTokens !== undefined ? { thresholdTokens: permissionDecision.thresholdTokens } : {}),
          });
        }
      }
      auditPermissionDecision(workspace, permissionContext, toolName, callInput, finalPermissionDecision, finalPermissionSource);
      if (finalPermissionDecision.decision !== "allow") {
        const result = deniedPermissionResult(
          finalPermissionDecision,
          permissionDecision.decision === "ask" ? "permission approval required" : "permission denied",
        );
        processor.toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result.output) });
        await options.sink({
          type: "tool_result",
          id: toolCall.id,
          tool: toolName,
          ok: false,
          summary: result.summary,
          output: result.output,
          error: result.error,
        });
        continue;
      }

      let removeToolAbortListener: (() => void) | undefined;
      try {
        const runRegisteredTool = () => {
          const toolAbortController = new AbortController();
          let cancelRequested = false;
          const requestToolCancellation = () => {
            if (cancelRequested) return;
            cancelRequested = true;
            void Promise.resolve(options.sink({
              type: "tool_cancel_requested",
              toolCallId: toolCall.id,
              tool: toolName,
              timestamp: new Date().toISOString(),
            })).catch(() => {});
            toolAbortController.abort(options.signal?.reason);
          };
          if (options.signal?.aborted) {
            requestToolCancellation();
          } else if (options.signal) {
            options.signal.addEventListener("abort", requestToolCancellation, { once: true });
            removeToolAbortListener = () => options.signal?.removeEventListener("abort", requestToolCancellation);
          }
          return registry.run(tool, callInput, { workspace, runId, runSubAgent: runSubAgentTask, subAgentManager }, {
            signal: toolAbortController.signal,
            onProgress: (progress) => {
              void Promise.resolve(options.sink({
                type: "tool_progress",
                toolCallId: toolCall.id,
                chunk: progress.chunk,
                timestamp: progress.timestamp,
                stream: progress.stream,
              })).catch(() => {});
            },
          });
        };
        await processor.processCall({
          toolCallId: toolCall.id,
          tool,
          toolName,
          callInput,
          turn,
          execute: runRegisteredTool,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        processor.toolErrorCount += 1;
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ ok: false, error: message }) });
        await options.sink({ type: "tool_result", id: toolCall.id, tool: toolName, ok: false, summary: message, error: message });
      } finally {
        removeToolAbortListener?.();
      }
    }

    if (processor.networkFallbackReminderPending && turn < hardCeiling - 1) {
      processor.markNetworkFallbackReminderSent();
      messages.push({ role: "user", content: buildNetworkFallbackReminder() });
      continue;
    }

    const repeatedDuplicateSkips = processor.repeatedDuplicateSkips();
    if (isCodingTask(options.runContext) && repeatedDuplicateSkips >= 1) {
      createdArtifactPaths = uniqueSorted([...createdArtifactPaths, ...await syncArtifactOutput()]);
      const manifest = await buildFinalManifest({
        workspace,
        beforeGitSnapshot,
        changed: processor.changedFiles,
        verificationLines,
        verificationEvents,
        toolErrorCount: processor.toolErrorCount,
        readArtifactPaths: processor.readArtifactPaths,
        readContextPaths: processor.readContextPaths,
        createdArtifactPaths,
        blockers: failedVerificationBlockers(verificationLines, finalText),
        childVerdicts: [...childVerdicts, ...subAgentManager.collectChildVerdicts()],
        runContext: options.runContext,
        prompt: options.prompt,
        runId,
        verifierShell: options.verifierShell,
        runStartedAtMs: runStartedAt.getTime(),
        interactive,
      });
      if (!interactive && commitRepairAttempts < maxCommitRepairAttempts && commitStillRequired(manifest, beforeGitSnapshot, options.runContext)) {
        commitRepairAttempts += 1;
        processor.clearDuplicateSkips();
        messages.push({
          role: "user",
          content: buildCommitRequiredReminder(manifest),
        });
        continue;
      }
      // Run BEFORE buildFallbackCodingReport so the recorded blocker shows.
      const commitIncompleteLead = !interactive && commitStillRequired(manifest, beforeGitSnapshot, options.runContext)
        ? `${markCommitIncomplete(manifest)}\n\n`
        : "";
      const softFinal = softInteractiveFinal();
      const finalMessage = softFinal
        ? assistantText || finalText || "Done."
        : [
            "Finalized after repeated duplicate verification requests.",
            "",
            buildFallbackCodingReport(manifest.changedFiles, verificationLines, processor.toolErrorCount, processor.readArtifactPaths, createdArtifactPaths, options.runContext, manifest.blockers, finalText),
          ].join("\n");
      const interactiveWarning = softFinal ? interactiveCommitWarning(manifest) : "";
      const finalMessageWithFooter = softFinal
        ? (interactiveWarning ? `${finalMessage}\n\n${interactiveWarning}` : finalMessage)
        : `${commitIncompleteLead}${ensureCodingReport(finalMessage, manifest, options.runContext, { concise: interactive, workspace, prompt: options.prompt })}`;
      return finalizeRun(finalMessageWithFooter, manifest);
    }
  }

  // Report why the loop ended. With extension active there is no step limit —
  // the run ends here only because it stalled (no-progress stop or token
  // backstop). Without extension, report the exact cap that was reached.
  const reachedLimit = progressBudget.enabled ? hardCeiling : maxTurns;
  const limitLabel = Number.isFinite(reachedLimit) ? String(reachedLimit) : "unbounded";
  // Tell the user WHAT the run was grinding on, not just that it stalled —
  // "stuck re-running the same failing checks" without naming the check sends
  // them digging through logs for the actual blocker.
  const lastFailedVerification = [...verificationLines].reverse().find((line) => /->\s*failed\b/i.test(line));
  const stuckOnDetail = lastFailedVerification
    ? `\n\nStuck on: ${lastFailedVerification.replace(/^Verification:\s*/i, "").slice(0, 400)}`
    : "";
  const wrapUpDetail = wrapUp
    ? `\n\nA ${WRAP_UP_TURNS}-turn wrap-up window was granted before stopping (directive: commit completed work + final report); check the git log for what it preserved.`
    : "";
  const message = stoppedForStallTokens
    ? interactive
      ? `I stopped this turn because it spent a lot of tokens without making progress (likely stuck re-running the same failing checks). Say "continue" to resume, or adjust the approach.${stuckOnDetail}${wrapUpDetail}`
      : `Stopped: the run spent over ${maxStallTokens.toLocaleString("en-US")} prompt tokens without making progress and was halted to avoid a token runaway. The agent likely stalled re-running failing checks; inspect the verification log.${stuckOnDetail}${wrapUpDetail}`
    : stoppedForNoProgress
      ? interactive
        ? `I paused this turn because the last few steps made no real progress (nothing new succeeded — likely re-running the same checks). Say "continue" to keep going, or tell me what to change in the approach.${stuckOnDetail}${wrapUpDetail}`
        : `Stopped: the run made no progress over its last turns past the soft budget and was halted to avoid a loop. Inspect the verification log and rerun with --retries if appropriate.${stuckOnDetail}${wrapUpDetail}`
      : interactive
        ? `I hit the step limit for this turn (${limitLabel} steps) and stopped here so I don't loop. Say "continue" and I'll pick up where I left off.`
        : `Stopped after reaching the tool-turn limit. (Max dialog turn budget = ${limitLabel}; the agent did not produce a final coding report and may have stalled in a tool-call loop. Inspect the verification log and rerun with --retries if appropriate.)`;
  createdArtifactPaths = uniqueSorted([...createdArtifactPaths, ...await syncArtifactOutput()]);
  const manifest = await buildFinalManifest({
    workspace,
    beforeGitSnapshot,
    changed: processor.changedFiles,
    verificationLines,
    verificationEvents,
    toolErrorCount: processor.toolErrorCount,
    readArtifactPaths: processor.readArtifactPaths,
    readContextPaths: processor.readContextPaths,
    createdArtifactPaths,
    blockers: [
      stoppedForStallTokens
        ? "token budget exhausted before final completion (stalled with no progress)"
        : stoppedForNoProgress
          ? "run stalled with no progress before final completion"
          : "tool-turn limit reached before final completion",
      ...failedVerificationBlockers(verificationLines, finalText),
    ],
    childVerdicts: [...childVerdicts, ...subAgentManager.collectChildVerdicts()],
    runContext: options.runContext,
    prompt: options.prompt,
    terminationReason: "turn_budget_exhausted",
    runId,
    verifierShell: options.verifierShell,
    runStartedAtMs: runStartedAt.getTime(),
    interactive,
  });
  // Stall / turn-budget path — the E1/E8 hole: the run stopped early with files
  // uncommitted and required verify commands unrun. Because buildFinalManifest
  // ran (with gates armed for an interactive task) the blockers are already on
  // the manifest; we just have to SURFACE the report + FAILED verdict here
  // instead of the soft warning.
  const softFinal = softInteractiveFinal();
  const emitCodingReport = (isCodingTask(options.runContext) || interactiveTask()) && !softFinal;
  // Run BEFORE buildFallbackCodingReport so the recorded blocker shows.
  const commitIncompleteLead = !interactive && commitStillRequired(manifest, beforeGitSnapshot, options.runContext)
    ? `${markCommitIncomplete(manifest)}\n\n`
    : "";
  const fallbackReport = emitCodingReport
    ? buildFallbackCodingReport(manifest.changedFiles, verificationLines, processor.toolErrorCount, processor.readArtifactPaths, createdArtifactPaths, options.runContext, manifest.blockers, finalText)
    : "";
  const finalMessage = emitCodingReport
    ? [
        message,
        "",
        fallbackReport,
      ].join("\n")
    : message;
  const interactiveWarning = softFinal ? interactiveCommitWarning(manifest) : "";
  const finalMessageWithFooter = softFinal
    ? (interactiveWarning ? `${finalMessage}\n\n${interactiveWarning}` : finalMessage)
    : `${commitIncompleteLead}${emitCodingReport ? ensureCodingReport(finalMessage, manifest, options.runContext, { concise: interactive, workspace, prompt: options.prompt }) : finalMessage}`;
  return finalizeRun(finalMessageWithFooter, manifest);
}
