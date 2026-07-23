import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitSnapshot } from "./git";

const execFileAsync = promisify(execFile);

// Additive-edit guard. Instrumentation/telemetry tasks are add-only by
// nature: wiring events must not delete existing behaviour. Field failure
// (FinanceWorld run 5): analytics edits silently dropped the errorMessage
// handling in register/Apple sign-in and the Google session cleanup in
// AuthStore. When the task prompt is instrumentation-shaped, any removed
// non-whitespace line in the run's diff becomes a NUDGE — never a blocker,
// because some removals are legitimate (the nudge asks to restore or
// justify in the report).

/** Task-shape heuristic: does the prompt read as add-only instrumentation? */
export function isAdditiveInstrumentationPrompt(prompt: string): boolean {
  return /\b(?:analytics|telemetry|telemetria|instrumenta(?:tion|r|ção)?|track(?:ing|ear)?\s+(?:events?|eventos?)|eventos?\s+de\s+analytics|GA4|PostHog|Firebase\s+Analytics|funnel|funil)\b/i.test(prompt);
}

export type RemovedLine = { file: string; line: string };

/** Removed non-whitespace lines per file, parsed from a unified git diff. */
export function removedLinesFromDiff(diffText: string): RemovedLine[] {
  const removals: RemovedLine[] = [];
  let currentFile = "";
  let pendingOldFile = "";
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("--- ")) {
      const path = raw.slice(4).trim();
      pendingOldFile = path === "/dev/null" ? "" : path.replace(/^a\//, "");
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      currentFile = path === "/dev/null" ? pendingOldFile : path.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("-")) {
      const line = raw.slice(1);
      if (line.trim().length === 0) continue;
      removals.push({ file: currentFile || pendingOldFile || "(unknown)", line: line.trim() });
    }
  }
  return removals;
}

/** One combined nudge listing the removed lines (capped), or []. */
export function additiveEditNudges(removals: RemovedLine[], cap = 8): string[] {
  if (removals.length === 0) return [];
  const shown = removals.slice(0, cap);
  const extra = removals.length - shown.length;
  const listing = shown.map((removal) => `${removal.file}: \`${removal.line}\``).join("; ");
  return [
    `additive edit removed existing line(s): ${listing}${extra > 0 ? ` (+${extra} more)` : ""} — an instrumentation task is add-only; restore each removed line or justify the removal in the report.`,
  ];
}

/** Diff the run's touched files against the pre-run snapshot and return the
 *  removed non-whitespace lines. Covers committed AND still-uncommitted
 *  removals (working tree vs the pre-run head). Best-effort: any git failure
 *  returns []. */
export async function collectAdditiveEditRemovals(
  workspace: string,
  beforeGitSnapshot: GitSnapshot | null,
  touchedFiles: string[],
): Promise<RemovedLine[]> {
  const beforeHead = beforeGitSnapshot?.head;
  if (!beforeHead || touchedFiles.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-color", beforeHead, "--", ...touchedFiles.slice(0, 50)],
      { cwd: workspace, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    return removedLinesFromDiff(stdout);
  } catch {
    return [];
  }
}
