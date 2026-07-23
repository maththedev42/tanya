import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFinalManifest, failedVerificationBlockers } from "../src/agent/report";

async function manifestFor(verificationLines: string[]) {
  const workspace = mkdtempSync(join(tmpdir(), "tanya-diag-probe-"));
  try {
    return await buildFinalManifest({
      workspace,
      beforeGitSnapshot: null,
      changed: [],
      verificationLines,
      toolErrorCount: 0,
      readArtifactPaths: [],
      readContextPaths: [],
      createdArtifactPaths: [],
      blockers: failedVerificationBlockers(verificationLines),
      runContext: { task: { kind: "coding", title: "Setup Environment - iOS" } },
      prompt: "Set up mobile env",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const BUILD_PASS = "Verification: ./gradlew assembleDebug --no-daemon -> passed (Shell exited 0.)";

describe("diagnostic probe failures never gate a green build", () => {
  it("drops tool-detection / version / existence probe failures when the build passed", async () => {
    const manifest = await manifestFor([
      BUILD_PASS,
      "Verification: which fastlane -> failed (Command failed to start.)",
      "Verification: which swiftlint -> failed (Command failed to start.)",
      "Verification: xcodebuild -version -> failed (Command failed to start.)",
      "Verification: swiftlint version -> failed (Shell exited 1.)",
      "Verification: test -f fastlane/README.md -> failed (Shell exited 1.)",
      "Verification: stat Sources/App.swift -> failed (Shell exited 1.)",
    ]);
    expect(manifest.blockers).toEqual([]);
  });

  it("also works for an xcodebuild-based build gate", async () => {
    const manifest = await manifestFor([
      "Verification: xcodebuild build -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' -> passed (Shell exited 0.)",
      "Verification: which fastlane -> failed (Command failed to start.)",
    ]);
    expect(manifest.blockers).toEqual([]);
  });

  it("does NOT gate failed read-only probes when no real build/quality gate ran", async () => {
    // The 2026-05-09 false-FAIL: a plain `cat migrations.go` (missing file,
    // exit 1) was miscounted as a failed verification and gated the run even
    // though no build/test/lint ever executed. A read-only probe's exit code
    // says nothing about code correctness, so it must never gate on its own —
    // previously these only dropped when an authoritative build had passed.
    const manifest = await manifestFor([
      "Verification: cat internal/db/migrations.go -> failed (Shell exited 1.)",
      "Verification: grep -n TODO internal/handler.go -> failed (Shell exited 1.)",
      "Verification: ls dist/ -> failed (Shell exited 1.)",
    ]);
    expect(manifest.blockers).toEqual([]);
  });

  it("STILL gates a real quality-gate failure (lint) on a green build", async () => {
    const manifest = await manifestFor([
      BUILD_PASS,
      "Verification: ./gradlew lintRelease --no-daemon -> failed (Shell exited 1.)",
    ]);
    expect(manifest.blockers.some((b) => /lintRelease/.test(b))).toBe(true);
  });

  it("STILL gates probe failures when there is NO passing build (build is the gate)", async () => {
    const manifest = await manifestFor([
      "Verification: ./gradlew assembleDebug --no-daemon -> failed (compileDebugKotlin FAILED)",
      "Verification: which fastlane -> failed (Command failed to start.)",
    ]);
    // The failed build gates; we don't assert on the probe specifically, only
    // that the run is not silently green.
    expect(manifest.blockers.length).toBeGreaterThan(0);
  });
});
