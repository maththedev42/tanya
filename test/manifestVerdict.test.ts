import { describe, expect, it } from "vitest";
import { ensureCodingReport } from "../src/agent/report";
import type { TanyaFinalManifest } from "../src/agent/runner";
import type { FinalStateVerification } from "../src/agent/verifier/types";

function baseManifest(overrides: Partial<TanyaFinalManifest> = {}): TanyaFinalManifest {
  return {
    schemaVersion: 1,
    changedFiles: [],
    uncommittedFiles: [],
    artifactsRead: [],
    artifactsCreated: [],
    contextFilesRead: [],
    verification: [],
    git: { root: null, head: null },
    toolErrors: 0,
    blockers: [],
    ...overrides,
  };
}

function fsv(overrides: Partial<FinalStateVerification> = {}): FinalStateVerification {
  return {
    ranVerifiers: [],
    checks: [],
    authoritativePassed: false,
    newBlockers: [],
    warnings: [],
    recoveredFailureCommands: [],
    ...overrides,
  };
}

function verdict(text: string): "PASSED" | "FAIL" | null {
  const m = text.trim().match(/TANYA RESULT:\s*(PASSED|FAIL)\s*$/);
  return m ? (m[1] as "PASSED" | "FAIL") : null;
}

describe("manifestVerdict via ensureCodingReport", () => {
  it("PASSES when the final-state verifier ran no applicable checks (e.g. XcodeGen iOS, no Package.swift)", () => {
    // The historical bug: authoritativePassed === false on an EMPTY check set
    // was treated as FAIL, even though inline verification (build/test) passed
    // and there were no blockers. An empty final state is inconclusive, not a
    // failure.
    const manifest = baseManifest({
      finalStateVerification: fsv({ ranVerifiers: [], checks: [], authoritativePassed: false, newBlockers: [] }),
    });
    expect(verdict(ensureCodingReport("done", manifest))).toBe("PASSED");
  });

  it("FAILS when an authoritative final-state check failed (newBlockers merged into blockers)", () => {
    const manifest = baseManifest({
      blockers: ["final-state check failed: xcodebuild build"],
      finalStateVerification: fsv({
        authoritativePassed: false,
        newBlockers: ["final-state check failed: xcodebuild build"],
      }),
    });
    expect(verdict(ensureCodingReport("done", manifest))).toBe("FAIL");
  });

  it("FAILS when there are blockers regardless of final-state verification", () => {
    const manifest = baseManifest({ blockers: ["failed verification: go build"] });
    expect(verdict(ensureCodingReport("done", manifest))).toBe("FAIL");
  });

  it("PASSES a clean run with passing authoritative checks", () => {
    const manifest = baseManifest({
      finalStateVerification: fsv({ ranVerifiers: ["go-backend"], authoritativePassed: true }),
    });
    expect(verdict(ensureCodingReport("done", manifest))).toBe("PASSED");
  });
});
