import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envValue } from "../config/envCompat";
import { offFlag } from "../config/runtimeFlags";
import { ledgerDigestForRun } from "./runLedger";
import { collectEvidence, classifyEvidence, buildDiagnosis } from "./doctor/diagnose";
import type { TanyaRunContext } from "../context/runContext";
import type { EventSink } from "../events/types";

// ---------------------------------------------------------------------------
// Recovery preflight: detect a failed run's LAST_RUN_FAILED.md sentinel at
// run start, call the doctor for a diagnosis, and return a RECOVERY block
// to be prepended to the task prompt. Called from BOTH runAgentCore (native
// runner) and runWithExternalBackendCore (external executors).
// ---------------------------------------------------------------------------

export type RecoveryPreflightResult = {
  /** The RECOVERY block to prepend to the prompt. */
  recoveryBlock: string;
  /** The failed run's id. */
  runId: string;
  /** Doctor failure classes from the failed run. */
  classes: string[];
  /** Recovery attempts already made before this run (from the marker). The
   *  current run is attempt `attempts + 1`; the finalize marker records that
   *  number so consecutive non-converging recoveries can be braked. */
  attempts: number;
  /** True when the brake engaged: the block replaces the normal contract with
   *  a commit-and-stop contract because prior recoveries did not converge. */
  braked: boolean;
};

/** A 3rd consecutive recovery attempt gets the brake: two full recovery runs
 *  already failed to converge, so grinding the whole task again mostly burns
 *  budget (observed 2026-07-20: three budget-exhausted recovery runs in a
 *  row). The braked contract is commit-what-is-green + report + NEEDS USER. */
const RECOVERY_BRAKE_AFTER_ATTEMPTS = 2;

/** Parse the runId from a LAST_RUN_FAILED.md marker. The beta.28 structured
 *  format includes `- runId: <id>`; the beta.21/25 legacy format is a simple
 *  paragraph. */
function parseRunIdFromMarker(content: string): string | null {
  const match = content.match(/runId:\s*(\S+)/);
  if (match?.[1]) return match[1];
  return null;
}

/** Parse how many recovery attempts were already made (beta.32 marker line
 *  `- recoveryAttempts: N`). Markers from older betas have no line → 0. */
