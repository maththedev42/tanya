import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosisEvidence } from "./types";
import type { EscalationResult } from "./ledger";

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Improvement draft
// ---------------------------------------------------------------------------

const HEADER = `<!--
  This file was generated automatically by Tanya doctor.
  Doctor never edits Tanya's own source, never auto-dispatches, and never
  weakens an existing gate. This is a PROMPT FILE for the user to review
  and dispatch manually.
-->

`;

/** Generate an improvement-<slug>.md draft and write it to .tanya/doctor/.
 *  Returns the written path. */
export function writeImprovementDraft(
  cwd: string,
  escalation: EscalationResult,
  evidence: DiagnosisEvidence,
): string {
  const doctorDir = join(cwd, ".tanya", "doctor");
  mkdirSync(doctorDir, { recursive: true });

  const kind = escalation.newUnknownClass ? "unknown-class" : "known-class-nag";
  const slug = slugify(`${kind}-${escalation.signature.slice(0, 40)}`);
  const path = join(doctorDir, `improvement-${slug}.md`);

  const parts: string[] = [];

  // Header
  parts.push(`# Improve Tanya — ${kind === "unknown-class" ? "New failure class" : "Recurring known class"}`);
  parts.push("");

  // Evidence section
  parts.push("## Observed evidence");
  parts.push("");
  parts.push(`Signature: \`${escalation.signature.slice(0, 120)}\``);
  parts.push("");
  parts.push("Recurring across these runs:");
  for (const entry of escalation.entries.slice(0, 5)) {
    parts.push(`- ${entry.ts.slice(0, 10)} — \`${entry.runId}\` — \`${entry.classId}\``);
  }
  if (escalation.entries.length > 5) {
    parts.push(`- ... and ${escalation.entries.length - 5} more`);
  }

  // Archive evidence
  if (evidence.archive) {
    parts.push("");
    parts.push("### Latest run archive");
    if (evidence.archive.blockers?.length) {
      parts.push("");
      parts.push("Blockers:");
      for (const b of evidence.archive.blockers.slice(0, 5)) {
        const excerpt = b.length > 200 ? b.slice(0, 200) + "..." : b;
        parts.push(`  - ${excerpt}`);
      }
    }
    if (evidence.archive.gateLog?.length) {
      parts.push("");
      parts.push("Gate log:");
      for (const g of evidence.archive.gateLog.slice(-5)) {
        parts.push(`  - ${g}`);
      }
    }
    if (evidence.buildErrors.length > 0) {
      parts.push("");
      parts.push("Build errors:");
      for (const e of evidence.buildErrors.slice(0, 5)) {
        parts.push(`  - ${e}`);
      }
    }
  }

  // Suspected seam
  parts.push("");
  parts.push("## Suspected seam");
  parts.push("");
  if (escalation.newUnknownClass) {
    parts.push("This is an **unclassified failure** — it does not match any known");
    parts.push("classifier in `src/agent/doctor/failureClasses.ts`. The recurrence");
    parts.push("suggests it is a real pattern, not a one-off anomaly.");
    parts.push("");
    parts.push("### Possible classifiers to check");
    parts.push("");
    parts.push("- **fsTools / shell output truncation**: does the failure surface only");
    parts.push("  after a tool output was truncated? Check the truncation layer.");
    parts.push("- **Gate report / freshness**: does the failure involve a gate that");
    parts.push("  fires after the build but before the commit?");
    parts.push("- **System prompt / task injection**: does the failure relate to how");
    parts.push("  context is injected or how the run recovers?");
    parts.push("- **Run lifecycle / finishRun**: does the failure happen during");
    parts.push("  finalization (commit gates, marker writes, verdict)?");
  } else {
    parts.push("This is a **known class** (`" + escalation.entries[0]?.classId + "`) that keeps");
    parts.push("firing. The existing nudge or gate is not landing — it may need");
    parts.push("strengthening or an additional defense layer.");
    parts.push("");
    parts.push("### Check the existing classifier");
    parts.push("");
    parts.push("- Review the `detect()` function in `src/agent/doctor/failureClasses.ts`");
    parts.push("  for the `" + (escalation.entries[0]?.classId ?? "unknown") + "` class.");
    parts.push("- Is the detection too narrow? Does it miss variants of the same");
    parts.push("  failure?");
    parts.push("- Is the `prescribe()` prompt landing? Does the model actually follow");
    parts.push("  the repair path, or does it ignore it?");
  }

  // Proposed fix direction
  parts.push("");
  parts.push("## Proposed fix direction");
  parts.push("");

  if (escalation.newUnknownClass) {
    parts.push("1. **Add a failure class** in `src/agent/doctor/failureClasses.ts` that");
    parts.push("   detects this pattern from the evidence above.");
    parts.push("2. **Write a `prescribe()`** that gives the model a clear repair path.");
    parts.push("3. **Add a gate or nudge** if this failure is preventable at runtime");
    parts.push("   (e.g., pre-build check, output validation, prompt guard).");
  } else {
    parts.push("1. **Strengthen the existing gate** — maybe the gate fires but the model");
    parts.push("   ignores the nudge. Consider making it a hard gate.");
    parts.push("2. **Add a pre-emptive check** that catches the condition BEFORE the");
    parts.push("   run makes the mistake.");
    parts.push("3. **Review the prompt wording** — is the repair instruction clear");
    parts.push("   enough for the model to act on?");
  }

  // Proposed tests
  parts.push("");
  parts.push("## Proposed tests");
  parts.push("");
  parts.push("- Add a detector test in `src/agent/__tests__/doctor.test.ts` that");
  parts.push("  reproduces the exact evidence pattern from the runs above.");
  parts.push("- Add a regression test: new class detects its own fixture AND does");
  parts.push("  NOT fire on unrelated fixtures.");
  if (!escalation.newUnknownClass) {
    parts.push("- Verify that 3+ recurrences trigger the nag (existing escalation test");
    parts.push("  in doctor.test.ts).");
  }

  // Constraints
  parts.push("");
  parts.push("## Standing constraints");
  parts.push("");
  parts.push("- Never false-FAIL a legit green build.");
  parts.push("- Nudges are preferred over hard gates for recoverable conditions.");
  parts.push("- All changes must pass `npx tsc --noEmit`, full `npx vitest run`, and");
  parts.push("  `npm run build`.");
  parts.push("- Path-limited commit — never `git add -A` or bare `git add .`.");
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("Generated by `tanya doctor` — review and dispatch manually.");
  parts.push("Doctor never auto-dispatches improvement drafts.");

  const content = HEADER + parts.join("\n") + "\n";
  writeFileSync(path, content, "utf8");

  return path;
}
