import { describe, expect, it } from "vitest";
import { runBootTest } from "../../../src/runtime";
import { iosAdapter, pickSimulator } from "../../../src/runtime/adapters/ios";
import { makeFakeExec, type RunCall, type RunResponse } from "../fakeExec";

const WS = "/ws";
const APP_BUNDLE = "/ws/.tanya/runtime/DerivedData/Build/Products/Debug-iphonesimulator/App.app";
const SHOT_PATH = "/ws/.tanya/runtime/t/first-frame.png";
const CRASH_DIR = "/home/tester/Library/Logs/DiagnosticReports";

const simJson = (state: "Shutdown" | "Booted") =>
  JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
        { udid: "UDID-1", name: "iPhone 16", state, isAvailable: true },
      ],
    },
  });

const IOS_FILES = {
  "/ws/project.yml": "name: App\ntargets:\n  App:\n    platform: iOS\n",
  "/ws/App.xcodeproj/project.pbxproj": "SDKROOT = iphoneos;",
  [`${APP_BUNDLE}/Info.plist`]: "<plist/>",
};

type Responder = (call: RunCall) => RunResponse | undefined;

function happyResponder(simState: "Shutdown" | "Booted" = "Shutdown", overrides: Responder = () => undefined): Responder {
  return (call) => {
    const custom = overrides(call);
    if (custom) return custom;
    const joined = `${call.command} ${call.args.join(" ")}`;
    if (joined.includes("simctl list")) return { exit: 0, stdout: simJson(simState) };
    if (call.command === "which") return { exit: 0, stdout: "/opt/homebrew/bin/xcodegen\n" };
    if (joined.includes("-list -json")) return { exit: 0, stdout: JSON.stringify({ project: { schemes: ["App"] } }) };
    if (call.command === "plutil") return { exit: 0, stdout: "com.cosmo.app\n" };
    if (joined.includes("simctl launch")) return { exit: 0, stdout: "com.cosmo.app: 7777\n" };
    return { exit: 0 };
  };
}

function bootIos(exec: ReturnType<typeof makeFakeExec>) {
  return runBootTest({ workspace: WS, platform: "ios", exec, adapters: [iosAdapter], runId: "t" });
}

