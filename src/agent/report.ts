import type { TanyaRunContext } from "../context/runContext";
import type { TanyaFinalManifest } from "./runner";
import type { ChildVerdict, ReasoningAnnotation } from "./verifier/types";
import { verifyFinalState, type VerifierShell } from "./verifier";
import { envValue } from "../config/envCompat";
import { fileTouchPathsFromArchive, readArchive } from "../memory/runArchive";
import { readReasoningArchive } from "../memory/reasoningArchive";
import { validateCodingTask, type ValidationSummary } from "./validators";
import { runtimeDodAssessment } from "./dodGate";
import { cleanTreeTriggered, loadCleanTreeConfig, runCleanTreeBuild, runCommandInDetachedWorktree } from "./cleanTreeBuild";
import {
  allFailingPackagesUntouched,
  isBroadGoTestCommand,
  packagesTouchedByRun,
  parseGoTestFailures,
} from "./baselineFailures";
import { assessCoverage, parseSpecRequirements, renderCoverageTable } from "./specCoverage";
import { stripRecoveryPreamble } from "./recoveryPrompt";
import { doctorReportFooter } from "./doctor/diagnose";
import { additiveEditNudges, collectAdditiveEditRemovals, isAdditiveInstrumentationPrompt } from "./additiveEdit";
import { markRepeatOffenders, recordCoverageHistory } from "./specHistory";
import { evaluateVerifyCommands } from "./verifyGate";
import { armingReason, interactiveTaskGatesArmed, taskCompletionGatesArmed } from "./taskGating";
import { drainProtectHoldLog } from "../tools/toolGate";
import {
  failedVerificationBlockers,
  hasSuccessfulAuthoritativeBuild,
  isExploratoryVerificationBlocker,
  isLastFailedProbeVerificationBlocker,
  isRecoveredVerificationFailure,
  listSecurityCriticalTrackedFiles,
  normalizeVerificationCommand,
  reclassifyExploratoryFailuresAsRecovered,
} from "./verificationRecovery";
import {
  artifactTargetFiles,
  buildArtifactReportLines,
  explicitArtifactReuseLines,
  explicitArtifactReuseLinesForManifest,
  explicitArtifactReuseNone,
  explicitArtifactReuseNoneWithRationale,
  explicitManualCheckLines,
  hasCompleteCodingReport,
  hasRequiredCodingReport,
  normalizeArtifactReuseLines,
  sourceArtifactPath,
  stripConflictingArtifactReuseLines,
  structuredArtifactReuse,
  type StructuredArtifactReuse,
} from "./artifactReuseReport";
// Re-exported for existing importers; the implementations moved in R2b.
export { failedVerificationBlockers, normalizeVerificationCommand } from "./verificationRecovery";
export { hasRequiredCodingReport } from "./artifactReuseReport";
import {
  commitCompletenessSection,
  specCoverageSection,
  validationSection,
  verifyGateSection,
} from "./gateReport";
import { detectStaleBinary } from "./buildInfo";
import {
  captureGitSnapshot,
  changedFilesFromGit,
  committedFilesFromGit,
  commitRequiredForRun,
  commitSummarySince,
  type GitSnapshot,
  isIgnoredReportPath,
  listFilesRecursive,
  normalizeReportFiles,
  normalizeReportPathsForWorkspace,
  pathIsGitTracked,
  promptRequiresCommit,
  repoRootsForPaths,
  runContextRequiresCommit,
  sessionUncommittedFiles,
  strayArtifactsSince,
  uncommittedFilesSince,
  uniqueSorted,
} from "./git";
import { assessVerificationFreshness, type VerificationEvent } from "./verificationFreshness";
import { deferralCitationNudges } from "./deferralCitations";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function collectChangedFiles(existing: string[], next?: string[]): string[] {
  return [...new Set([...existing, ...(next ?? [])].filter((file) => !isIgnoredReportPath(file)))];
}

async function cleanupGeneratedNoise(workspace: string): Promise<void> {
  const generatedFastlanePaths = [
    "fastlane/README.md",
    "fastlane/report.xml",
    "fastlane/test_output",
  ];
  try {
    const entries = await readdir(workspace, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && /^DerivedData(?:[-_].*)?$/i.test(entry.name)) {
        generatedFastlanePaths.push(entry.name);
      }
      if (entry.isDirectory() && /\.xcresult$/i.test(entry.name)) {
        generatedFastlanePaths.push(entry.name);
      }
    }
  } catch {
    // Ignore cleanup discovery failures.
  }
  try {
    for (const relPath of await listFilesRecursive(workspace)) {
      if (/\.(?:orig|bak|backup|tmp)$/i.test(relPath)) generatedFastlanePaths.push(relPath);
    }
  } catch {
    // Ignore recursive cleanup discovery failures.
  }
  for (const relPath of generatedFastlanePaths) {
    const absPath = resolve(workspace, relPath);
    if (!existsSync(absPath)) continue;
    if (await pathIsGitTracked(workspace, relPath)) continue;
    try {
      await rm(absPath, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort. The final manifest/report still filters generated noise.
    }
  }
}

async function fileReportPathIsNotDirectory(workspace: string, filePath: string): Promise<boolean> {
  try {
    return !(await stat(resolve(workspace, filePath))).isDirectory();
  } catch {
    return true;
  }
}

async function normalizeReportFileList(workspace: string, files: string[]): Promise<string[]> {
  const normalized = normalizeReportFiles(files);
  const keep = await Promise.all(normalized.map(async (filePath) => ({
    filePath,
    keep: await fileReportPathIsNotDirectory(workspace, filePath),
  })));
  return keep.filter((entry) => entry.keep).map((entry) => entry.filePath);
}

export function isCodingTask(runContext?: TanyaRunContext): boolean {
  return runContext?.task?.kind === "coding" || Boolean(runContext?.expected_report);
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function verifierReasoningAnnotationsEnabled(runContext?: TanyaRunContext): boolean {
  return truthy(runContext?.metadata?.verboseVerifier) ||
    truthy(runContext?.metadata?.includeReasoningInVerifier) ||
    truthy(envValue(process.env, "TANYA_VERIFIER_INCLUDE_REASONING"));
}

function excerptReasoning(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 280);
}

