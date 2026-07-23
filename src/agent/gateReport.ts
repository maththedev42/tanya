// Structured, machine-readable gate verdicts persisted into the run archive
// (`.tanya/runs/*.json`, archiveVersion 2). This is OBSERVABILITY ONLY: it
// mirrors what the gates in report.ts already decided and never changes the
// verdict (manifest.blockers remains the sole verdict lever). Its job is to make
// an external audit — "did the gates run, what did they conclude, which
// deliverables landed?" — a lookup in the archive instead of a reverse-engineer
// from git (the round-5 audit gap: archives exposed `blockers: []` but no gate
// verdicts, so a reader could not tell a passing gate from a disarmed one).

import type { RepoUncommitted } from "./git";
import type { CoverageItem } from "./specCoverage";

export type GateStatus = "pass" | "fail" | "skipped";

export type VerifyCommandResult = { cmd: string; verified: boolean; evidence?: string };

export type SpecCoverageArchiveItem = {
  id: string;
  text: string;
  state: CoverageItem["status"];
  repeatOffense: boolean;
  evidence?: string;
};

// Baseline-aware verification (Go-first, see baselineFailures.ts): whether a
// failed broad test command's failing packages were verified — by actually
// re-running them in a throwaway worktree at the session's starting commit —
// to pre-exist independently of this run. "pre-existing" is the only status
// that ever removes a blocker; every other status keeps it (fail-closed).
export type BaselineStatus = "pre-existing" | "introduced" | "inconclusive";
export type BaselineCheck = { status: BaselineStatus; packages: string[]; baseHead: string };

export type GateReport = {
  armed: boolean;
  armedReason: string;
  verifyGate?: { status: GateStatus; commands: VerifyCommandResult[] };
  commitCompleteness?: { status: GateStatus; uncommitted: string[] };
  cleanTreeBuild?: { status: GateStatus; detail?: string };
  specCoverage?: { status: GateStatus; items: SpecCoverageArchiveItem[] };
  validation?: { status: GateStatus; gatingErrors: string[] };
  baseline?: BaselineCheck;
  // Verification freshness (hard): source files edited AFTER the last passing
  // authoritative build/verify invalidate that evidence. "skipped" = no green
  // build event to be stale against (fail-open). `lastGreenAt` is ISO-8601.
  verificationFreshness?: { status: GateStatus; staleFiles: string[]; lastGreenAt?: string };
  // Artifact hygiene (nudge, never gates): dirty paths that appeared during
  // the run but belong to no declared deliverable (subprocess scaffolds).
  artifactHygiene?: { strays: string[] };
  // Deferral citations (nudge, never gates): deferrals whose scope citation is
  // missing or not found in the task prompt.
  deferralCitations?: { nudges: string[] };
};

/** Verify-gate verdict: every required command with its pass/fail, so the
 *  archive proves which checks ran. No required commands → the gate was skipped
 *  (nothing to enforce), not passed. */
export function verifyGateSection(commands: VerifyCommandResult[]): NonNullable<GateReport["verifyGate"]> {
  if (commands.length === 0) return { status: "skipped", commands };
  const status: GateStatus = commands.every((command) => command.verified) ? "pass" : "fail";
  return { status, commands };
}

/** Commit-completeness verdict: absolute paths this run wrote that are still
 *  uncommitted (empty → pass). */
export function commitCompletenessSection(uncommittedByRepo: RepoUncommitted[]): NonNullable<GateReport["commitCompleteness"]> {
  const uncommitted = uncommittedByRepo.flatMap((repo) => repo.files.map((file) => `${repo.repoRoot}/${file}`));
  return { status: uncommitted.length > 0 ? "fail" : "pass", uncommitted };
}

/** Spec-coverage verdict: the SAME manifest the gate evaluated, one row per
 *  parsed deliverable with done/skipped/pending + evidence + repeat-offense.
 *  Any `pending` row fails the gate. */
export function specCoverageSection(items: CoverageItem[]): NonNullable<GateReport["specCoverage"]> {
  const mapped: SpecCoverageArchiveItem[] = items.map((item) => ({
    id: item.id,
    text: item.title,
    state: item.status,
    repeatOffense: !!item.repeatOffense,
    ...(item.evidence ? { evidence: item.evidence } : {}),
  }));
  const status: GateStatus = mapped.some((item) => item.state === "pending") ? "fail" : "pass";
  return { status, items: mapped };
}

/** Validation-gate verdict: the gating (zero-false-positive static) validator
 *  errors that flip the verdict. Empty → pass. */
export function validationSection(gatingErrors: string[]): NonNullable<GateReport["validation"]> {
  return { status: gatingErrors.length > 0 ? "fail" : "pass", gatingErrors };
}
