import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessVerificationFreshness,
  isFreshnessRelevantSource,
  lastGreenBuildAtMs,
} from "../verificationFreshness";
import { buildFinalManifest } from "../report";
import { captureGitSnapshot } from "../git";

// Verification freshness (PROMPT B item 1). The audited failure: last green
// xcodebuild at 16:03, a .swift edit at 18:00, report still said "BUILD
// SUCCEEDED" — the repo shipped broken under stale-but-real evidence.

function setMtime(path: string, atMs: number): void {
  utimesSync(path, new Date(atMs), new Date(atMs));
}

describe("lastGreenBuildAtMs", () => {
  it("returns the LAST passing authoritative build event", () => {
    expect(
      lastGreenBuildAtMs([
        { line: "Verification: xcodebuild build -scheme App -> passed (ok)", atMs: 1_000 },
        { line: "Verification: ls -la -> passed (ok)", atMs: 5_000 },
        { line: "Verification: npm test -> passed (ok)", atMs: 3_000 },
      ]),
    ).toBe(3_000);
  });

  it("ignores failed builds and non-authoritative probes", () => {
    expect(
      lastGreenBuildAtMs([
        { line: "Verification: xcodebuild build -> failed (exit 65)", atMs: 1_000 },
        { line: "Verification: grep -rn foo -> passed (ok)", atMs: 2_000 },
      ]),
    ).toBeNull();
  });
});

describe("isFreshnessRelevantSource", () => {
  it("excludes docs and assets, keeps code", () => {
    expect(isFreshnessRelevantSource("README.md")).toBe(false);
    expect(isFreshnessRelevantSource("docs/shot.png")).toBe(false);
    expect(isFreshnessRelevantSource(".gitignore")).toBe(false);
    expect(isFreshnessRelevantSource("App/Feature.swift")).toBe(true);
    expect(isFreshnessRelevantSource("src/index.ts")).toBe(true);
    expect(isFreshnessRelevantSource("api/config.json")).toBe(true);
  });
});

describe("assessVerificationFreshness", () => {
  it("flags a source file edited AFTER the last green build (the audited shape)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-"));
    const buildAt = Date.now() - 60_000;
    writeFileSync(join(dir, "Feature.swift"), "let a = 1\n");
    setMtime(join(dir, "Feature.swift"), buildAt + 30_000); // edited 30s after the build
    const result = await assessVerificationFreshness({
      workspace: dir,
      changedFiles: ["Feature.swift"],
      events: [{ line: "Verification: xcodebuild build -scheme App -> passed (BUILD SUCCEEDED)", atMs: buildAt }],
      finalStateFresh: false,
    });
    expect(result.status).toBe("fail");
    expect(result.staleFiles).toEqual(["Feature.swift"]);
  });

  it("passes when every edit precedes the last green build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-"));
    const buildAt = Date.now();
    writeFileSync(join(dir, "Feature.swift"), "let a = 1\n");
    setMtime(join(dir, "Feature.swift"), buildAt - 60_000);
    const result = await assessVerificationFreshness({
      workspace: dir,
      changedFiles: ["Feature.swift"],
      events: [{ line: "Verification: xcodebuild build -> passed (ok)", atMs: buildAt }],
      finalStateFresh: false,
    });
    expect(result.status).toBe("pass");
  });

  it("a doc edited after the build never trips it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-"));
    const buildAt = Date.now() - 60_000;
    writeFileSync(join(dir, "README.md"), "notes\n");
    setMtime(join(dir, "README.md"), buildAt + 30_000);
    const result = await assessVerificationFreshness({
      workspace: dir,
      changedFiles: ["README.md"],
      events: [{ line: "Verification: npm test -> passed (ok)", atMs: buildAt }],
      finalStateFresh: false,
    });
    expect(result.status).toBe("pass");
  });

  it("skips (fail-open) when the run has no green authoritative build at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-"));
    const result = await assessVerificationFreshness({
      workspace: dir,
      changedFiles: ["a.ts"],
      events: [],
      finalStateFresh: false,
    });
    expect(result.status).toBe("skipped");
  });

  it("a fresh finalize-time authoritative pass clears staleness (never false-FAIL)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-"));
    const buildAt = Date.now() - 60_000;
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    setMtime(join(dir, "a.ts"), buildAt + 30_000);
    const result = await assessVerificationFreshness({
      workspace: dir,
      changedFiles: ["a.ts"],
      events: [{ line: "Verification: npm test -> passed (ok)", atMs: buildAt }],
      finalStateFresh: true,
    });
    expect(result.status).toBe("pass");
    expect(result.staleFiles).toEqual([]);
  });
});

describe("freshness gate through buildFinalManifest", () => {
  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }

  it("adds the Stale-build-evidence blocker for a post-build source edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-gate-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@e.com"]);
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "init"]);
    const before = await captureGitSnapshot(dir);
    const buildAt = Date.now() - 120_000;
    writeFileSync(join(dir, "a.ts"), "export const late = 1;\n"); // mtime = now, AFTER the build

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["a.ts"],
      verificationLines: ["Verification: npm test -> passed (ok)"],
      verificationEvents: [{ line: "Verification: npm test -> passed (ok)", atMs: buildAt }],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: "## Verify\nTask with a build.",
    });

    expect(manifest.blockers.some((blocker) => blocker.startsWith("Stale build evidence: a.ts"))).toBe(true);
    expect(manifest.gates?.verificationFreshness?.status).toBe("fail");
  }, 30_000);

  it("no events (direct callers) → gate silently skips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tanya-fresh-gate-"));
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "t@e.com"]);
    git(dir, ["config", "user.name", "T"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    const before = await captureGitSnapshot(dir);

    const manifest = await buildFinalManifest({
      workspace: dir,
      beforeGitSnapshot: before,
      changed: ["a.ts"],
      verificationLines: ["Verification: npm test -> passed (ok)"],
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      prompt: "Task.",
    });

    expect(manifest.blockers.some((blocker) => blocker.startsWith("Stale build evidence"))).toBe(false);
    expect(manifest.gates?.verificationFreshness).toBeUndefined();
  }, 30_000);
});