function buildReasoningAnnotations(params: {
  workspace: string;
  runId?: string;
  blockers: string[];
  runContext?: TanyaRunContext;
}): ReasoningAnnotation[] {
  if (!params.runId || !verifierReasoningAnnotationsEnabled(params.runContext)) return [];
  const entries = readReasoningArchive(params.workspace, params.runId)
    .filter((entry) => !entry.evicted && entry.content.trim().length > 0)
    .slice(-3);
  if (entries.length === 0) return [];
  return entries.map((entry, index) => ({
    runId: entry.runId,
    ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
    provider: entry.provider,
    model: entry.model,
    ...(params.blockers[index] ? { blocker: params.blockers[index] } : {}),
    excerpt: excerptReasoning(entry.content),
    confidence: "advisory",
  }));
}

export function buildFallbackCodingReport(
  changedFiles: string[],
  verificationLines: string[],
  toolErrorCount: number,
  artifactPaths: string[],
  createdArtifactPaths: string[],
  runContext?: TanyaRunContext,
  blockers: string[] = [],
  finalText = "",
): string {
  const artifactLines = buildArtifactReportLines(
    { artifactsRead: artifactPaths.slice(0, 5), changedFiles },
    runContext,
    finalText,
  );
  const artifactCreatedLines = createdArtifactPaths.length > 0
    ? createdArtifactPaths.map((artifactPath) => `Artifact created: ${artifactPath} -> reusable artifact`)
    : ["Artifact created: none"];
  return [
    ...artifactLines,
    ...artifactCreatedLines,
    changedFiles.length === 0
      ? "Verification-only: existing setup satisfied"
      : changedFiles.map((filePath) => `Modified: ${filePath}`).join("\n"),
    verificationLines.length > 0
      ? verificationLines.join("\n")
      : "Verification: not completed -> blocked before verification command was captured",
    toolErrorCount > 0
      ? `Tool errors observed: ${toolErrorCount}`
      : "Tool errors observed: 0",
    blockers.length > 0 ? `Blocked: ${blockers.join("; ")}` : "Blocked: none",
  ].join("\n");
}

const FAILED_VERIFICATION_BLOCKER = /^failed verification:\s*(.+?)\s*->\s*failed\b/i;
const BASELINE_CHECK_TIMEOUT_MS = 180_000;

/**
 * Baseline-aware verification (finalize step, Go-first). A broad `go test`
 * blocker whose failing packages are ALL untouched by this run is very likely
 * someone else's pre-existing red test — the exact shape that stalled a run on
 * `internal/store/apple` while the task never came near that package. "Very
 * likely" is not good enough to silently drop a blocker, so this RE-VERIFIES:
 * (1) re-run the same broad command live, to learn what fails RIGHT NOW (the
 *     historical output from the earlier failed run isn't persisted, and
 *     Go's build/test cache makes a re-run of unchanged packages cheap);
 * (2) if every failing package is untouched, re-run JUST those packages in a
 *     throwaway worktree checked out at the session's STARTING commit.
 * Only a confirmed failure there (pre-existing) removes the blocker — it
 * becomes an honest report note instead. Passing at base means this run
 * introduced the failure (blocker stays, annotated). Any doubt — a touched
 * package, no starting commit to compare against, the worktree itself failing
 * to create — keeps the blocker exactly as it was. Fail-closed throughout;
 * this can only ever REMOVE a blocker under worktree-verified proof, never
 * add false confidence.
 */
async function reclassifyPreExistingGoTestFailures(manifest: TanyaFinalManifest, workspace: string): Promise<void> {
  const baseHead = manifest.sessionBaseHead;
  if (!baseHead) return;
  const candidates = manifest.blockers
    .map((blocker) => ({ blocker, match: blocker.match(FAILED_VERIFICATION_BLOCKER) }))
    .filter((entry): entry is { blocker: string; match: RegExpMatchArray } => !!entry.match)
    .filter((entry) => isBroadGoTestCommand(entry.match[1] ?? ""));
  if (candidates.length === 0) return;
  for (const { blocker, match } of candidates) {
    const label = (match[1] ?? "").trim();
    if (!label) continue;
    let currentOutput = "";
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", label], {
        cwd: workspace,
        timeout: BASELINE_CHECK_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      currentOutput = `${stdout}${stderr}`;
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      currentOutput = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    const failingPackages = parseGoTestFailures(currentOutput);
    // Nothing parseable (e.g. the failure was a setup/compile error with no
    // per-package FAIL lines) — can't attribute responsibility; leave it.
    if (failingPackages.length === 0) continue;
    const touchedDirs = packagesTouchedByRun(manifest.changedFiles);
    // Any failing package this run touched means this run is at least partly
    // responsible — never split a single blocker into "some of it is fine".
    if (!allFailingPackagesUntouched(failingPackages, touchedDirs)) continue;
    const cdPrefix = label.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/);
    const scopedCommand = `${cdPrefix ? cdPrefix[0] : ""}go test ${failingPackages.map((pkg) => `"${pkg}"`).join(" ")}`;
    const baseResult = await runCommandInDetachedWorktree(workspace, baseHead, scopedCommand, BASELINE_CHECK_TIMEOUT_MS);
    if (!baseResult.ran) continue; // couldn't even create the worktree — inconclusive, fail closed
    const shortHead = baseHead.slice(0, 7);
    if (!baseResult.ok) {
      // Fails at base too: pre-existing, unrelated to this run.
      manifest.blockers = manifest.blockers.filter((existing) => existing !== blocker);
      manifest.baselineNotes = [
        ...(manifest.baselineNotes ?? []),
        `Pre-existing test failure (verified at base ${shortHead}): ${failingPackages.join(", ")} — unrelated to this run.`,
      ];
      manifest.gateLog?.push(`baseline: pre-existing (${failingPackages.join(", ")})`);
      if (manifest.gates) manifest.gates.baseline = { status: "pre-existing", packages: failingPackages, baseHead: shortHead };
    } else {
      // Passes at base: this run's changes are what broke it.
      manifest.blockers = manifest.blockers.map((existing) =>
        existing === blocker ? `${existing} — introduced by this run (passes at base ${shortHead})` : existing
      );
      manifest.gateLog?.push(`baseline: introduced (${failingPackages.join(", ")})`);
      if (manifest.gates) manifest.gates.baseline = { status: "introduced", packages: failingPackages, baseHead: shortHead };
    }
  }
}

