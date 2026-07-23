import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitSnapshot } from "../git";
import { buildFinalManifest, ensureCodingReport } from "../report";
import type { TanyaFinalManifest } from "../runner";

function manifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
  return {
    schemaVersion: 1,
    changedFiles: ["a.ts"],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: ["Verification: npm test -> passed"],
    git: { root: "/repo", head: "abc1234" },
    toolErrors: 0,
    blockers: [],
    ...overrides,
  } as TanyaFinalManifest;
}

describe("report honesty sections", () => {
  it("renders gate results human-readably (not just JSON)", () => {
    const m = manifest({
      validation: {
        passed: false,
        issues: [{ id: "task-goose-annotations-missing", severity: "error", message: "missing +goose Up", files: ["m.sql"] }],
      },
    });
    const out = ensureCodingReport("done", m, undefined);
    expect(out).toContain("Gate results: FAILED");
    expect(out).toContain("[error] task-goose-annotations-missing: missing +goose Up (m.sql)");
  });

  it("renders the commit summary (what actually landed)", () => {
    const m = manifest({ commitSummary: "commit a1b2c3d add hosting\n api/foo.go | 10 +++++" });
    const out = ensureCodingReport("done", m, undefined);
    expect(out).toContain("Commits this run:");
    expect(out).toContain("commit a1b2c3d add hosting");
  });

  it("surfaces declared ASSUMPTION lines from the report body", () => {
    const body = "Fixed the boot loop.\nASSUMPTION: simctl prints 'Booted' on stderr when already booted; not verified this run.";
    const out = ensureCodingReport(body, manifest(), undefined);
    expect(out).toContain("Assumptions (declared, unverified):");
    expect(out).toContain("simctl prints 'Booted'");
  });

  it("omits the assumptions section when there are none", () => {
    const out = ensureCodingReport("no assumptions here", manifest(), undefined);
    expect(out).not.toContain("Assumptions (declared, unverified):");
  });
});

describe("FIX-E — a validator ERROR flips the verdict, not just the footer (E2)", () => {
  it("verdict is FAIL when validation has an error, even with no prior blocker", () => {
    const m = manifest({
      blockers: [],
      validation: {
        passed: false,
        issues: [{ id: "task-localization-missing-locale", severity: "error", gating: true, message: "key \"Get Set Up\" missing from 4 locale files", files: [] }],
      },
    });
    const out = ensureCodingReport("Added the Getting Started screen.", m, undefined);
    expect(out).toContain("TANYA RESULT: FAIL");
    expect(m.blockers.some((b) => /localization-missing-locale/.test(b))).toBe(true);
  });

  it("does NOT flip the verdict for a non-gating (heuristic) error", () => {
    const m = manifest({
      blockers: [],
      validation: {
        passed: false,
        issues: [{ id: "core-verification-missing", severity: "error", message: "no verification captured", files: [] }],
      },
    });
    const out = ensureCodingReport("done", m, undefined);
    expect(out).toContain("TANYA RESULT: PASSED");
  });

  it("verdict stays PASSED for warnings-only validation", () => {
    const m = manifest({
      blockers: [],
      validation: {
        passed: true,
        issues: [{ id: "task-no-op-handler", severity: "warning", message: "does nothing", files: [] }],
      },
    });
    const out = ensureCodingReport("done", m, undefined);
    expect(out).toContain("TANYA RESULT: PASSED");
  });

  it("renders concise (no raw JSON manifest dump) when asked, but keeps the verdict + gate results", () => {
    const m = manifest({
      validation: { passed: false, issues: [{ id: "task-goose-annotations-missing", severity: "error", gating: true, message: "missing +goose", files: [] }] },
    });
    const out = ensureCodingReport("done", m, undefined, { concise: true });
    expect(out).toContain("TANYA RESULT: FAIL");
    expect(out).toContain("Gate results: FAILED");
    expect(out).not.toContain("Tanya manifest:");
  });
});

describe("tail-drop — gates fire on the turn-budget-exhausted finalize path", () => {
  it("still flags an uncommitted session file when the run stopped early", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-taildrop-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    writeFileSync(join(dir, "seed.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const before = await captureGitSnapshot(dir);
    // A run that wrote a file then stalled out at the turn-budget without committing.
    writeFileSync(join(dir, "half_done.go"), "package main\n");

    const built = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["half_done.go"],
      verificationLines: [],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: ["tool-turn limit reached before final completion"],
      terminationReason: "turn_budget_exhausted",
      interactive: false,
    });

    // The commit-completeness gate ran even on the stall path.
    expect(built.blockers.some((b) => /Commit incomplete/i.test(b))).toBe(true);
    expect(built.blockers.some((b) => b.includes("half_done.go"))).toBe(true);

    // Observability: the structured gates section mirrors the same verdict.
    expect(built.gates?.armed).toBe(true);
    expect(built.gates?.armedReason).toMatch(/non-interactive/);
    expect(built.gates?.commitCompleteness?.status).toBe("fail");
    expect(built.gates?.commitCompleteness?.uncommitted.some((f) => f.includes("half_done.go"))).toBe(true);
  });

  it("surfaces a non-gating stale-binary nudge in the report without failing the verdict", () => {
    const out = ensureCodingReport("done", manifest({ binaryStale: true }), undefined);
    expect(out).toMatch(/Stale binary/i);
    // Nudge only — a working run is never failed for it.
    expect(out).toMatch(/TANYA RESULT:\s*PASSED/);
  });
});
