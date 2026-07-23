import type { GitSnapshot } from "../agent/git";
import type { TanyaFinalManifest } from "../agent/runner";
import { makeCheck, type VerifierCheck } from "../agent/verifier/types";
import type { BootVerdict } from "./types";

// Bridge from BootVerdict to the report surfaces downstream consumers already
// parse (AppCreator/CosmoChat gate on the structured manifest fields
// blockers[] / finalStateVerification.authoritativePassed / validation.passed,
// plus the literal TANYA RESULT line). Nothing here changes report.ts — the
// standalone test-app command synthesizes a manifest-shaped object instead of
// running buildFinalManifest (which mutates the workspace).

export function bootVerdictToChecks(verdict: BootVerdict): VerifierCheck[] {
  if (verdict.status === "skipped") {
    // skipped-never-failure: a capability skip is a passing, non-authoritative,
    // skipped check — it can produce neither blockers nor warnings.
    return [
      makeCheck({
        id: "runtime-boot",
        description: `runtime boot test (${verdict.platform})`,
        passed: true,
        authoritative: false,
        skipped: true,
        evidence: verdict.reason,
      }),
    ];
  }
  return verdict.checks.map((check) =>
    makeCheck({
      id: check.id,
      description: `${check.description} [runtime:${verdict.platform}]`,
      passed: check.passed,
      authoritative: !check.skipped,
      skipped: check.skipped,
      evidence: check.detail,
      error: check.passed
        ? undefined
        : `${verdict.reason}${verdict.evidenceDir ? ` (evidence: ${verdict.evidenceDir})` : ""}`,
    }),
  );
}

export function bootVerdictToManifest(verdict: BootVerdict, git: GitSnapshot | null): TanyaFinalManifest {
  const notFailed = verdict.status !== "fail";
  const statusWord = verdict.status === "pass" ? "passed" : verdict.status === "skipped" ? `skipped (${verdict.reason})` : `failed (${verdict.reason})`;
  // Each Tier-1 issue becomes its own blocker: the fix loop needs actionable
  // items ("display did not update after tapping +"), not one joined string.
  const uiIssues = verdict.ui && !verdict.ui.passed ? verdict.ui.issues.map((issue) => `UI issue: ${issue}`) : [];
  const blockers = notFailed
    ? []
    : [
        `runtime boot failed: ${verdict.reason}${verdict.evidenceDir ? ` (evidence: ${verdict.evidenceDir})` : ""}`,
        ...uiIssues,
      ];
  return {
    schemaVersion: 1,
    changedFiles: [],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: [`Verification: runtime boot (${verdict.platform}) -> ${statusWord}`],
    git: { root: git?.repoRoot ?? null, head: git?.head ?? null },
    toolErrors: 0,
    blockers,
    validation: { passed: notFailed, issues: [], primaryPlatform: verdict.platform },
    finalStateVerification: {
      ranVerifiers: ["generic"],
      checks: bootVerdictToChecks(verdict),
      // A skip must read as not-failed downstream, so this is "did not fail"
      // rather than "everything ran and passed".
      authoritativePassed: notFailed,
      newBlockers: blockers,
      warnings: [],
      recoveredFailureCommands: [],
    },
  };
}

export function buildBootReportText(verdict: BootVerdict, manifest: TanyaFinalManifest): string {
  const lines: string[] = [];
  lines.push(`## Runtime boot test — ${verdict.platform}`);
  lines.push("");
  lines.push(`Status: ${verdict.status.toUpperCase()} — ${verdict.reason}`);
  if (verdict.failedCheck) lines.push(`Failed check: ${verdict.failedCheck}`);
  lines.push(`Duration: ${verdict.durationMs}ms`);
  if (verdict.checks.length > 0) {
    lines.push("");
    lines.push("Checks:");
    for (const check of verdict.checks) {
      const tag = check.skipped ? "skip" : check.passed ? "ok" : "FAIL";
      lines.push(`- [${tag}] ${check.id} — ${check.description}${check.detail ? ` (${check.detail})` : ""}`);
    }
  }
  if (verdict.ui) {
    lines.push("");
    lines.push(`UI test (Tier-1): ${verdict.ui.passed ? "PASS" : "FAIL"} — ${verdict.ui.summary}`);
    for (const check of verdict.ui.checks) {
      lines.push(`- [${check.passed ? "ok" : "FAIL"}] ${check.action} — expected: ${check.expected}; actual: ${check.actual}`);
    }
    for (const issue of verdict.ui.issues) {
      lines.push(`- ISSUE: ${issue}`);
    }
  }
  if (verdict.evidenceDir || verdict.evidence.length > 0) {
    lines.push("");
    lines.push(`Evidence: ${verdict.evidenceDir ?? "(inline)"}`);
    for (const item of verdict.evidence) {
      const location = item.path ?? "";
      const excerpt = item.excerpt ? ` — ${firstLine(item.excerpt)}` : "";
      lines.push(`- ${item.kind}: ${location}${excerpt}`.trimEnd());
    }
  }
  lines.push("");
  lines.push("Tanya manifest:");
  lines.push(JSON.stringify(manifest, null, 2));
  lines.push("");
  lines.push(`TANYA RESULT: ${verdict.status === "fail" ? "FAIL" : "PASSED"}`);
  return lines.join("\n");
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.slice(0, 200) ?? "";
}
