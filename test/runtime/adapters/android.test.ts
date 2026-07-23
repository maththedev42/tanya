import { describe, expect, it } from "vitest";
import { runBootTest } from "../../../src/runtime";
import { androidAdapter } from "../../../src/runtime/adapters/android";
import { makeFakeExec, type RunCall, type RunResponse } from "../fakeExec";

const WS = "/ws";
const APK = "/ws/app/build/outputs/apk/debug/app-debug.apk";
const APP_ID = "com.cosmo.notes";

const ANDROID_FILES = {
  "/ws/gradlew": "#!/bin/sh",
  "/ws/settings.gradle.kts": 'include(":app")',
  "/ws/app/build.gradle.kts": `android { defaultConfig { applicationId = "${APP_ID}" } }`,
  [APK]: "apk-bytes",
};

type Responder = (call: RunCall) => RunResponse | undefined;

// Baseline: device connected, everything succeeds, app alive, no crash.
function happyResponder(overrides: Responder = () => undefined): Responder {
  return (call) => {
    const custom = overrides(call);
    if (custom) return custom;
    const joined = `${call.command} ${call.args.join(" ")}`;
    if (joined === "adb devices") return { exit: 0, stdout: "List of devices attached\nemulator-5554\tdevice\n" };
    if (call.command === "adb" && call.args.includes("pidof")) return { exit: 0, stdout: "12345\n" };
    if (call.command === "adb" && call.args.includes("logcat")) return { exit: 0, stdout: "" };
    return { exit: 0 };
  };
}

function bootAndroid(exec: ReturnType<typeof makeFakeExec>) {
  return runBootTest({ workspace: WS, platform: "android", exec, adapters: [androidAdapter], runId: "t" });
}

describe("android boot adapter", () => {
  it("missing adb is a SKIP, never a FAIL", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: (call) => (call.command === "adb" ? { binaryMissing: true, exit: 1 } : undefined),
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("adb not available");
  });

  it("no device and no AVD is a SKIP", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: (call) => {
        if (call.command === "adb" && call.args[0] === "devices") return { exit: 0, stdout: "List of devices attached\n" };
        if (call.command === "emulator") return { exit: 0, stdout: "" };
        return { exit: 0 };
      },
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("no Android device");
  });

  it("happy path on a connected device: build, install, launch, alive — PASS", async () => {
    const exec = makeFakeExec({ files: ANDROID_FILES, respond: happyResponder(), blankImage: () => false });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("pass");
    expect(verdict.reason).toContain(APP_ID);

    const commands = exec.calls.map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(commands).toContain("./gradlew assembleDebug --no-daemon");
    expect(commands.some((cmd) => cmd.includes(`install -r ${APK}`))).toBe(true);
    expect(commands.some((cmd) => cmd.includes(`monkey -p ${APP_ID}`))).toBe(true);
    // Force-stop teardown ran even on success.
    expect(commands.some((cmd) => cmd.includes(`force-stop ${APP_ID}`))).toBe(true);
    // Connected device → no emulator launched.
    expect(exec.launches).toHaveLength(0);
  });

  it("gradle failure is a provision FAIL with log evidence", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: happyResponder((call) =>
        call.command === "./gradlew" ? { exit: 1, stderr: "e: Unresolved reference: viewModel" } : undefined,
      ),
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("provision-failed");
    expect(verdict.evidence.some((item) => item.excerpt?.includes("Unresolved reference"))).toBe(true);
  });

  it("a crash in logcat during warmup is a crash FAIL with crashlog evidence", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: happyResponder((call) => {
        if (call.command === "adb" && call.args.includes("logcat") && call.args.includes("-d")) {
          return { exit: 0, stdout: `FATAL EXCEPTION: main\nProcess: ${APP_ID}, PID: 12345\njava.lang.NullPointerException` };
        }
        return undefined;
      }),
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("crash");
    expect(verdict.evidence.some((item) => item.kind === "crashlog" && item.excerpt?.includes("NullPointerException"))).toBe(true);
  });

  it("dead process after warmup is a no-process FAIL", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: happyResponder((call) =>
        call.command === "adb" && call.args.includes("pidof") ? { exit: 1, stdout: "" } : undefined,
      ),
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("no-process");
  });

  it("boots a headless AVD when no device is connected, and tears it down", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: happyResponder((call) => {
        if (call.command === "adb" && call.args[0] === "devices") return { exit: 0, stdout: "List of devices attached\n" };
        if (call.command === "emulator" && call.args[0] === "-list-avds") return { exit: 0, stdout: "Pixel_8_API_35\n" };
        if (call.command === "adb" && call.args.includes("sys.boot_completed")) return { exit: 0, stdout: "1\n" };
        return undefined;
      }),
      blankImage: () => false,
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("pass");
    expect(exec.launches).toHaveLength(1);
    expect(exec.launches[0]?.options.command).toBe("emulator");
    expect(exec.launches[0]?.options.args).toContain("-no-window");
    expect(exec.launches[0]?.killCalls).toBeGreaterThan(0);
  });

  it("blank first frame is a FAIL", async () => {
    const exec = makeFakeExec({
      files: { ...ANDROID_FILES, "/ws/.tanya/runtime/t/first-frame.png": "png" },
      respond: happyResponder(),
      blankImage: () => true,
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("fail");
    expect(verdict.failedCheck).toBe("blank-first-frame");
  });

  it("screencap failure is advisory, not a gate", async () => {
    const exec = makeFakeExec({
      files: ANDROID_FILES,
      respond: happyResponder((call) =>
        call.command === "adb" && call.args.includes("screencap") ? { exit: 1, stderr: "screencap failed" } : undefined,
      ),
    });
    const verdict = await bootAndroid(exec);
    expect(verdict.status).toBe("pass");
    const surface = verdict.checks.find((check) => check.description.includes("screenshot"));
    expect(surface?.skipped).toBe(true);
  });
});
