// Verification freshness: a passing build/test line is proof only for the code
// that existed WHEN IT RAN. The audited failure (FinanceWorld S1+T1,
// 2026-07-18) edited a .swift file two hours AFTER the last green xcodebuild
// and shipped a broken repo under a report that still said "BUILD SUCCEEDED" —
// the evidence was real but stale. This gate timestamps every verification
// line as it is recorded (runner.ts) and, at finalize, flags any changed
// source file whose mtime is NEWER than the last green authoritative
// build/verify. Stale evidence is not evidence: the run must re-verify (the
// finalize-time final-state verifier counts — it runs after all edits) or FAIL
// with a "Stale build evidence" blocker.
//
// False-FAIL containment (the dodGate.ts contract): the gate SKIPS entirely
// when there is no passing authoritative build event to be stale against, and
// a fresh authoritative pass from the final-state verifier clears it. Doc and
// asset edits after the build (.md, images…) never trip it — only files that
// can change build/test outcomes.

import { stat } from "node:fs/promises";
import { join } from "node:path";

export type VerificationEvent = { line: string; atMs: number };

// Same authoritative-command shapes report.ts trusts in
// hasSuccessfulAuthoritativeBuild — a build/test that proves the tree, not a
// probe. Kept in sync by the freshness tests.
const AUTHORITATIVE_COMMANDS = [
  /\bxcodebuild\s+(?:build|test|build-for-testing)\b/i,
  /\b(?:\.\/gradlew\s+)?(?:assembleDebug|assembleRelease|test|check|build)\b/i,
  /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|typecheck)\b/i,
  /\b(?:npx\s+)?(?:vitest|jest|tsc)\b/i,
  /\b(?:swift|cargo|go)\s+(?:build|test)\b/i,
];

const PASSED_LINE = /->\s*passed\b/i;

function isAuthoritativePass(line: string): boolean {
  return PASSED_LINE.test(line) && AUTHORITATIVE_COMMANDS.some((pattern) => pattern.test(line));
}

/** Epoch ms of the LAST passing authoritative build/verify event, or null when
 *  the run never produced one (the gate then has nothing to be stale against
 *  and must skip — fail-open by design). */
export function lastGreenBuildAtMs(events: VerificationEvent[]): number | null {
  let last: number | null = null;
  for (const event of events) {
    if (isAuthoritativePass(event.line) && (last === null || event.atMs > last)) last = event.atMs;
  }
  return last;
}

// Files that cannot change a build/test outcome — editing docs or images after
// the last green build is normal report-writing, never stale evidence.
const NON_SOURCE_PATH = /(?:\.(?:md|markdown|txt|rst|adoc|png|jpe?g|gif|webp|svg|pdf|mov|mp4)$|(?:^|\/)\.gitignore$|(?:^|\/)LICENSE$)/i;

export function isFreshnessRelevantSource(filePath: string): boolean {
  return !NON_SOURCE_PATH.test(filePath);
}

// Filesystem timestamp granularity + the write-then-verify race inside one
// tool turn. An edit that PRECEDED the green build lands minutes before it in
// practice; anything within the margin is treated as covered.
const MTIME_MARGIN_MS = 1_000;

export type FreshnessAssessment = {
  status: "pass" | "fail" | "skipped";
  staleFiles: string[];
  lastGreenAtMs: number | null;
};

/** Changed source files edited AFTER the last green authoritative build.
 *  `finalStateFresh` (the finalize-time verifier's authoritative pass, which
 *  runs after every edit by construction) clears any staleness. */
export async function assessVerificationFreshness(params: {
  workspace: string;
  changedFiles: string[];
  events: VerificationEvent[];
  finalStateFresh: boolean;
}): Promise<FreshnessAssessment> {
  const lastGreen = lastGreenBuildAtMs(params.events);
  if (lastGreen === null) return { status: "skipped", staleFiles: [], lastGreenAtMs: null };
  if (params.finalStateFresh) return { status: "pass", staleFiles: [], lastGreenAtMs: lastGreen };
  const staleFiles: string[] = [];
  for (const filePath of params.changedFiles) {
    if (!isFreshnessRelevantSource(filePath)) continue;
    try {
      const fileStat = await stat(join(params.workspace, filePath));
      if (fileStat.mtimeMs > lastGreen + MTIME_MARGIN_MS) staleFiles.push(filePath);
    } catch {
      // Deleted/renamed since — nothing to stat; the diff itself is the record.
    }
  }
  return { status: staleFiles.length > 0 ? "fail" : "pass", staleFiles, lastGreenAtMs: lastGreen };
}
