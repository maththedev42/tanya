import type { RunArchive, DiagnosisEvidence, FailureClass } from "./types";

// Catalog of KNOWN failure classes — seeded from live hits in CHANGELOG
// entries beta.21–beta.26. Each entry detects from the run archive, marker
// files, and current file content; explains the failure; and prescribes a
// repair path with file:line evidence when possible.

export const FAILURE_CLASSES: FailureClass[] = [
  {
    id: "dead-run-dirty-tree",
    detect(evidence: DiagnosisEvidence): boolean {
      // Aborted archive OR LAST_RUN_FAILED marker OR stale RUN_IN_PROGRESS
      // with a dead pid. Any of these plus uncommitted files = this class.
      if (evidence.archive?.aborted) return true;
      if (evidence.markers.lastRunFailed) return true;
      if (evidence.markers.runInProgress && !evidence.markers.runInProgressPidAlive) return true;
      return false;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Dead Run — Dirty Tree");
      lines.push("");
      if (evidence.archive?.aborted) {
        lines.push(`The run \`${evidence.archive.runId}\` aborted before finalizing.`);
        if (evidence.archive.terminationReason) {
          lines.push(`Reason: ${evidence.archive.terminationReason}`);
        }
      }
      if (evidence.markers.lastRunFailed) {
        lines.push("A `.tanya/LAST_RUN_FAILED.md` marker exists — the last run left uncommitted files.");
      }
      if (evidence.markers.runInProgress && !evidence.markers.runInProgressPidAlive) {
        lines.push("A `.tanya/RUN_IN_PROGRESS.md` heartbeat survived for a dead pid — the run was hard-killed.");
      }
      lines.push("");
      if (evidence.archive?.changedFiles?.length) {
        lines.push("### Changed files (may not compile):");
        for (const f of evidence.archive.changedFiles) lines.push(`- ${f}`);
      }
      if (evidence.archive?.uncommittedFiles?.length) {
        lines.push("### Uncommitted files:");
        for (const f of evidence.archive.uncommittedFiles) lines.push(`- ${f}`);
      }
      if (!evidence.archive?.greenBuildObserved) {
        lines.push("");
        lines.push("**No green build was observed.** These files may not compile.");
      }
      return lines.join("\n");
    },
    prescribe(evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Build first");
      prompt.push("Build the project before making any code changes — verify the tree compiles.");
      prompt.push("If build fails, fix the errors before continuing.");
      prompt.push("");
      prompt.push("### Part 2 — Repair or revert");
      const files = evidence.archive?.changedFiles ?? [];
      if (files.length > 0) {
        prompt.push("The following files were changed by the dead run:");
        for (const f of files) prompt.push(`- ${f}`);
        prompt.push("");
        prompt.push("Review each: if salvageable, fix remaining errors; otherwise `git checkout` to revert.");
      }
      prompt.push("");
      prompt.push("### Part 3 — Re-dispatch");
      if (evidence.archive?.prompt) {
        prompt.push("Original task:");
        prompt.push("```");
        prompt.push(evidence.archive.prompt);
        prompt.push("```");
        prompt.push("");
        prompt.push("Re-dispatch this task once the tree is clean.");
      }
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- Project builds clean (xcodebuild / gradle / tsc / go build)");

      return prompt.join("\n");
    },
  },

  {
    id: "stall-blind-build",
    detect(evidence: DiagnosisEvidence): boolean {
      // Turn-budget / stall stop where a build verification failed and
      // the error lines are present in the archive blockers.
      if (evidence.archive?.verdict !== "FAIL") return false;
      if (evidence.archive?.terminationReason === "turn_budget_exhausted") return true;
      // Also detect when blockers contain build-failure lines
      for (const blocker of evidence.archive?.blockers ?? []) {
        if (/build.*fail|compil.*error|error:/.test(blocker.toLowerCase())) return true;
      }
      return false;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Stall — Blind Build Loop");
      lines.push("");
      lines.push("The run exhausted its turn budget while a build verification was failing.");
      lines.push("The model likely re-ran the same build without seeing the error lines.");
      lines.push("");
      if (evidence.archive?.blockers?.length) {
        lines.push("### Blockers from the run:");
        for (const b of evidence.archive.blockers) lines.push(`- ${b}`);
      }
      lines.push("");
      lines.push("### Error lines from the build:");
      for (const e of evidence.buildErrors) lines.push(`- ${e}`);
      return lines.join("\n");
    },
    prescribe(evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Extract the real error");
      prompt.push("The build verification failed but the error was buried in the output.");
      prompt.push("Run the failing build command directly and capture the error lines:");
      if (evidence.buildErrors.length > 0) {
        prompt.push("");
        for (const e of evidence.buildErrors.slice(0, 3)) {
          prompt.push(`- ${e}`);
        }
      }
      prompt.push("");
      prompt.push("### Part 2 — Fix per-file");
      prompt.push("Each error usually points to a specific file:line — fix them one by one.");
      prompt.push("");
      prompt.push("### Part 3 — Rebuild and continue");
      prompt.push("Once the build passes, re-dispatch the original task.");
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- Project builds clean");

      return prompt.join("\n");
    },
  },

  {
    id: "commit-incomplete",
    detect(evidence: DiagnosisEvidence): boolean {
      // Commit gate blocker: files changed but not committed.
      if (evidence.archive?.verdict !== "FAIL") return false;
      for (const blocker of evidence.archive?.blockers ?? []) {
        if (/commit.*incomplete|uncommitted|no commit|not committed/i.test(blocker)) return true;
      }
      return false;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Commit Incomplete");
      lines.push("");
      lines.push("The run changed files but did not commit them.");
      lines.push("");
      if (evidence.archive?.changedFiles?.length) {
        lines.push("### Changed files:");
        for (const f of evidence.archive.changedFiles) lines.push(`- ${f}`);
      }
      if (evidence.archive?.uncommittedFiles?.length) {
        lines.push("### Uncommitted files:");
        for (const f of evidence.archive.uncommittedFiles) lines.push(`- ${f}`);
      }
      return lines.join("\n");
    },
    prescribe(evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Verify the tree is clean");
      prompt.push("Run `git status` to confirm all changes are in the working tree.");
      prompt.push("");
      prompt.push("### Part 2 — Path-limited commit");
      prompt.push("Stage only the files this run changed — never `git add -A` or bare `git add .`.");
      const files = evidence.archive?.changedFiles ?? [];
      if (files.length > 0) {
        prompt.push("");
        prompt.push("Changed files:");
        for (const f of files) prompt.push(`- ${f}`);
      }
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- `git status` shows clean working tree after commit");

      return prompt.join("\n");
    },
  },

  {
    id: "verification-stale",
    detect(evidence: DiagnosisEvidence): boolean {
      if (evidence.archive?.verdict !== "FAIL") return false;
      for (const blocker of evidence.archive?.blockers ?? []) {
        if (/verification.*stale|freshness.*fail|build.*after.*edit|no.*green.*build/i.test(blocker)) return true;
      }
      return false;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Verification Stale");
      lines.push("");
      lines.push("A file was edited after the last green build — the build result is stale.");
      lines.push("");
      if (evidence.archive?.blockers?.length) {
        lines.push("### Blockers:");
        for (const b of evidence.archive.blockers) lines.push(`- ${b}`);
      }
      return lines.join("\n");
    },
    prescribe(_evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Rebuild");
      prompt.push("A source file was edited after the last green build.");
      prompt.push("Run the build command again to get a current result.");
      prompt.push("");
      prompt.push("### Part 2 — If build fails");
      prompt.push("Fix the errors, then rebuild. Do NOT edit more files between build and commit.");
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- `xcodebuild build` / `./gradlew assembleDebug` / `tsc --noEmit` passes clean");

      return prompt.join("\n");
    },
  },

  {
    id: "spec-gap",
    detect(evidence: DiagnosisEvidence): boolean {
      if (evidence.archive?.verdict !== "FAIL") return false;
      for (const blocker of evidence.archive?.blockers ?? []) {
        if (/spec.*gap|coverage.*fail|deliverable.*unaccounted|pending.*requirement/i.test(blocker)) return true;
      }
      // Also check gates.specCoverage
      if (evidence.archive?.gates?.specCoverage?.armed && !evidence.archive.gates.specCoverage.passed) return true;
      return false;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Spec Coverage Gap");
      lines.push("");
      lines.push("One or more task deliverables were not accounted for in the final report.");
      lines.push("");
      if (evidence.archive?.gates?.specCoverage) {
        const g = evidence.archive.gates.specCoverage;
        lines.push(`- Coverage: ${g.covered ?? "?"}/${g.total ?? "?"} items`);
        if (g.reason) lines.push(`- Reason: ${g.reason}`);
      }
      if (evidence.archive?.blockers?.length) {
        lines.push("### Blockers:");
        for (const b of evidence.archive.blockers) lines.push(`- ${b}`);
      }
      return lines.join("\n");
    },
    prescribe(_evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Identify missing deliverables");
      prompt.push("Review the task spec and the run's final report. Find every deliverable");
      prompt.push("that was required but not explicitly accounted for.");
      prompt.push("");
      prompt.push("### Part 2 — Implement or defer");
      prompt.push("Implement the missing items, or document why each is out of scope");
      prompt.push("(item must cite the phrase from the prompt that excludes it).");
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- Every numbered deliverable from the task spec is accounted for");

      return prompt.join("\n");
    },
  },

  {
    id: "subagent-child-failed",
    detect(evidence: DiagnosisEvidence): boolean {
      if (evidence.archive?.verdict !== "FAIL") return false;
      return (evidence.archive?.childVerdicts ?? []).some((v) => v.verdict === "FAIL");
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Subagent Child Failed");
      lines.push("");
      const failures = (evidence.archive?.childVerdicts ?? []).filter((v) => v.verdict === "FAIL");
      for (const child of failures) {
        lines.push(`- **${child.label ?? "unnamed"}**: ${child.runId ? `run \`${child.runId}\`` : "no runId"}`);
        if (child.blockers?.length) {
          for (const b of child.blockers) lines.push(`  - ${b}`);
        }
      }
      lines.push("");
      lines.push("Check the child's own archive in `.tanya/runs/<childRunId>.json`.");
      return lines.join("\n");
    },
    prescribe(evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Check child archive");
      const failures = (evidence.archive?.childVerdicts ?? []).filter((v) => v.verdict === "FAIL");
      for (const child of failures) {
        if (child.runId) {
          prompt.push(`- Child \`${child.label ?? "unnamed"}\`: run \`tanya doctor --run ${child.runId}\``);
        }
      }
      prompt.push("");
      prompt.push("### Part 2 — Fix child issues first");
      prompt.push("The parent FAILED because a child FAILED. Fix the child's blockers");
      prompt.push("before re-dispatching the parent.");
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- Each failed child's blockers are resolved");

      return prompt.join("\n");
    },
  },

  {
    id: "mangled-edit",
    detect(evidence: DiagnosisEvidence): boolean {
      // Doctor only scans the run's changed files, so ANY hit from the real
      // forbidden-pattern catalog on current content means a mangled edit
      // survived in the tree.
      return (evidence.forbiddenPatternHits ?? []).length > 0;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Mangled Edit — Forbidden Pattern");
      lines.push("");
      for (const hit of evidence.forbiddenPatternHits ?? []) {
        lines.push(`- **${hit.file}**${hit.line ? `: line ${hit.line}` : ""} — \`${hit.pattern}\``);
        if (hit.match) lines.push(`  Match: \`${hit.match}\``);
        if (hit.suggestion) lines.push(`  Fix: ${hit.suggestion}`);
      }
      return lines.join("\n");
    },
    prescribe(evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Fix forbidden patterns");
      for (const hit of evidence.forbiddenPatternHits ?? []) {
        prompt.push(`- \`${hit.file}${hit.line ? `:${hit.line}` : ""}\` — ${hit.pattern}`);
        if (hit.match) prompt.push(`  Current: \`${hit.match}\``);
        if (hit.suggestion) prompt.push(`  Fix: ${hit.suggestion}`);
      }
      prompt.push("");
      prompt.push("### Part 2 — Rebuild");
      prompt.push("After fixing, rebuild to confirm the patterns are resolved.");
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- Project builds clean");

      return prompt.join("\n");
    },
  },

  {
    id: "unsupported-deferral",
    detect(evidence: DiagnosisEvidence): boolean {
      if (evidence.archive?.verdict !== "FAIL") return false;
      // Deferral without evidence — blocker says something was deferred
      // but no rationale cites the prompt phrase that excludes it.
      for (const blocker of evidence.archive?.blockers ?? []) {
        if (/defer|skip|not.*implement/i.test(blocker)) return true;
      }
      return false;
    },
    explain(evidence: DiagnosisEvidence): string {
      const lines: string[] = [];
      lines.push("## Unsupported Deferral");
      lines.push("");
      lines.push("A deliverable was deferred or skipped without citing the phrase");
      lines.push("from the task prompt that excludes it.");
      lines.push("");
      if (evidence.archive?.blockers?.length) {
        lines.push("### Blockers:");
        for (const b of evidence.archive.blockers) lines.push(`- ${b}`);
      }
      return lines.join("\n");
    },
    prescribe(_evidence: DiagnosisEvidence): string {
      const prompt: string[] = [];
      prompt.push("## Parts");
      prompt.push("");
      prompt.push("### Part 1 — Cite the exclusion");
      prompt.push("For each deferred deliverable, find the exact sentence in the task prompt");
      prompt.push("that says it is out of scope. If no such exclusion exists, the item is");
      prompt.push("in scope and must be implemented.");
      prompt.push("");
      prompt.push("### Part 2 — Implement or formally defer");
      prompt.push("Implement in-scope items. For out-of-scope items, update the report to");
      prompt.push("cite the prompt phrase that excludes each one.");
      prompt.push("");
      prompt.push("## Verify");
      prompt.push("- Every deferred item has a citation to the prompt that excludes it");

      return prompt.join("\n");
    },
  },
];