describe("ios boot adapter", () => {
  it("picks a booted simulator first, else the first available iPhone", () => {
    expect(pickSimulator(simJson("Booted"))?.booted).toBe(true);
    expect(pickSimulator(simJson("Shutdown"))).toMatchObject({ udid: "UDID-1", booted: false });
    expect(pickSimulator("not-json")).toBeNull();
    expect(pickSimulator(JSON.stringify({ devices: {} }))).toBeNull();
  });

  it("missing Xcode is a SKIP, never a FAIL", async () => {
    const exec = makeFakeExec({
      files: IOS_FILES,
      respond: (call) => (call.command === "xcodebuild" ? { binaryMissing: true, exit: 1 } : undefined),
    });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("Xcode is not installed");
  });

  it("project.yml without xcodegen on the host is a SKIP with that reason", async () => {
    const exec = makeFakeExec({
      files: IOS_FILES,
      respond: happyResponder("Shutdown", (call) => (call.command === "which" ? { exit: 1, stdout: "" } : undefined)),
    });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("xcodegen is not installed");
  });

  it("runs `xcodegen generate` BEFORE any xcodebuild build when project.yml exists (the stale-xcodeproj gotcha)", async () => {
    const exec = makeFakeExec({ files: IOS_FILES, respond: happyResponder() });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("pass");
    const xcodegenIndex = exec.calls.findIndex((call) => call.command === "xcodegen" && call.args[0] === "generate");
    const buildIndex = exec.calls.findIndex((call) => call.command === "xcodebuild" && call.args.includes("build"));
    expect(xcodegenIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(xcodegenIndex);
  });

  it("skips xcodegen when there is no project.yml", async () => {
    const files = { ...IOS_FILES };
    delete (files as Record<string, string>)["/ws/project.yml"];
    const exec = makeFakeExec({ files, respond: happyResponder() });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.calls.some((call) => call.command === "xcodegen")).toBe(false);
  });

  it("xcodebuild failure is a provision FAIL with log evidence", async () => {
    const exec = makeFakeExec({
      files: IOS_FILES,
      respond: happyResponder("Shutdown", (call) =>
        call.command === "xcodebuild" && call.args.includes("build")
          ? { exit: 65, stderr: "error: cannot find 'PaywallView' in scope" }
          : undefined,
      ),
    });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("provision-failed");
    expect(verdict.evidence.some((item) => item.excerpt?.includes("cannot find 'PaywallView'"))).toBe(true);
  });

  it("a NEW crash report during warmup is a crash FAIL with crashlog evidence", async () => {
    const crashFile = `${CRASH_DIR}/App-2026-06-10-120000.ips`;
    const exec = makeFakeExec({
      files: { ...IOS_FILES, [crashFile]: '{"exception":"EXC_BAD_ACCESS"}' },
      mtimes: { [crashFile]: 99_999_999 },
      respond: happyResponder(),
    });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
    expect(verdict.evidence.some((item) => item.kind === "crashlog" && item.excerpt?.includes("EXC_BAD_ACCESS"))).toBe(true);
  });

  it("a STALE crash report from before launch does not fail the run", async () => {
    const crashFile = `${CRASH_DIR}/App-2026-01-01-000000.ips`;
    const exec = makeFakeExec({
      // Default fake mtime (500_000) predates the fake clock (1_000_000+).
      files: { ...IOS_FILES, [crashFile]: "old crash" },
      respond: happyResponder(),
    });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("pass");
  });

  it("blank first frame is a FAIL", async () => {
    const exec = makeFakeExec({
      files: { ...IOS_FILES, [SHOT_PATH]: "png" },
      respond: happyResponder(),
      blankImage: (path) => path === SHOT_PATH,
    });
    const verdict = await bootIos(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("blank-first-frame");
  });

  it("tears down: terminate always; shutdown only a simulator WE booted", async () => {
    const weBooted = makeFakeExec({ files: IOS_FILES, respond: happyResponder("Shutdown") });
    await bootIos(weBooted);
    const weBootedCmds = weBooted.calls.map((call) => call.args.join(" "));
    expect(weBootedCmds.some((cmd) => cmd.includes("simctl terminate"))).toBe(true);
    expect(weBootedCmds.some((cmd) => cmd.includes("simctl shutdown"))).toBe(true);

    const alreadyBooted = makeFakeExec({ files: IOS_FILES, respond: happyResponder("Booted") });
    await bootIos(alreadyBooted);
    const alreadyBootedCmds = alreadyBooted.calls.map((call) => call.args.join(" "));
    expect(alreadyBootedCmds.some((cmd) => cmd.includes("simctl terminate"))).toBe(true);
    expect(alreadyBootedCmds.some((cmd) => cmd.includes("simctl shutdown"))).toBe(false);
    expect(alreadyBootedCmds.some((cmd) => cmd.includes("simctl boot "))).toBe(false);
  });

  it("--record captures a boot video: recordVideo started before launch, interrupted before teardown", async () => {
    const videoPath = "/ws/.tanya/runtime/t/boot.mp4";
    const exec = makeFakeExec({
      files: { ...IOS_FILES, [videoPath]: "mp4-bytes" },
      respond: happyResponder(),
    });
    const verdict = await runBootTest({
      workspace: WS,
      platform: "ios",
      exec,
      adapters: [iosAdapter],
      runId: "t",
      record: true,
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.evidence.some((item) => item.kind === "video" && item.path === videoPath)).toBe(true);

    const recorder = exec.launches.find((launch) => launch.options.args.includes("recordVideo"));
    expect(recorder).toBeDefined();
    expect(recorder?.interruptCalls).toBe(1);
    // recordVideo starts before simctl launch, and is stopped before terminate.
    const launchIndex = exec.calls.findIndex((call) => call.args.join(" ").includes("simctl launch"));
    expect(launchIndex).toBeGreaterThan(-1);

    // Without --record, no recorder is spawned.
    const plain = makeFakeExec({ files: IOS_FILES, respond: happyResponder() });
    await runBootTest({ workspace: WS, platform: "ios", exec: plain, adapters: [iosAdapter], runId: "t" });
    expect(plain.launches.some((launch) => launch.options.args.includes("recordVideo"))).toBe(false);
  });

  it("recorder is interrupted even when the boot FAILS (crash path)", async () => {
    const crashFile = `${CRASH_DIR}/App-rec.ips`;
    const exec = makeFakeExec({
      files: { ...IOS_FILES, [crashFile]: "crash" },
      mtimes: { [crashFile]: 99_999_999 },
      respond: happyResponder(),
    });
    const verdict = await runBootTest({
      workspace: WS,
      platform: "ios",
      exec,
      adapters: [iosAdapter],
      runId: "t",
      record: true,
    });
    expect(verdict.status).toBe("fail");
    const recorder = exec.launches.find((launch) => launch.options.args.includes("recordVideo"));
    expect(recorder?.interruptCalls).toBe(1);
  });

  it("teardown still runs when a check fails after launch", async () => {
    const crashFile = `${CRASH_DIR}/App-crash.ips`;
    const exec = makeFakeExec({
      files: { ...IOS_FILES, [crashFile]: "crash" },
      mtimes: { [crashFile]: 99_999_999 },
      respond: happyResponder(),
    });
    await bootIos(exec);
    expect(exec.calls.some((call) => call.args.join(" ").includes("simctl terminate"))).toBe(true);
  });
});