export async function buildFinalManifest(params: {
  workspace: string;
  beforeGitSnapshot: GitSnapshot | null;
  changed: string[];
  verificationLines: string[];
  // Timestamped mirror of verificationLines (append-only, from runner.ts) —
  // feeds the verification-freshness gate. Optional so direct callers (tests,
  // mcp/verify) skip the gate rather than fabricate timestamps.
  verificationEvents?: VerificationEvent[];
  toolErrorCount: number;
  readArtifactPaths: string[];
  readContextPaths: string[];
  createdArtifactPaths: string[];
  blockers?: string[];
  childVerdicts?: ChildVerdict[];
  runContext?: TanyaRunContext | undefined;
  prompt?: string;
  runId?: string;
  verifierShell?: VerifierShell | undefined;
  terminationReason?: "turn_budget_exhausted" | string | undefined;
  runStartedAtMs?: number;
  interactive?: boolean;
}): Promise<TanyaFinalManifest> {
  await cleanupGeneratedNoise(params.workspace);
  const afterGitSnapshot = await captureGitSnapshot(params.workspace);
  const committedFiles = await committedFilesFromGit(params.beforeGitSnapshot, afterGitSnapshot, params.workspace);
  const uncommittedFiles = uncommittedFilesSince(params.beforeGitSnapshot, afterGitSnapshot, params.workspace);
  const liveChangedFiles = normalizeReportPathsForWorkspace(
    collectChangedFiles(params.changed, await changedFilesFromGit(params.beforeGitSnapshot, params.workspace)),
    afterGitSnapshot,
    params.workspace,
  );
  const reportSourceFiles = (committedFiles.length > 0 || uncommittedFiles.length > 0)
    ? uniqueSorted([...committedFiles, ...uncommittedFiles])
    : liveChangedFiles;
  const reportFiles = await normalizeReportFileList(params.workspace, reportSourceFiles);
  const childVerdicts = (params.childVerdicts ?? []).filter((verdict) => verdict.treatFailureAs !== "ignore");
  const childBlockers = childVerdicts
    .filter((verdict) => verdict.verdict === "failed" && verdict.treatFailureAs === "blocker")
    .map((verdict) => childVerdictMessage(verdict));
  const childWarnings = childVerdicts
    .filter((verdict) => verdict.verdict === "failed" && verdict.treatFailureAs === "warning")
    .map((verdict) => childVerdictMessage(verdict));
  const blockers = uniqueSorted([...(params.blockers ?? []), ...childBlockers]);
  const reasoningAnnotations = buildReasoningAnnotations({
    workspace: params.workspace,
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    blockers,
    ...(params.runContext !== undefined ? { runContext: params.runContext } : {}),
  });
  const manifest: TanyaFinalManifest = {
    schemaVersion: 1,
    changedFiles: reportFiles,
    uncommittedFiles: await normalizeReportFileList(params.workspace, uncommittedFiles),
    artifactsRead: uniqueSorted(params.readArtifactPaths.map((artifactPath) => sourceArtifactPath(artifactPath, params.runContext))),
    artifactsCreated: uniqueSorted(params.createdArtifactPaths),
    contextFilesRead: uniqueSorted(params.readContextPaths),
    verification: params.verificationLines.filter((line) => !isRecoveredVerificationFailure(line, params.verificationLines)),
    git: {
      root: afterGitSnapshot?.repoRoot ?? params.beforeGitSnapshot?.repoRoot ?? null,
      head: afterGitSnapshot?.head ? afterGitSnapshot.head.slice(0, 7) : params.beforeGitSnapshot?.head?.slice(0, 7) ?? null,
    },
    toolErrors: params.toolErrorCount,
    blockers,
    ...((params.childVerdicts ?? []).length > 0
      ? { childRunIds: uniqueSorted((params.childVerdicts ?? []).map((verdict) => verdict.subRunId)) }
      : {}),
    ...(childVerdicts.length > 0 ? { childVerdicts } : {}),
    ...(childWarnings.length > 0 ? { childWarnings: uniqueSorted(childWarnings) } : {}),
    ...(reasoningAnnotations.length > 0 ? { reasoningAnnotations } : {}),
    ...(params.terminationReason !== undefined ? { terminationReason: params.terminationReason } : {}),
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
  };
  // Everything below that parses "the prompt" for TASK semantics (deliverable
  // sections, verify commands, commit intent, task shape) must see the user's
  // original task, never the recovery preamble — the preamble's contract text
  // and embedded doctor prescription otherwise become phantom requirements
  // (r-mrtlzbyi false-FAILed on the prescription's own "Part 2, Part 3").
  const taskPrompt = stripRecoveryPreamble(params.prompt);
  // Intent gating: hold this run to task-completion gates when it is a task —
  // non-interactive runs as before, plus interactive turns that are a real task
  // (the mac app runs everything interactive; see taskGating.ts). This single
  // predicate replaces the scattered `!params.interactive` guards below so a
  // pasted task is gated whatever the transport.
  const armingParams = {
    interactive: params.interactive,
    runContext: params.runContext,
    changed: params.changed,
    prompt: taskPrompt,
  };
  const gatesArmed = taskCompletionGatesArmed(armingParams);
  const interactiveArmed = interactiveTaskGatesArmed(armingParams);
  // Treat as a coding task (run validators + coverage + report) when the
  // runContext says so OR when an interactive task-shaped prompt armed the gates
  // but carried no coding runContext (the coding-intent heuristic missed it).
  const treatAsCodingTask = isCodingTask(params.runContext) || interactiveArmed;
  manifest.gateLog = [`armed=${gatesArmed} interactive=${!!params.interactive} codingTask=${treatAsCodingTask}`];
  // Protected-path write holds the tool gate recorded during this run — the
  // breadcrumb trail for "why did that write fail" forensics.
  if (params.runId) manifest.gateLog.push(...drainProtectHoldLog(params.runId));
  // Additive-edit guard (nudge, never a blocker): an instrumentation-shaped
  // task must not delete existing behaviour — surface every removed
  // non-whitespace line so the report restores or justifies it.
  if ((gatesArmed || interactiveArmed) && taskPrompt && isAdditiveInstrumentationPrompt(taskPrompt)) {
    const removals = await collectAdditiveEditRemovals(params.workspace, params.beforeGitSnapshot, reportFiles);
    const additiveNudges = additiveEditNudges(removals);
    if (additiveNudges.length > 0) {
      manifest.reportNudges = uniqueSorted([...(manifest.reportNudges ?? []), ...additiveNudges]);
      manifest.gateLog.push(`additive-edit: NUDGE (${removals.length} removed line${removals.length === 1 ? "" : "s"})`);
    }
  }
  // Structured, machine-readable mirror of the gate decisions for the run
  // archive (archiveVersion 2). Each gate below fills in its own section — even
  // on pass — so an audit reads the outcome instead of inferring it. Purely
  // observational; the verdict still comes only from manifest.blockers.
  manifest.gates = { armed: gatesArmed, armedReason: armingReason(armingParams) };
  // Stale-binary nudge: a long-lived serve process may be running older code
  // than what is now on disk. Non-gating — recorded here and surfaced as a
  // report nudge for task runs; never a blocker.
  const staleBinary = detectStaleBinary();
  if (staleBinary.stale) manifest.binaryStale = true;
  // Repos this run wrote into — so the archive is discoverable from each (a run
  // driven from a workspace root archives under the workspace, not the repo).
  if (manifest.changedFiles.length > 0) {
    const touched = await repoRootsForPaths(params.workspace, manifest.changedFiles);
    if (touched.length > 0) manifest.touchedRepos = touched;
  }
  // Parse the prompt's deliverable sections for the coverage gate. Only when
  // there are ≥2 unambiguous ones — a lone incidental "Part 1" isn't a spec.
  const specRequirements = parseSpecRequirements(taskPrompt);
  if (specRequirements.length >= 2) manifest.specRequirements = specRequirements;
  // What actually landed this run (SHAs + --stat), for the report honesty block.
  if (afterGitSnapshot?.repoRoot) {
    const commitSummary = await commitSummarySince(
      afterGitSnapshot.repoRoot,
      params.beforeGitSnapshot?.head ?? null,
      afterGitSnapshot.head,
    );
    if (commitSummary) manifest.commitSummary = commitSummary;
  }
  // Session-starting HEAD. Originally scoped to treatAsCodingTask (it seeded
  // the deleted-analytics reachability check below), but baseline-aware
  // verification needs it for ANY run with a go-test blocker — a plain
  // "run the tests" ad-hoc request that the coding-intent heuristic doesn't
  // classify as a coding task can still hit a pre-existing failure. Setting it
  // unconditionally here doesn't change when the validator below actually USES
  // it (still gated by treatAsCodingTask via validateCodingTask).
  if (params.beforeGitSnapshot?.head) manifest.sessionBaseHead = params.beforeGitSnapshot.head;
  if (treatAsCodingTask) {
    const validationRunContext = taskPrompt
      ? {
        ...params.runContext,
        metadata: {
          ...(params.runContext?.metadata ?? {}),
          validationPrompt: taskPrompt,
        },
      }
      : params.runContext;
    // Hand the forbidden-pattern gate the union of changedFiles + committedFiles so
    // it can catch violations introduced by a prior attempt that the current
    // verification-only run did not modify.
    const archivedTouchFiles = params.runId
      ? fileTouchPathsFromArchive(await readArchive(params.runId, { workspace: params.workspace }))
      : [];
    let gateScanFiles = uniqueSorted([...manifest.changedFiles, ...committedFiles, ...archivedTouchFiles]);
    // 2026-05-01 audit gap: in pure verification-only mode (agent confirmed
    // existing code without committing or modifying anything), the gate had
    // nothing to scan and missed pre-existing TODO stubs in security-critical
    // routes. Backfill with the security-critical path globs so the gate can
    // still reject existing violations the agent should have fixed.
    if (gateScanFiles.length === 0) {
      gateScanFiles = await listSecurityCriticalTrackedFiles(params.workspace);
    }
    manifest.validation = await validateCodingTask(params.workspace, manifest, validationRunContext, { gateScanFiles });
    const finalStateVerification = await verifyFinalState({
      workspace: params.workspace,
      runContext: params.runContext,
      prompt: taskPrompt,
      shell: params.verifierShell,
    });
    manifest.finalStateVerification = finalStateVerification;
    // Exploratory probe/bootstrap failures (ls, find, mkdir, cp, sqlc generate,
    // tool installs, …) are moot once the run's real correctness gate passed.
    // Run the cleanup when the final-state verifier's authoritative checks
    // passed OR the inline verification already contains a passing authoritative
    // build. The latter is the common case for mobile (iOS/Android) steps: their
    // final-state verifiers produce no authoritative check (XcodeGen apps have no
    // Package.swift; the Android verifier's only check is non-authoritative), so
    // authoritativePassed is structurally false and this cleanup never ran for
    // them — leaving recoverable probe failures stranded as blockers → FAIL.
    if (finalStateVerification.authoritativePassed || hasSuccessfulAuthoritativeBuild(manifest.verification)) {
      manifest.verification = reclassifyExploratoryFailuresAsRecovered(manifest.verification);
      manifest.blockers = manifest.blockers.filter((blocker) => !isExploratoryVerificationBlocker(blocker));
    }
    // Filter out blockers that match later-passing verification lines (stale failures).
    manifest.blockers = manifest.blockers.filter((blocker) => {
      if (!/^failed verification:/i.test(blocker)) return true;
      const blockerLine = blocker.replace(/^failed verification:\s*/i, "");
      return !isRecoveredVerificationFailure(blockerLine, manifest.verification);
    });
    if (params.terminationReason === "turn_budget_exhausted" && finalStateVerification.authoritativePassed) {
      manifest.blockers = manifest.blockers.filter((blocker) =>
        !isLastFailedProbeVerificationBlocker(blocker, params.verificationLines)
      );
    }
    if (finalStateVerification.newBlockers.length > 0) {
      manifest.blockers = uniqueSorted([...manifest.blockers, ...finalStateVerification.newBlockers]);
    }
    // Definition-of-done runtime gate. "It compiled" is not "it works": for
    // app/UI-shaped tasks, require the running app's behaviour to have actually
    // been exercised. A real, observed runtime failure (from `tanya test-app`)
    // becomes a gating blocker; merely-not-yet-verified behaviour is a
    // non-gating nudge (manifest.runtimeUnverified) so a working app can never
    // be false-FAILed for lack of proof. See dodGate.ts for the contract.
    const dod = await runtimeDodAssessment({
      prompt: taskPrompt,
      isCoding: true,
      workspace: params.workspace,
      sinceMs: params.runStartedAtMs ?? 0,
    });
    if (dod.blockers.length > 0) {
      manifest.blockers = uniqueSorted([...manifest.blockers, ...dod.blockers]);
    }
    if (dod.unverified) {
      manifest.runtimeUnverified = true;
      if (dod.unverifiedReason) manifest.runtimeUnverifiedReason = dod.unverifiedReason;
    }
  }
  // Verify-gate: commands the task's `## Verify` / `## Acceptance` section (and
  // any triggered boot-smoke check) require must have passing evidence in the
  // verification log. A required command with no passing line means the check
  // was skipped — the exact failure that broke the API. Armed for any task run
  // (interactive task or non-interactive); opt out with metadata.verifyGate === false.
  if (gatesArmed && params.runContext?.metadata?.verifyGate !== false) {
    const verdicts = await evaluateVerifyCommands(
      taskPrompt,
      manifest.changedFiles,
      manifest.verification,
      params.workspace,
    );
    if (manifest.gates) manifest.gates.verifyGate = verifyGateSection(verdicts);
    const unexecuted = verdicts.filter((verdict) => !verdict.verified).map((verdict) => verdict.cmd);
    if (unexecuted.length > 0) {
      manifest.blockers = uniqueSorted([
        ...manifest.blockers,
        `Verify step(s) not executed with passing evidence: ${unexecuted.map((c) => `\`${c}\``).join(", ")}. Run each required check and include its pass/fail, or state explicitly why it cannot run here — never report success with a required verification unrun.`,
      ]);
      manifest.gateLog?.push(`verify-gate: FAIL (${unexecuted.length} unrun)`);
    }
  }
  // Commit-completeness gate (every repo the run wrote into, not just the cwd).
  // A non-interactive run that is required to commit must leave NO file it wrote
  // dirty — this is the only check that catches a committed file referencing an
  // untracked sibling (green locally, broken from a clean checkout) and a second
  // nested repo left dirty. Non-interactive: armed by commitRequiredForRun
  // (default-on ad-hoc, opt-in pipeline). Interactive: armed when the turn is a
  // task that wrote files — the mac-app hole that let three runs ship a
  // deliverable untracked (see gate-escape E1/E6).
  // Plus: the PROMPT itself instructing a commit arms the gate whatever the
  // runContext says (the audited FinanceWorld run's prompt said commit, its
  // pipeline runContext carried no commit flags, so the gate stayed disarmed
  // and nothing was committed under a green report). The documented
  // programmatic opt-out (`metadata.requireCommit === false`) still wins for
  // pipelines that manage git themselves.
  const promptArmsCommit =
    gatesArmed &&
    params.changed.length > 0 &&
    params.runContext?.metadata?.requireCommit !== false &&
    promptRequiresCommit(taskPrompt);
  const commitGateArmed = promptArmsCommit || (params.interactive
    ? interactiveArmed && params.changed.length > 0
    : commitRequiredForRun(params.runContext, params.changed.length > 0));
  if (promptArmsCommit) manifest.gateLog?.push("commit-gate: armed by prompt commit instruction");
  if (commitGateArmed) {
    const uncommittedByRepo = await sessionUncommittedFiles(params.workspace, params.changed);
    if (manifest.gates) manifest.gates.commitCompleteness = commitCompletenessSection(uncommittedByRepo);
    if (uncommittedByRepo.length > 0) {
      const detail = uncommittedByRepo
        .map(({ repoRoot, files }) => `${repoRoot} → ${files.join(", ")}`)
        .join(" | ");
      manifest.blockers = uniqueSorted([
        ...manifest.blockers,
        `Commit incomplete: files this run wrote are still uncommitted (untracked or unstaged) and would be missing from a clean checkout — ${detail}. git add the exact paths and commit them.`,
      ]);
      manifest.uncommittedSessionFiles = uncommittedByRepo;
      manifest.gateLog?.push(`commit-completeness: FAIL (${uncommittedByRepo.reduce((n, r) => n + r.files.length, 0)} uncommitted)`);
    }
  }
  // Clean-tree build (opt-in per repo). Rebuild the COMMITTED HEAD in a throwaway
  // worktree — the only check that catches a committed file referencing an
  // untracked one (green locally, broken from a clean checkout). Runs only when
  // configured, a commit actually landed, the trigger matches, and the run is a
  // gated task (interactive task or non-interactive). Opt-in per repo, so a
  // casual run never pays the build cost unless the repo asks for it.
  const headMoved =
    gatesArmed &&
    !!params.beforeGitSnapshot?.head &&
    !!afterGitSnapshot?.head &&
    params.beforeGitSnapshot.head !== afterGitSnapshot.head;
  if (headMoved && afterGitSnapshot?.head) {
    const cleanCfg = await loadCleanTreeConfig(params.workspace);
    if (cleanCfg && cleanTreeTriggered(cleanCfg, manifest.changedFiles)) {
      const result = await runCleanTreeBuild(params.workspace, afterGitSnapshot.head, cleanCfg);
      if (result.ran && !result.ok) {
        manifest.blockers = uniqueSorted([
          ...manifest.blockers,
          `Clean-tree build FAILED: the committed tree does not build from a fresh checkout (\`${cleanCfg.command}\`). The working-tree build was only green because of uncommitted/untracked files. Commit the missing files or fix the committed code. Output tail:\n${result.output}`,
        ]);
        manifest.gateLog?.push("clean-tree-build: FAIL");
        if (manifest.gates) manifest.gates.cleanTreeBuild = { status: "fail", detail: `\`${cleanCfg.command}\` failed from a fresh checkout` };
      } else if (result.ran && manifest.gates) {
        manifest.gates.cleanTreeBuild = { status: "pass", detail: `\`${cleanCfg.command}\` built from a fresh checkout` };
      }
    }
  }
  // Verification freshness (hard): a passing build/verify is proof only for
  // the code that existed when it ran. Any changed SOURCE file whose mtime is
  // newer than the last green authoritative build invalidates that evidence —
  // the audited failure edited a .swift file two hours after the last green
  // xcodebuild and shipped a broken repo under "BUILD SUCCEEDED". Fail-open by
  // design: no green build event → skipped; a finalize-time authoritative pass
  // (final-state verifier, which runs after every edit) → fresh. Opt out with
  // metadata.freshnessGate === false.
  if (
    gatesArmed &&
    manifest.changedFiles.length > 0 &&
    params.runContext?.metadata?.freshnessGate !== false
  ) {
    const freshness = await assessVerificationFreshness({
      workspace: params.workspace,
      changedFiles: manifest.changedFiles,
      events: params.verificationEvents ?? [],
      finalStateFresh: manifest.finalStateVerification?.authoritativePassed === true,
    });
    if (manifest.gates && freshness.status !== "skipped") {
      manifest.gates.verificationFreshness = {
        status: freshness.status,
        staleFiles: freshness.staleFiles,
        ...(freshness.lastGreenAtMs !== null ? { lastGreenAt: new Date(freshness.lastGreenAtMs).toISOString() } : {}),
      };
    }
    if (freshness.status === "fail") {
      manifest.blockers = uniqueSorted([
        ...manifest.blockers,
        `Stale build evidence: ${freshness.staleFiles.join(", ")} changed AFTER the last passing build/verify — that green result does not cover the current code. Re-run the build/tests so the evidence matches what is being delivered, then report.`,
      ]);
      manifest.gateLog?.push(`verification-freshness: FAIL (${freshness.staleFiles.length} stale)`);
    }
  }
  // Artifact hygiene (nudge, never gates): dirty paths that appeared during
  // the run but belong to no declared deliverable — a subprocess scaffold like
  // the audited stray `fastlane/` from an aborted init. These never enter the
  // mutation write-log, so the commit gate cannot see them; the snapshot diff
  // can. The agent removes them or justifies them in the report.
  if (gatesArmed) {
    // Attribution is the DECLARED set only: the mutation write-log + created
    // artifacts. NOT manifest.changedFiles — that is derived from the git diff,
    // so it contains the very subprocess scaffolds this nudge exists to catch.
    const strays = strayArtifactsSince(params.beforeGitSnapshot, afterGitSnapshot, [
      ...params.changed,
      ...manifest.artifactsCreated,
    ]);
    if (strays.length > 0) {
      manifest.reportNudges = uniqueSorted([
        ...(manifest.reportNudges ?? []),
        `stray artifacts: ${strays.join(", ")} appeared in the tree this run but are not declared deliverables — remove them or justify each in the report.`,
      ]);
      if (manifest.gates) manifest.gates.artifactHygiene = { strays };
      manifest.gateLog?.push(`artifact-hygiene: NUDGE (${strays.length} stray)`);
    }
  }
  // Baseline-aware verification: the last step, so it reclassifies the FINAL
  // blocker set (including anything the clean-tree gate just added above).
  await reclassifyPreExistingGoTestFailures(manifest, params.workspace);
  return manifest;
}


