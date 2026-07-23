import { describe, expect, it } from "vitest";
import { runBootTest } from "../../../src/runtime";
import { macosAdapter } from "../../../src/runtime/adapters/macos";
import { makeFakeExec, type RunCall, type RunResponse } from "../fakeExec";

const WS = "/ws";
const APP_BUNDLE = "/ws/.tanya/runtime/DerivedData/Build/Products/Debug/Cosmo.app";
const CRASH_DIR = "/home/tester/Library/Logs/DiagnosticReports";

const XCODE_FILES = {
  "/ws/project.yml": "name: Cosmo\ntargets:\n  Cosmo:\n    platform: macOS\n",
  "/ws/Cosmo.xcodeproj/project.pbxproj": "SDKROOT = macosx;",
  [`${APP_BUNDLE}/Contents/Info.plist`]: "<plist/>",
  [`${APP_BUNDLE}/Contents/MacOS/Cosmo`]: "binary",
};

const SWIFTPM_FILES = {
  "/ws/Package.swift": "// swift-tools-version:5.9",
  "/ws/Sources/tool/main.swift": "print(\"hi\")",
};

type Responder = (call: RunCall) => RunResponse | undefined;

function xcodeResponder(overrides: Responder = () => undefined): Responder {
  return (call) => {
    const custom = overrides(call);
    if (custom) return custom;
    const joined = `${call.command} ${call.args.join(" ")}`;
    if (call.command === "which") return { exit: 0, stdout: "/opt/homebrew/bin/xcodegen\n" };
    if (joined.includes("-list -json")) return { exit: 0, stdout: JSON.stringify({ project: { schemes: ["Cosmo"] } }) };
    if (call.command === "plutil") return { exit: 0, stdout: "Cosmo\n" };
    return { exit: 0 };
  };
}

function bootMacos(exec: ReturnType<typeof makeFakeExec>) {
  return runBootTest({ workspace: WS, platform: "macos", exec, adapters: [macosAdapter], runId: "t" });
}

describe("macos boot adapter — Xcode .app lane", () => {
  it("missing Xcode is a SKIP", async () => {
    const exec = makeFakeExec({
      files: XCODE_FILES,
      respond: (call) => (call.command === "xcodebuild" ? { binaryMissing: true, exit: 1 } : undefined),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("Xcode is not installed");
  });

  it("builds with platform=macOS, spawns the bundle executable directly, stays alive — PASS", async () => {
    const exec = makeFakeExec({ files: XCODE_FILES, respond: xcodeResponder() });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("pass");
    const buildCall = exec.calls.find((call) => call.command === "xcodebuild" && call.args.includes("build"));
    expect(buildCall?.args).toContain("platform=macOS");
    expect(exec.launches[0]?.options.command).toBe(`${APP_BUNDLE}/Contents/MacOS/Cosmo`);
    expect(exec.launches[0]?.killed).toBe(true);
    // xcodegen ran before the build (project.yml present).
    const xcodegenIndex = exec.calls.findIndex((call) => call.command === "xcodegen");
    const buildIndex = exec.calls.findIndex((call) => call.command === "xcodebuild" && call.args.includes("build"));
    expect(xcodegenIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(xcodegenIndex);
  });

  it("an app that exits during warmup is a crash FAIL", async () => {
    const exec = makeFakeExec({
      files: XCODE_FILES,
      respond: xcodeResponder(),
      launchScript: () => ({ exitAfterMs: 500, exitCode: 1, log: "Fatal error: missing entitlement\n" }),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
  });

  it("a new crash report during warmup is a crash FAIL", async () => {
    const crashFile = `${CRASH_DIR}/Cosmo-2026.ips`;
    const exec = makeFakeExec({
      files: { ...XCODE_FILES, [crashFile]: "SIGABRT" },
      mtimes: { [crashFile]: 99_999_999 },
      respond: xcodeResponder(),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
    expect(exec.launches[0]?.killCalls).toBeGreaterThan(0);
  });

  it("screencapture failure is advisory, not a gate", async () => {
    const exec = makeFakeExec({
      files: XCODE_FILES,
      respond: xcodeResponder((call) => (call.command === "screencapture" ? { exit: 1 } : undefined)),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("pass");
    const surface = verdict.checks.find((check) => check.description.includes("screen capture"));
    expect(surface?.skipped).toBe(true);
  });
});

describe("macos boot adapter — SwiftPM lane", () => {
  it("missing swift toolchain is a SKIP", async () => {
    const exec = makeFakeExec({
      files: SWIFTPM_FILES,
      respond: (call) => (call.command === "swift" ? { binaryMissing: true, exit: 1 } : undefined),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("Swift toolchain");
  });

  it("a CLI-style executable that exits 0 with output is a PASS", async () => {
    const exec = makeFakeExec({
      files: SWIFTPM_FILES,
      launchScript: () => ({ exitAfterMs: 200, exitCode: 0, log: "hi\n" }),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain("exit 0");
  });

  it("a long-running executable that stays alive is a PASS and torn down", async () => {
    const exec = makeFakeExec({ files: SWIFTPM_FILES, launchScript: () => ({ log: "serving\n" }) });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.launches[0]?.killed).toBe(true);
  });

  it("a nonzero exit during warmup is a crash FAIL", async () => {
    const exec = makeFakeExec({
      files: SWIFTPM_FILES,
      launchScript: () => ({ exitAfterMs: 100, exitCode: 1, log: "Fatal error\n" }),
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
  });

  it("swift build failure is a provision FAIL", async () => {
    const exec = makeFakeExec({
      files: SWIFTPM_FILES,
      respond: (call) =>
        call.command === "swift" && call.args[0] === "build"
          ? { exit: 1, stderr: "error: cannot find 'Router' in scope" }
          : undefined,
    });
    const verdict = await bootMacos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("provision-failed");
  });
});
