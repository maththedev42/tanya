import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyFinalState } from "../../src/agent/verifier";
import { runtimeBootVerifier } from "../../src/agent/verifier/verifiers/runtimeBoot";
import { builtinVerifiers } from "../../src/agent/verifier/registry";

const baseCtx = {
  workspace: "/tmp/nowhere",
  prompt: "",
  shell: async () => ({ exit: 1, stdout: "", stderr: "noop" }),
  fileExists: () => false,
  readText: () => null,
};

afterEach(() => {
  delete process.env.TANYA_RUNTIME_CHECK;
});

describe("runtime-boot verifier", () => {
  it("is registered in the builtin verifier chain", () => {
    expect(builtinVerifiers.some((verifier) => verifier.id === "runtime-boot")).toBe(true);
  });

  it("does NOT apply without an explicit opt-in (normal coding runs never boot apps)", async () => {
    expect(await runtimeBootVerifier.appliesTo({ ...baseCtx, runContext: undefined })).toBe(false);
    expect(await runtimeBootVerifier.appliesTo({ ...baseCtx, runContext: { metadata: {} } })).toBe(false);
  });

  it("applies with metadata.runtimeCheck (set by tanya run --runtime-check)", async () => {
    expect(await runtimeBootVerifier.appliesTo({ ...baseCtx, runContext: { metadata: { runtimeCheck: true } } })).toBe(true);
  });

  it("applies with metadata.tier1 alone (set by tanya run --tier1)", async () => {
    expect(await runtimeBootVerifier.appliesTo({ ...baseCtx, runContext: { metadata: { tier1: true } } })).toBe(true);
  });

  it("applies with TANYA_RUNTIME_CHECK=1", async () => {
    process.env.TANYA_RUNTIME_CHECK = "1";
    expect(await runtimeBootVerifier.appliesTo({ ...baseCtx, runContext: undefined })).toBe(true);
  });

  it("under the test runner it returns a skipped, non-authoritative check (never boots)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-runtime-verifier-"));
    const verification = await verifyFinalState({
      workspace,
      runContext: { metadata: { runtimeCheck: true } },
      verifiers: [runtimeBootVerifier],
    });
    expect(verification.checks).toHaveLength(1);
    expect(verification.checks[0]).toMatchObject({
      id: "runtime-boot",
      passed: true,
      authoritative: false,
      skipped: true,
    });
    // A skip is "inconclusive", never a failure: no blockers, no warnings.
    // (authoritativePassed stays false here only because zero authoritative
    // checks ran — the existing chain semantic; blockers are the FAIL gate.)
    expect(verification.newBlockers).toEqual([]);
    expect(verification.warnings).toEqual([]);
  });
});
