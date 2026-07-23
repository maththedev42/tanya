import { basename, join } from "node:path";
import {
  makeBootCheck,
  makeBootVerdict,
  makeEvidence,
  type BootAdapter,
  type BootCheckResult,
  type BootEvidence,
  type BootFailureKind,
  type BootVerdict,
  type RuntimeContext,
} from "../types";
import { maybeRunTier1 } from "../tier1/adapterHook";
import { makeIosInteractDriver } from "../tier1";
import {
  findAppBundle,
  firstScheme,
  newCrashReports,
  readPlistKey,
  runXcodegenIfNeeded,
  xcodeContainerArgs,
  xcodegenCapabilityGap,
  XCODEBUILD_TIMEOUT_MS,
} from "./appleShared";
import { logTailExcerpt } from "./backend";

const SIM_BOOT_TIMEOUT_MS = 180_000;

type SimulatorDevice = { udid: string; name: string; booted: boolean };

export function pickSimulator(simctlJson: string): SimulatorDevice | null {
  try {
    const parsed = JSON.parse(simctlJson) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string; isAvailable?: boolean }>>;
    };
    const devices: SimulatorDevice[] = [];
    for (const runtimeDevices of Object.values(parsed.devices ?? {})) {
      for (const device of runtimeDevices) {
        if (device.isAvailable === false || !device.udid || !device.name) continue;
        devices.push({ udid: device.udid, name: device.name, booted: device.state === "Booted" });
      }
    }
    return devices.find((device) => device.booted) ?? devices.find((device) => device.name.startsWith("iPhone")) ?? null;
  } catch {
    return null;
  }
}

export const iosAdapter: BootAdapter = {
  platform: "ios",
  capabilityProbe: async (ctx) => {
    const xcode = await ctx.exec.run(ctx.workspace, "xcodebuild", ["-version"], { timeoutMs: 30_000 });
    if (xcode.binaryMissing || xcode.exit !== 0) {
      return { ok: false, reason: "Xcode is not installed on this host" };
    }
    const sims = await ctx.exec.run(ctx.workspace, "xcrun", ["simctl", "list", "devices", "available", "-j"], {
      timeoutMs: 30_000,
    });
    if (sims.exit !== 0 || !pickSimulator(sims.stdout)) {
      return { ok: false, reason: "no available iPhone simulator (full Xcode with an iOS runtime required)" };
    }
    const xcodegenGap = await xcodegenCapabilityGap(ctx);
    if (xcodegenGap) return { ok: false, reason: xcodegenGap };
    return { ok: true };
  },
  boot: bootIos,
};