type TanyaStructuredReport = {
  schemaVersion: 1;
  modified: string[];
  artifactsReused: StructuredArtifactReuse[];
  artifactsCreated: string[];
  verification: string[];
  manualChecks: string[];
  blocked: string[];
  blockers: string[];
  warnings: string[];
  childVerdicts: ChildVerdict[];
  validation: ValidationSummary;
  git: TanyaFinalManifest["git"];
  metrics: {
    toolErrors: number;
  };
};


function buildStructuredReport(manifest: TanyaFinalManifest, runContext?: TanyaRunContext, finalText = ""): TanyaStructuredReport {
  const validationBlockers = (manifest.validation?.issues ?? [])
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.id}: ${issue.message}`);
  const blocked = uniqueSorted([...manifest.blockers, ...validationBlockers]);
  const artifactsReused = structuredArtifactReuse(manifest, runContext, finalText);
  const hasStrictArtifactMapping = manifest.artifactsRead.some((artifactPath) =>
    /artifacts\/(?:ios\/(?:FastlaneSetup\.md|SplashScreenPattern\.swift)|android\/(?:FastlaneSetup\.md|PlayRelease_ManualSteps\.md|SplashScreenPattern\.kt|ThemeSystem\.kt|NavigationSetup\.kt|RoomSetup\.kt|FeatureScreenPatterns\.kt|OfflineCachePatterns\.kt)|backend\/(?:JwtAuthRoutes\.ts|OpenApiSwaggerRoutes\.ts|PrismaBase\.prisma|EnvExample\.txt)|testing\/MobileCIWorkflows\.md)$|\.tanya\/artifacts\/(?:ios\/(?:FastlaneSetup\.md|SplashScreenPattern\.swift)|android\/(?:FastlaneSetup\.md|PlayRelease_ManualSteps\.md|SplashScreenPattern\.kt|ThemeSystem\.kt|NavigationSetup\.kt|RoomSetup\.kt|FeatureScreenPatterns\.kt|OfflineCachePatterns\.kt)|backend\/(?:JwtAuthRoutes\.ts|OpenApiSwaggerRoutes\.ts|PrismaBase\.prisma|EnvExample\.txt)|testing\/MobileCIWorkflows\.md)$/.test(artifactPath)
  );
  const explicitNoneOnly = explicitArtifactReuseNoneWithRationale(finalText)
    && explicitArtifactReuseLines(finalText).length === 0
    && artifactsReused.length === 0
    && !/Verification:\s*not completed\s*->\s*blocked before verification command was captured/i.test(finalText)
    && !manifest.artifactsRead.some((artifactPath) => finalText.includes(sourceArtifactPath(artifactPath, runContext)));
  const inferredArtifactsReused = manifest.artifactsRead.flatMap((artifactPath): StructuredArtifactReuse[] => {
      const targets = artifactTargetFiles(artifactPath, manifest.changedFiles);
      if (targets.length === 0) return [];
      return [{ artifact: sourceArtifactPath(artifactPath, runContext), targets }];
    });
  const repairedArtifactsReused = explicitNoneOnly
    ? []
    : inferredArtifactsReused.length > 0
      ? inferredArtifactsReused
      : artifactsReused;
  return {
    schemaVersion: 1,
    modified: manifest.changedFiles,
    artifactsReused: repairedArtifactsReused,
    artifactsCreated: manifest.artifactsCreated,
    verification: manifest.verification,
    manualChecks: explicitManualCheckLines(finalText),
    blocked,
    blockers: blocked,
    warnings: manifest.childWarnings ?? [],
    childVerdicts: manifest.childVerdicts ?? [],
    validation: manifest.validation ?? { passed: true, issues: [] },
    git: manifest.git,
    metrics: {
      toolErrors: manifest.toolErrors,
    },
  };
}

function buildDeterministicCodingFooter(manifest: TanyaFinalManifest, runContext?: TanyaRunContext, finalText = "", concise = false): string {
  const structuredReport = buildStructuredReport(manifest, runContext, finalText);
  const artifactLines = structuredReport.artifactsReused.length > 0
    ? structuredReport.artifactsReused.map((entry) => `Artifact reused: ${entry.artifact} -> ${entry.targets.length > 0 ? entry.targets.join(", ") : "verification-only"}`)
    : ["Artifact reused: none"];
  const artifactCreatedLines = structuredReport.artifactsCreated.length > 0
    ? structuredReport.artifactsCreated.map((artifactPath) => `Artifact created: ${artifactPath} -> reusable artifact`)
    : ["Artifact created: none"];
  const modifiedLines = structuredReport.modified.length > 0
    ? structuredReport.modified.map((filePath) => `Modified: ${filePath}`)
    : ["Modified: none", "Verification-only: existing setup satisfied"];
  const verification = structuredReport.verification.length > 0
    ? structuredReport.verification
    : ["Verification: not completed -> blocked before verification command was captured"];
  const coverageLines = manifest.specCoverage && manifest.specCoverage.length > 0
    ? [renderCoverageTable(manifest.specCoverage), ""]
    : [];
  // Non-gating staleness nudge: this serve process is running older code than
  // what is now on disk. Prominent, but never a blocker (see buildInfo.ts).
  const staleLines = manifest.binaryStale
    ? ["⚠ Stale binary: this Tanya serve process is running an older build than the one on disk — restart the session to pick up the newer code (gate fixes included).", ""]
    : [];
  // Gate results, rendered human-readably (previously only in the JSON dump).
  const gateLines = manifest.validation
    ? manifest.validation.issues.length > 0
      ? [
        `Gate results: ${manifest.validation.passed ? "passed (warnings only)" : "FAILED"}`,
        ...manifest.validation.issues.map((issue) =>
          `- [${issue.severity}] ${issue.id}: ${issue.message}${issue.files && issue.files.length > 0 ? ` (${issue.files.join(", ")})` : ""}`
        ),
      ]
      : ["Gate results: passed"]
    : [];
  // What actually landed (SHAs + --stat) — the honest counterpart to prose claims.
  const commitLines = manifest.commitSummary
    ? ["Commits this run:", ...manifest.commitSummary.split(/\r?\n/).map((line) => `  ${line}`)]
    : [];
  // Baseline-aware verification: a failing test worktree-verified as
  // pre-existing (unrelated to this run) was removed from Blocked — surface
  // it here so the report stays honest about a repo-wide red test without
  // gating a run that isn't responsible for it.
  const baselineLines = manifest.baselineNotes && manifest.baselineNotes.length > 0
    ? manifest.baselineNotes.map((note) => `Note: ${note}`)
    : [];
  // Honesty-gate nudges (artifact hygiene, deferral citations, prerequisite
  // downgrades) — visible in the report, never blockers.
  const nudgeLines = manifest.reportNudges && manifest.reportNudges.length > 0
    ? manifest.reportNudges.map((note) => `Note: ${note}`)
    : [];
  // Assumptions the agent declared about external behaviour it did not verify.
  const assumptions = [...finalText.matchAll(/^\s*ASSUMPTION:\s*(.+)$/gim)]
    .map((match) => match[1]?.trim())
    .filter((line): line is string => !!line);
  const assumptionLines = assumptions.length > 0
    ? ["Assumptions (declared, unverified):", ...uniqueSorted(assumptions).map((line) => `- ${line}`)]
    : [];
  return [
    "## Tanya deterministic report",
    "_(authoritative — overrides any conflicting artifact reuse or modification claim above)_",
    ...staleLines,
    ...coverageLines,
    ...artifactLines,
    ...artifactCreatedLines,
    ...modifiedLines,
    ...verification,
    ...gateLines,
    ...(structuredReport.childVerdicts.length > 0
      ? ["Subagent verdicts:", ...structuredReport.childVerdicts.map(childVerdictLine)]
      : []),
    ...(structuredReport.warnings.length > 0
      ? ["Warnings:", ...structuredReport.warnings.map((warning) => `- ${warning}`)]
      : []),
    ...(manifest.reasoningAnnotations && manifest.reasoningAnnotations.length > 0
      ? [
        "Reasoning annotations (advisory, not verifier authority):",
        ...manifest.reasoningAnnotations.map((annotation) =>
          `- Why the agent thought this (${annotation.provider}/${annotation.model}, ${annotation.confidence}): ${annotation.excerpt}`
        ),
      ]
      : []),
    ...structuredReport.manualChecks,
    `Verification: git rev-parse --show-toplevel -> ${structuredReport.git.root ?? "unavailable"}`,
    `Verification: git rev-parse --short HEAD -> ${structuredReport.git.head ?? "unavailable"}`,
    ...commitLines,
    ...baselineLines,
    ...nudgeLines,
    structuredReport.blocked.length > 0 ? `Blocked: ${structuredReport.blocked.join("; ")}` : "Blocked: none",
    ...assumptionLines,
    // The raw JSON dumps are for the CLI / pipeline consumers. Interactive
    // (mac-app) reports render concise — the dumps would flood the chat
    // transcript — but still carry the coverage table, gate results, commit SHAs
    // and the verdict, which is what makes the run honest.
    ...(concise ? [] : [
      "Tanya structured report:",
      JSON.stringify(structuredReport, null, 2),
      "Tanya manifest:",
      JSON.stringify(manifest, null, 2),
    ]),
  ].join("\n");
}

function childVerdictMessage(verdict: ChildVerdict): string {
  const detail = verdict.blockers.join("; ") || verdict.summary || "failed";
  return `subtask ${verdict.subRunId} failed: ${detail}`;
}

function childVerdictLine(verdict: ChildVerdict): string {
  const name = verdict.label ?? verdict.subRunId;
  const backendTag = verdict.backend ? ` (${verdict.backend})` : "";
  const runIdSuffix = verdict.subRunId ? ` [${verdict.subRunId}]` : "";
  return `- ${name}${backendTag}: ${verdict.verdict.toUpperCase()}${runIdSuffix}`;
}

function appendTaniaResultLine(text: string, verdict: "PASSED" | "FAIL"): string {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => !/^TANYA RESULT:\s*(?:PASSED|FAIL)\s*$/i.test(line.trim()));
  return [...lines, `TANYA RESULT: ${verdict}`].join("\n").trim();
}

function manifestVerdict(manifest: TanyaFinalManifest): "PASSED" | "FAIL" {
  // Real failures gate here. Authoritative final-state check failures are not
  // missed: ensureManifest merges finalStateVerification.newBlockers into
  // manifest.blockers (see report finalize step), so a verifier that actually
  // fails surfaces as a blocker below.
  if (manifest.blockers.length > 0) return "FAIL";
  // NOTE: we intentionally do NOT fail on finalStateVerification.authoritativePassed
  // being false. authoritativePassed is `authoritativeChecks.length > 0 && every(pass)`,
  // so it is false whenever NO builtin verifier applied — e.g. an XcodeGen iOS app
  // with no Package.swift, where appliesTo() matches nothing. That is an
  // inconclusive final state, not a failure: the run's inline verification
  // (build/test commands) and the blocker list already gate correctness.
  // Treating an empty final-state set as FAIL produced false negatives on
  // otherwise-green runs (build succeeded, validation passed, zero blockers).
  return "PASSED";
}

export function ensureCodingReport(
  text: string,
  manifest: TanyaFinalManifest,
  runContext?: TanyaRunContext,
  options: { concise?: boolean; workspace?: string; prompt?: string | undefined } = {},
): string {
  // Spec-coverage gate. The report text is the accounting surface: assess each
  // parsed deliverable against it BEFORE the verdict, so an unaccounted (pending)
  // requirement pushes a blocker → FAIL and drives the repair loop to make the
  // agent state coverage. Must run before manifestVerdict below.
  if (manifest.specRequirements && manifest.specRequirements.length > 0) {
    let coverage = assessCoverage(manifest.specRequirements, text);
    // Repeat-offense: an item unfinished in a recent prior run is the highest-
    // signal thing not to drop again — mark it so the table flags the recurrence.
    if (options.workspace) coverage = markRepeatOffenders(options.workspace, manifest.specRequirements, coverage);
    manifest.specCoverage = coverage;
    if (manifest.gates) manifest.gates.specCoverage = specCoverageSection(coverage);
    if (options.workspace) recordCoverageHistory(options.workspace, coverage);
    const pending = coverage.filter((item) => item.status === "pending");
    if (pending.length > 0) {
      manifest.blockers = uniqueSorted([
        ...manifest.blockers,
        `Spec coverage incomplete: ${pending.length} required deliverable(s) not accounted for in the report — ${pending.map((p) => p.id).join(", ")}. Do each one and cite the evidence, or state explicitly why it was skipped.`,
      ]);
      manifest.gateLog?.push(`spec-coverage: FAIL (${pending.length} pending)`);
    }
    // Prerequisite honesty (nudge): a conditional item claimed done over an
    // unevidenced prerequisite was downgraded to skipped by assessCoverage —
    // surface WHY, and forbid the workaround the audited run used (implementing
    // a slice of the OTHER prompt just to green the checkbox).
    const downgraded = coverage.filter((item) => item.prerequisiteUnmet);
    if (downgraded.length > 0) {
      manifest.reportNudges = uniqueSorted([
        ...(manifest.reportNudges ?? []),
        ...downgraded.map((item) =>
          `prerequisite honesty: ${item.id} depends on ${manifest.specRequirements?.find((r) => r.id === item.id)?.conditionalOn ?? "another prompt's deliverable"} which is not evidenced as landed — treated as skipped, not done. Never implement another prompt's steps just to satisfy a checklist item; state the unmet prerequisite instead.`,
        ),
      ]);
      manifest.gateLog?.push(`prerequisite-honesty: NUDGE (${downgraded.length} downgraded)`);
    }
  }
  // Deferral citations (nudge): every scope-claimed deferral must quote prompt
  // text that actually exists — the audited run fabricated a "Tier 3" scope
  // quote to justify skipping a required item. Runs on the report BODY before
  // the footer is appended, so the coverage table's own rows are never scanned.
  const deferralTaskPrompt = stripRecoveryPreamble(options.prompt);
  if (deferralTaskPrompt) {
    const deferralNudges = deferralCitationNudges(text, deferralTaskPrompt);
    if (deferralNudges.length > 0) {
      manifest.reportNudges = uniqueSorted([...(manifest.reportNudges ?? []), ...deferralNudges]);
      if (manifest.gates) manifest.gates.deferralCitations = { nudges: deferralNudges };
      manifest.gateLog?.push(`deferral-citations: NUDGE (${deferralNudges.length})`);
    }
  }
  // FIX-E: a GATING validator ERROR must flip the verdict, not just the footer.
  // manifestVerdict only reads manifest.blockers, so without this the badge could
  // read PASSED while "Gate results: FAILED" lists an unrepaired objective miss
  // (the localization escape, E2). Only `gating` errors (the zero-false-positive
  // static checks) are promoted — heuristic validators keep driving repair
  // without gating the verdict, so a working app is never false-failed.
  const gatingErrors = (manifest.validation?.issues ?? []).filter((issue) => issue.severity === "error" && issue.gating);
  if (manifest.gates) manifest.gates.validation = validationSection(gatingErrors.map((issue) => `${issue.id}: ${issue.message}`));
  if (gatingErrors.length > 0) {
    manifest.blockers = uniqueSorted([
      ...manifest.blockers,
      ...gatingErrors.map((issue) => `${issue.id}: ${issue.message}`),
    ]);
    manifest.gateLog?.push(`validation: FAIL (${gatingErrors.length} gating error${gatingErrors.length === 1 ? "" : "s"})`);
  }
  const verdict = manifestVerdict(manifest);
  // FAIL reports point at `tanya doctor` — inserted before the result line at
  // this seam (shared by the native runner and the external-backend path) so
  // every entrypoint's FAIL report carries it. Informational only: it never
  // touches blockers or the verdict.
  const finish = (body: string): string => {
    const trimmed = body.trim();
    const withDoctor = verdict === "FAIL" && manifest.runId && !trimmed.includes("tanya doctor --run")
      ? `${trimmed ? `${trimmed}\n\n` : ""}${doctorReportFooter(manifest.runId)}`
      : body;
    return appendTaniaResultLine(withDoctor, verdict);
  };
  if (!manifest.changedFiles.length && !manifest.artifactsRead.length && !manifest.artifactsCreated.length && !manifest.verification.length && !manifest.git.root) return finish(text);
  const normalizedText = normalizeArtifactReuseLines(text);
  const bodyText = stripConflictingArtifactReuseLines(normalizedText, manifest, !!runContext?.expected_report?.artifact_reuse);
  const explicitReuseLines = explicitArtifactReuseLinesForManifest(normalizedText, manifest, runContext);
  const footerSourceText = explicitReuseLines.length > 0
    ? normalizedText
    : manifest.artifactsRead.length > 0 && !explicitArtifactReuseNone(normalizedText)
      ? bodyText
    : normalizedText;
  const footer = buildDeterministicCodingFooter(manifest, runContext, footerSourceText, options.concise);
  if (isCodingTask(runContext) && runContext?.expected_report && runContextRequiresCommit(runContext) && manifest.git.head) return finish(footer);
  const needsManualCheckLines = /^#{1,6}\s*(?:Manual (?:checks?|testing)|What to test manually)\b/im.test(bodyText) && !/^Manual check:\s*/im.test(bodyText);
  if (/Tanya manifest:/i.test(bodyText) || /## Tanya deterministic report/i.test(bodyText)) return finish(bodyText);
  if (hasCompleteCodingReport(bodyText) && !needsManualCheckLines) return finish(`${bodyText.trim()}\n\n${footer}`);
  return finish(bodyText.trim() ? `${bodyText.trim()}\n\n${footer}` : footer);
}
