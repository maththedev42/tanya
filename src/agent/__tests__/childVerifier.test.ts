import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendReasoningChunk } from "../../memory/reasoningArchive";
import { buildFinalManifest, ensureCodingReport } from "../report";

function params(workspace: string) {
  return {
    workspace,
    beforeGitSnapshot: null,
    changed: [],
    verificationLines: [],
    toolErrorCount: 0,
    readArtifactPaths: [],
    readContextPaths: [],
    createdArtifactPaths: [],
  };
}

describe("child verifier composition", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("cascades failed child verdicts into parent blockers by default", async () => {
    const manifest = await buildFinalManifest({
      ...params(mkdtempSync(join(tmpdir(), "tanya-child-verifier-blocker-"))),
      childVerdicts: [{
        subRunId: "r-root.t-1",
        verdict: "failed",
        blockers: ["verification failed"],
        summary: "Child failed.",
        changedFiles: [],
        treatFailureAs: "blocker",
      }],
    });

    expect(manifest.blockers).toEqual(["subtask r-root.t-1 failed: verification failed"]);
    expect(manifest.childVerdicts).toHaveLength(1);
  });

  it("keeps warning child failures visible without blocking the parent", async () => {
    const manifest = await buildFinalManifest({
      ...params(mkdtempSync(join(tmpdir(), "tanya-child-verifier-warning-"))),
      childVerdicts: [{
        subRunId: "r-root.t-2",
        verdict: "failed",
        blockers: ["budget exceeded"],
        summary: "Child failed.",
        changedFiles: [],
        treatFailureAs: "warning",
      }],
    });

    expect(manifest.blockers).toEqual([]);
    expect(manifest.childWarnings).toEqual(["subtask r-root.t-2 failed: budget exceeded"]);
  });

  it("suppresses ignored child failures from the report manifest", async () => {
    const manifest = await buildFinalManifest({
      ...params(mkdtempSync(join(tmpdir(), "tanya-child-verifier-ignore-"))),
      childVerdicts: [{
        subRunId: "r-root.t-3",
        verdict: "failed",
        blockers: ["ignored"],
        summary: "Child failed.",
        changedFiles: [],
        treatFailureAs: "ignore",
      }],
    });

    expect(manifest.blockers).toEqual([]);
    expect(manifest.childVerdicts).toBeUndefined();
    expect(manifest.childWarnings).toBeUndefined();
  });

  it("drops `set -o pipefail; find/jar` SDK-presence probes when the build passed", async () => {
    const findProbe =
      'set -o pipefail; find / -path "*/com.revenuecat.purchases/purchases/8.10.0/*.jar" 2>/dev/null | head -5';
    const jarProbe =
      'set -o pipefail; jar tf /tmp/rc-classes.jar 2>/dev/null | grep -i purchases | head -10';
    const manifest = await buildFinalManifest({
      ...params(mkdtempSync(join(tmpdir(), "tanya-probe-prefix-"))),
      runContext: { task: { kind: "coding" } },
      verificationLines: [
        "Verification: ./gradlew assembleDebug -> passed",
        `Verification: ${findProbe} -> failed (Shell exited unknown.)`,
        `Verification: ${jarProbe} -> failed (Shell exited 1)`,
      ],
      blockers: [
        `failed verification: ${findProbe} -> failed (Shell exited unknown.)`,
        `failed verification: ${jarProbe} -> failed (Shell exited 1)`,
      ],
    });
    // A green gradle build is the gate; the find/jar SDK probes must not gate it.
    expect(manifest.blockers).toEqual([]);
  });

  it("still gates on a real failed build even with a `set -o pipefail;` prefix", async () => {
    const manifest = await buildFinalManifest({
      ...params(mkdtempSync(join(tmpdir(), "tanya-real-gate-"))),
      runContext: { task: { kind: "coding" } },
      verificationLines: ["Verification: set -o pipefail; ./gradlew assembleDebug -> failed"],
      blockers: ["failed verification: set -o pipefail; ./gradlew assembleDebug -> failed"],
    });
    expect(manifest.blockers).toEqual([
      "failed verification: set -o pipefail; ./gradlew assembleDebug -> failed",
    ]);
  });

  it("keeps reasoning advisory opt-in and leaves verifier blockers unchanged", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-reasoning-verifier-"));
    await appendReasoningChunk({
      workspace,
      runId: "r-reasoning",
      turn: 2,
      provider: "deepseek",
      model: "deepseek-reasoner",
      content: "I suspect the test failed because the fixture path was not updated.",
      tokens: 14,
    });

    const defaultManifest = await buildFinalManifest({
      ...params(workspace),
      runId: "r-reasoning",
      verificationLines: ["Verification: npm test -> failed"],
      blockers: ["failed verification: npm test -> failed"],
    });
    expect(defaultManifest.blockers).toEqual(["failed verification: npm test -> failed"]);
    expect(defaultManifest.reasoningAnnotations).toBeUndefined();

    vi.stubEnv("TANYA_VERIFIER_INCLUDE_REASONING", "1");
    const verboseManifest = await buildFinalManifest({
      ...params(workspace),
      runId: "r-reasoning",
      verificationLines: ["Verification: npm test -> failed"],
      blockers: ["failed verification: npm test -> failed"],
    });
    expect(verboseManifest.blockers).toEqual(defaultManifest.blockers);
    expect(verboseManifest.reasoningAnnotations).toEqual([expect.objectContaining({
      runId: "r-reasoning",
      turn: 2,
      provider: "deepseek",
      model: "deepseek-reasoner",
      confidence: "advisory",
      blocker: "failed verification: npm test -> failed",
      excerpt: expect.stringContaining("fixture path"),
    })]);

    const report = ensureCodingReport("Done.", verboseManifest, { task: { kind: "coding" } });
    expect(report).toContain("Reasoning annotations (advisory, not verifier authority):");
    expect(report).toContain("Why the agent thought this");
  });
});