async function bootIos(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "ios", reason, failedCheck, checks, evidence });

  // ── provision: xcodegen + xcodebuild ─────────────────────
  const xcodegen = await runXcodegenIfNeeded(ctx);
  if (!xcodegen.ok) {
    checks.push(makeBootCheck({ id: "runtime-provision", description: "xcodegen generate", passed: false, detail: xcodegen.detail }));
    return fail("provision-failed", "xcodegen generate failed");
  }

  const container = xcodeContainerArgs(exec, workspace);
  if (!container) return fail("provision-failed", "no .xcodeproj or .xcworkspace in this workspace");
  const scheme = await firstScheme(ctx, container);
  if (!scheme) return fail("provision-failed", "could not list a build scheme (xcodebuild -list -json)");

  const sims = await exec.run(workspace, "xcrun", ["simctl", "list", "devices", "available", "-j"], {
    timeoutMs: 30_000,
  });
  const device = pickSimulator(sims.stdout);
  if (!device) return fail("launch-failed", "no available iPhone simulator (probe raced runtime removal)");

  // Shared per-workspace build cache (NOT per-run): keeps rebuilds warm and
  // bounds disk to one copy — per-run DerivedData measured ~80MB each.
  const derivedDataPath = join(workspace, ".tanya", "runtime", "DerivedData");
  ctx.emit(`xcodebuild -scheme ${scheme} (simulator ${device.name})`);
  const build = await exec.run(
    workspace,
    "xcodebuild",
    [
      ...container,
      "-scheme",
      scheme,
      "-configuration",
      "Debug",
      "-destination",
      `platform=iOS Simulator,id=${device.udid}`,
      "-derivedDataPath",
      derivedDataPath,
      "-quiet",
      "build",
    ],
    { timeoutMs: XCODEBUILD_TIMEOUT_MS },
  );
  if (build.exit !== 0) {
    const excerpt = logTailExcerpt(`${build.stdout}\n${build.stderr}`);
    evidence.push(makeEvidence("log", { excerpt }));
    checks.push(makeBootCheck({ id: "runtime-provision", description: `xcodebuild -scheme ${scheme}`, passed: false, detail: excerpt }));
    return fail(build.timedOut ? "timeout" : "provision-failed", "xcodebuild failed");
  }
  const appBundle = findAppBundle(exec, join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator"));
  if (!appBundle) return fail("provision-failed", "build succeeded but no .app bundle was produced");
  checks.push(makeBootCheck({ id: "runtime-provision", description: `xcodebuild -scheme ${scheme}`, passed: true, detail: appBundle }));

  // ── simulator boot ───────────────────────────────────────
  if (!device.booted) {
    ctx.emit(`booting simulator ${device.name}`);
    const boot = await exec.run(workspace, "xcrun", ["simctl", "boot", device.udid], { timeoutMs: 60_000 });
    if (boot.exit !== 0 && !/current state:?\s*Booted/i.test(`${boot.stdout}\n${boot.stderr}`)) {
      return fail("launch-failed", `simctl boot failed: ${logTailExcerpt(`${boot.stdout}\n${boot.stderr}`)}`);
    }
    const bootstatus = await exec.run(workspace, "xcrun", ["simctl", "bootstatus", device.udid, "-b"], {
      timeoutMs: SIM_BOOT_TIMEOUT_MS,
    });
    if (bootstatus.exit !== 0) {
      return fail("timeout", `simulator ${device.name} did not finish booting`);
    }
  }

  const bundleId = await readPlistKey(ctx, join(appBundle, "Info.plist"), "CFBundleIdentifier");
  if (!bundleId) return fail("launch-failed", "could not read CFBundleIdentifier from the built app");
  const appName = basename(appBundle).replace(/\.app$/, "");

  // Optional boot video: simctl recordVideo runs until interrupted (SIGINT
  // finalizes the mp4). Started right before launch so the clip captures the
  // app appearing + the warmup window; stopped before teardown on every path.
  const videoPath = join(ctx.evidenceDir, "boot.mp4");
  let recorder: Awaited<ReturnType<typeof exec.launch>> | null = null;
  const stopRecording = async () => {
    if (!recorder) return;
    await recorder.interrupt();
    recorder = null;
    if (exec.fileExists(videoPath)) {
      evidence.push(makeEvidence("video", { path: videoPath }));
      ctx.emit(`boot video saved: ${videoPath}`);
    } else {
      ctx.emit("boot video capture failed — recording evidence skipped");
    }
  };

  try {
    // ── install + launch ───────────────────────────────────
    const install = await exec.run(workspace, "xcrun", ["simctl", "install", device.udid, appBundle], {
      timeoutMs: 60_000,
    });
    if (install.exit !== 0) {
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: "simctl install", passed: false, detail: logTailExcerpt(`${install.stdout}\n${install.stderr}`) }),
      );
      return fail("launch-failed", "simctl install failed");
    }
    if (ctx.record) {
      ctx.emit("recording boot video (simctl recordVideo)");
      recorder = await exec.launch({
        command: "xcrun",
        args: ["simctl", "io", device.udid, "recordVideo", "--codec", "h264", "--force", videoPath],
        cwd: workspace,
      });
      // Give the recorder a beat to attach before the app appears.
      await exec.sleep(1_000);
    }
    const launchStart = exec.now();
    ctx.emit(`launching ${bundleId}`);
    const launch = await exec.run(workspace, "xcrun", ["simctl", "launch", device.udid, bundleId], {
      timeoutMs: 60_000,
    });
    if (launch.exit !== 0) {
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: `simctl launch ${bundleId}`, passed: false, detail: logTailExcerpt(`${launch.stdout}\n${launch.stderr}`) }),
      );
      return fail("launch-failed", `simctl launch ${bundleId} failed`);
    }
    checks.push(makeBootCheck({ id: "runtime-launch", description: `simctl launch ${bundleId}`, passed: true, detail: launch.stdout.trim() }));

    // ── observe through warmup: crash reports ──────────────
    await exec.sleep(ctx.warmupMs);
    const crashes = newCrashReports(exec, appName, launchStart);
    if (crashes.length > 0) {
      const crashPath = crashes[0] as string;
      const excerpt = (exec.readText(crashPath) ?? "").slice(0, 1_200);
      evidence.push(makeEvidence("crashlog", { path: crashPath, excerpt }));
      checks.push(
        makeBootCheck({ id: "runtime-alive", description: `no crash during ${ctx.warmupMs}ms warmup`, passed: false, detail: crashPath }),
      );
      return fail("crash", `${appName} crashed during the ${ctx.warmupMs}ms warmup (${crashPath})`);
    }
    checks.push(
      makeBootCheck({ id: "runtime-alive", description: `no crash during ${ctx.warmupMs}ms warmup`, passed: true }),
    );

    // ── first surface: screenshot ──────────────────────────
    const shotPath = join(ctx.evidenceDir, "first-frame.png");
    const shot = await exec.run(workspace, "xcrun", ["simctl", "io", device.udid, "screenshot", shotPath], {
      timeoutMs: 30_000,
    });
    if (shot.exit !== 0 || !exec.fileExists(shotPath)) {
      checks.push(
        makeBootCheck({ id: "runtime-surface", description: "first-frame screenshot", passed: true, skipped: true, detail: "simctl screenshot failed — screenshot evidence skipped" }),
      );
    } else {
      evidence.push(makeEvidence("screenshot", { path: shotPath }));
      const blank = await exec.isBlankImage(shotPath);
      if (blank.blank) {
        checks.push(makeBootCheck({ id: "runtime-surface", description: "first frame is not blank", passed: false, detail: blank.detail }));
        return fail("blank-first-frame", `app launched but the first frame is blank (${blank.detail})`);
      }
      checks.push(makeBootCheck({ id: "runtime-surface", description: "first frame is not blank", passed: true, detail: blank.detail }));
    }

    // ── Tier-1 agentic UI test (optional) ─────────────────────
    const ui = await maybeRunTier1(ctx, "ios", () => makeIosInteractDriver(exec, workspace, device.udid), checks, evidence);
    if (ui && !ui.passed) {
      return makeBootVerdict({
        status: "fail",
        platform: "ios",
        reason: `UI test failed: ${ui.summary}`,
        failedCheck: "ui-assertion-failed",
        checks,
        evidence,
        ui,
      });
    }

    return makeBootVerdict({
      status: "pass",
      platform: "ios",
      reason: ui
        ? `${appName} launched on ${device.name} and passed the agentic UI test`
        : `${appName} launched on ${device.name}, no crash through ${ctx.warmupMs}ms warmup`,
      checks,
      evidence,
      ...(ui !== null ? { ui } : {}),
    });
  } finally {
    // Stop the recorder before teardown so the clip ends on the running app,
    // not on the terminate. The verdict holds a reference to `evidence`, so
    // the video entry lands on every return path.
    await stopRecording();
    if (ctx.keepAlive) {
      ctx.emit(`keep-alive: ${bundleId} left running on ${device.name}`);
    } else {
      await exec.run(workspace, "xcrun", ["simctl", "terminate", device.udid, bundleId], { timeoutMs: 30_000 });
      // Only shut down a simulator we booted; leave the user's session alone.
      if (!device.booted) {
        await exec.run(workspace, "xcrun", ["simctl", "shutdown", device.udid], { timeoutMs: 60_000 });
      }
    }
  }
}
