import { describe, expect, it } from "vitest";
import { bootVerdictToChecks, bootVerdictToManifest, buildBootReportText } from "../../src/runtime/manifest";
import { makeBootCheck, makeBootVerdict, type BootVerdict } from "../../src/runtime/types";

// The exact regex AppCreator/CosmoChat use downstream — keep verbatim.
const DOWNSTREAM_RESULT_REGEX = /TAN[IY]A RESULT:\s*(PASSED|FAIL)/i;

const passVerdict = makeBootVerdict({
  status: "pass",
  platform: "backend",
  reason: "server booted and answered HTTP 200",
  checks: [
    makeBootCheck({ id: "runtime-provision", description: "go build", passed: true }),
    makeBootCheck({ id: "runtime-alive", description: "alive after warmup", passed: true }),
  ],
  evidence: [{ kind: "log", path: "/ws/.tanya/runtime/t/boot.log" }],
  durationMs: 1234,
  evidenceDir: "/ws/.tanya/runtime/t",
});

const failVerdict: BootVerdict = makeBootVerdict({
  status: "fail",
  platform: "ios",
  reason: "app crashed during the 8000ms warmup",
  failedCheck: "crash",
  checks: [
    makeBootCheck({ id: "runtime-provision", description: "xcodebuild", passed: true }),
    makeBootCheck({ id: "runtime-alive", description: "alive after warmup", passed: false, detail: "crash report found" }),
  ],
  evidence: [{ kind: "crashlog", path: "/ws/.tanya/runtime/t/crash.ips", excerpt: "EXC_BAD_ACCESS" }],
  durationMs: 60_000,
  evidenceDir: "/ws/.tanya/runtime/t",
});

const skipVerdict = makeBootVerdict({
  status: "skipped",
  platform: "android",
  reason: "no Android device or AVD on this host",
  checks: [
    makeBootCheck({ id: "runtime-capability", description: "host capability probe", passed: true, skipped: true }),
  ],
  evidence: [],
});

describe("boot verdict → verifier checks", () => {
  it("maps pass checks to authoritative passing checks", () => {
    const checks = bootVerdictToChecks(passVerdict);
    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.passed && check.authoritative)).toBe(true);
  });

  it("maps a fail to a failing authoritative check with evidence pointer", () => {
    const checks = bootVerdictToChecks(failVerdict);
    const failing = checks.find((check) => !check.passed);
    expect(failing?.authoritative).toBe(true);
    expect(failing?.error).toContain("evidence: /ws/.tanya/runtime/t");
  });

  it("maps a skip to a single passing, non-authoritative, skipped check (invariant)", () => {
    const checks = bootVerdictToChecks(skipVerdict);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ passed: true, authoritative: false, skipped: true });
  });
});

describe("boot verdict → manifest + report text", () => {
  it("pass: no blockers, validation passed, authoritativePassed true, TANYA RESULT: PASSED", () => {
    const manifest = bootVerdictToManifest(passVerdict, { repoRoot: "/ws", head: "abc123", files: [] });
    expect(manifest.blockers).toEqual([]);
    expect(manifest.validation?.passed).toBe(true);
    expect(manifest.finalStateVerification?.authoritativePassed).toBe(true);
    expect(manifest.git).toEqual({ root: "/ws", head: "abc123" });

    const text = buildBootReportText(passVerdict, manifest);
    expect(DOWNSTREAM_RESULT_REGEX.exec(text)?.[1]).toBe("PASSED");
  });

  it("fail: blocker with evidence dir, authoritativePassed false, TANYA RESULT: FAIL", () => {
    const manifest = bootVerdictToManifest(failVerdict, null);
    expect(manifest.blockers).toHaveLength(1);
    expect(manifest.blockers[0]).toContain("runtime boot failed");
    expect(manifest.blockers[0]).toContain("evidence: /ws/.tanya/runtime/t");
    expect(manifest.validation?.passed).toBe(false);
    expect(manifest.finalStateVerification?.authoritativePassed).toBe(false);

    const text = buildBootReportText(failVerdict, manifest);
    expect(DOWNSTREAM_RESULT_REGEX.exec(text)?.[1]).toBe("FAIL");
  });

  it("skip: reads as not-failed downstream (no blockers, PASSED literal)", () => {
    const manifest = bootVerdictToManifest(skipVerdict, null);
    expect(manifest.blockers).toEqual([]);
    expect(manifest.validation?.passed).toBe(true);
    expect(manifest.finalStateVerification?.authoritativePassed).toBe(true);

    const text = buildBootReportText(skipVerdict, manifest);
    expect(DOWNSTREAM_RESULT_REGEX.exec(text)?.[1]).toBe("PASSED");
    expect(text).toContain("SKIPPED");
  });

  it("embeds a parseable manifest JSON block after the 'Tanya manifest:' marker", () => {
    const manifest = bootVerdictToManifest(failVerdict, null);
    const text = buildBootReportText(failVerdict, manifest);
    const jsonBlock = text.split("Tanya manifest:\n")[1]?.split("\nTANYA RESULT:")[0];
    expect(jsonBlock).toBeTruthy();
    const parsed = JSON.parse(jsonBlock ?? "{}") as { blockers?: string[] };
    expect(parsed.blockers).toHaveLength(1);
  });
});