function parseRecoveryAttemptsFromMarker(content: string): number {
  const match = content.match(/recoveryAttempts:\s*(\d+)/);
  const value = match?.[1] ? Number(match[1]) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Check the opt-out: TANYA_RECOVERY=off env or metadata.recovery: false. */
function isRecoveryDisabled(runContext?: TanyaRunContext): boolean {
  if (!offFlag("TANYA_RECOVERY")) return true;
  if (runContext?.metadata?.recovery === false) return true;
  return false;
}

/**
 * Run the recovery preflight for a workspace.
 *
 * Returns `null` when recovery is not needed (no marker, recovery disabled,
 * or the marker exists but the tree is already healthy and there's nothing
 * the doctor can prescribe).
 *
 * Returns a `RecoveryPreflightResult` when the marker is present AND the
 * doctor found actionable evidence. The caller prepends the `recoveryBlock`
 * to the user's task prompt.
 */
export function recoveryPreflight(
  workspace: string,
  opts?: { runContext?: TanyaRunContext; sink?: EventSink },
): RecoveryPreflightResult | null {
  // 1. Opt-out check
  if (isRecoveryDisabled(opts?.runContext)) return null;

  // 2. Check for the marker
  const markerPath = join(workspace, ".tanya", "LAST_RUN_FAILED.md");
  if (!existsSync(markerPath)) return null;

  // 3. Read the marker for the runId + prior recovery attempts
  let failedRunId = "unknown";
  let attempts = 0;
  try {
    const content = readFileSync(markerPath, "utf8");
    const parsed = parseRunIdFromMarker(content);
    if (parsed) failedRunId = parsed;
    attempts = parseRecoveryAttemptsFromMarker(content);
  } catch {
    // Marker is unreadable — proceed with unknown id
  }

  // Brake: prior recovery runs already failed to converge. Do NOT re-prepend
  // the full recovery-then-task contract a third time — replace it with a
  // commit-and-stop contract so the run finalizes fast and hands control back.
  // Ledger digest: what the failed run PROVABLY did (commits, green checks),
  // recorded live as it happened. Prepended context for every recovery shape
  // so the recovery run resumes instead of re-deriving.
  const digest = failedRunId !== "unknown" ? ledgerDigestForRun(workspace, failedRunId) : null;
  const withDigest = (block: string): string => (digest ? `${block}\n\n${digest}` : block);

  if (attempts >= RECOVERY_BRAKE_AFTER_ATTEMPTS) {
    const recoveryBlock = withDigest(buildBrakeBlock(failedRunId, attempts));
    void opts?.sink?.({
      type: "status",
      message: `recovery brake: ${attempts} recovery attempts without convergence — commit-and-stop contract`,
    });
    return { recoveryBlock, runId: failedRunId, classes: [], attempts, braked: true };
  }

  // 4. Diagnose via the doctor — don't reinvent
  let collected: { runId: string; evidence: ReturnType<typeof collectEvidence>["evidence"] };
  try {
    const doctorOpts: { cwd: string; runId?: string } = { cwd: workspace };
    if (failedRunId !== "unknown") doctorOpts.runId = failedRunId;
    collected = collectEvidence(doctorOpts);
  } catch {
    // Doctor collection failed (e.g. no runs dir, corrupt archive) — we still
    // have a marker, so emit a minimal recovery block from what we know.
    const recoveryBlock = withDigest(buildMinimalRecoveryBlock(failedRunId, attempts));
    return { recoveryBlock, runId: failedRunId, classes: [], attempts, braked: false };
  }

  const classes = classifyEvidence(collected.evidence);
  const diagnosis = buildDiagnosis(collected.runId, collected.evidence, classes);

  // 5. Build the recovery block
  const recoveryBlock = withDigest(buildRecoveryBlock(failedRunId, classes, diagnosis.repairPrompt, attempts));

  // Emit a progress line so the app shows why the run is building first
  void opts?.sink?.({ type: "status", message: `recovering from failed run ${failedRunId}` });

  return { recoveryBlock, runId: failedRunId, classes, attempts, braked: false };
}

/** Build the RECOVERY block prepended to the task prompt.
 *
 *  Progress-preserving by design: a failed run's tree usually holds FINISHED
 *  work that simply never got committed (budget death), not damage. The old
 *  contract ("repair or revert leftover damage", full re-audit before the
 *  task) made recovery runs re-derive everything and starve — three
 *  consecutive budget-exhausted recoveries on 2026-07-20. The contract now
 *  leads with committing completed work and forbids re-auditing done parts. */
function buildRecoveryBlock(runId: string, classes: string[], repairPrompt: string, attempts: number): string {
  const lines: string[] = [];

  lines.push("## RECOVERY MODE — last run failed", "");
  if (runId !== "unknown") {
    lines.push(`Previous run \`${runId}\` finalized as FAIL. Its work is (partly) in the tree — likely FINISHED but uncommitted, not broken.`, "");
  } else {
    lines.push("A previous Tanya run finalized as FAIL. Its work is (partly) in the tree — likely FINISHED but uncommitted, not broken.", "");
  }
  if (attempts > 0) {
    lines.push(`Recovery attempts before this one: ${attempts}. Budget is precious — no re-auditing, smallest steps first.`, "");
  }

  if (classes.length > 0) {
    lines.push(`Doctor classified this failure as: ${classes.map((c) => `\`${c}\``).join(", ")}`, "");
  }

  if (repairPrompt) {
    lines.push("**Doctor prescription (read for context, do not execute verbatim unless correct):**", "");
    lines.push(repairPrompt, "");
  }

  lines.push(
    "---",
    "",
    "## Contract — in THIS order, before anything else",
    "",
    "1. **Check state cheaply**: `git status` + ONE build/typecheck command (npx tsc --noEmit, xcodebuild, ./gradlew — whichever fits). Do NOT read specs or re-derive the task first.",
    "2. **If the build is green and the tree is dirty: COMMIT the completed work NOW**, path-limited, before any new work. Uncommitted finished work is the #1 thing lost to a second failure.",
    "3. **If the build is broken**: smallest possible fix back to green, then commit. Revert ONLY hunks that are actually broken and unfixable in one or two edits — never revert working code.",
    "4. **Then resume the ACTUAL TASK below from what remains.** Do NOT restart it, do NOT re-audit or re-verify parts that are already done and committed — account for them in the report by pointing at the commits.",
    "5. **Report a `## Recovery` section**: what was found, what was committed/fixed (with commit hashes), or that the tree was already clean (stale marker).",
    "6. **When a judgment call is needed** (revert vs keep, missing credentials, destructive cleanup), state it with `NEEDS USER:` and STOP instead of guessing.",
    "",
  );

  return lines.join("\n");
}

/** Brake contract: consecutive recoveries did not converge. Shrink the run to
 *  the smallest useful outcome — preserve completed work, report, hand back. */
function buildBrakeBlock(runId: string, attempts: number): string {
  return [
    "## RECOVERY BRAKE — do NOT attempt the original task",
    "",
    `Previous run \`${runId}\` failed, and ${attempts} recovery attempts have already failed to converge. Another full attempt would most likely burn the budget the same way.`,
    "",
    "Your ONLY job this run (in order, nothing else):",
    "",
    "1. `git status` + one build/typecheck command to confirm state.",
    "2. If green and dirty: commit the completed work path-limited.",
    "3. Write your final report: what is committed, what remains undone (as honest gaps), and end with `NEEDS USER: recovery did not converge after " + String(attempts) + " attempts — review the remaining gaps and re-dispatch a narrower task.`",
    "",
    "Do NOT read specs, do NOT start or resume feature work, do NOT run the full verification suite. The task text below is included for CONTEXT ONLY — do not execute it.",
    "",
  ].join("\n");
}

/** Fallback block when doctor collection itself fails. */
function buildMinimalRecoveryBlock(runId: string, attempts: number): string {
  return buildRecoveryBlock(runId, [], "", attempts);
}
