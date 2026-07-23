import { join } from "node:path";
import {
  makeBootCheck,
  makeBootVerdict,
  makeEvidence,
  type BootAdapter,
  type BootCheckResult,
  type BootEvidence,
  type BootFailureKind,
  type BootVerdict,
  type LaunchHandle,
  type RuntimeContext,
  type RuntimeExec,
} from "../types";
import { maybeRunTier1 } from "../tier1/adapterHook";
import { makeAndroidInteractDriver } from "../tier1";
import { logTailExcerpt } from "./backend";

const GRADLE_TIMEOUT_MS = 300_000;
const EMULATOR_BOOT_TIMEOUT_MS = 180_000;
const ADB_TIMEOUT_MS = 120_000;

function parseConnectedSerial(adbDevicesOutput: string): string | null {
  for (const line of adbDevicesOutput.split(/\r?\n/).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === "device") return serial;
  }
  return null;
}

export const androidAdapter: BootAdapter = {
  platform: "android",
  capabilityProbe: async (ctx) => {
    const adb = await ctx.exec.run(ctx.workspace, "adb", ["version"], { timeoutMs: 15_000 });
    if (adb.binaryMissing || adb.exit !== 0) {
      return { ok: false, reason: "adb not available on this host (Android SDK platform-tools)" };
    }
    const devices = await ctx.exec.run(ctx.workspace, "adb", ["devices"], { timeoutMs: 15_000 });
    if (parseConnectedSerial(devices.stdout)) return { ok: true };
    const avds = await ctx.exec.run(ctx.workspace, "emulator", ["-list-avds"], { timeoutMs: 15_000 });
    if (!avds.binaryMissing && avds.exit === 0 && avds.stdout.trim()) return { ok: true };
    return { ok: false, reason: "no Android device connected and no AVD available to boot" };
  },
  boot: bootAndroid,
};

async function bootAndroid(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "android", reason, failedCheck, checks, evidence });

  // adb helper that pins the device serial once one is known.
  let serial: string | null = null;
  const adb = (args: string[], timeoutMs = ADB_TIMEOUT_MS) =>
    exec.run(workspace, "adb", serial ? ["-s", serial, ...args] : args, { timeoutMs });

  // ── provision: gradle build ──────────────────────────────
  ctx.emit("./gradlew assembleDebug");
  const build = await exec.run(workspace, "./gradlew", ["assembleDebug", "--no-daemon"], {
    timeoutMs: GRADLE_TIMEOUT_MS,
  });
  if (build.exit !== 0) {
    const excerpt = logTailExcerpt(`${build.stdout}\n${build.stderr}`);
    evidence.push(makeEvidence("log", { excerpt }));
    checks.push(makeBootCheck({ id: "runtime-provision", description: "gradlew assembleDebug", passed: false, detail: excerpt }));
    return fail(build.timedOut ? "timeout" : "provision-failed", "gradle assembleDebug failed");
  }
  const apk = findDebugApk(exec, workspace);
  if (!apk) {
    checks.push(
      makeBootCheck({ id: "runtime-provision", description: "locate debug apk", passed: false, detail: "no */build/outputs/apk/debug/*.apk after build" }),
    );
    return fail("provision-failed", "build succeeded but no debug APK was produced");
  }
  checks.push(makeBootCheck({ id: "runtime-provision", description: "gradlew assembleDebug", passed: true, detail: apk.path }));

  const applicationId = findApplicationId(exec, workspace, apk.module);
  if (!applicationId) {
    return fail("launch-failed", `could not determine applicationId from ${apk.module}/build.gradle(.kts)`);
  }

  // ── device: reuse a connected one or boot an AVD headless ─
  let emulatorHandle: LaunchHandle | null = null;
  serial = parseConnectedSerial((await adb(["devices"], 15_000)).stdout);
  if (!serial) {
    const avds = await exec.run(workspace, "emulator", ["-list-avds"], { timeoutMs: 15_000 });
    const avd = avds.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (!avd) return fail("launch-failed", "no AVD available (capability probe raced device removal)");
    ctx.emit(`booting headless emulator: ${avd}`);
    emulatorHandle = await exec.launch({
      command: "emulator",
      args: ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim"],
      cwd: workspace,
      logPath: join(ctx.evidenceDir, "emulator.log"),
    });
    const waited = await adb(["wait-for-device"], EMULATOR_BOOT_TIMEOUT_MS);
    if (waited.exit !== 0) {
      await teardown();
      return fail("timeout", "emulator never reached adb (wait-for-device failed)");
    }
    const bootDeadline = exec.now() + EMULATOR_BOOT_TIMEOUT_MS;
    let booted = false;
    while (exec.now() < bootDeadline) {
      const prop = await adb(["shell", "getprop", "sys.boot_completed"], 15_000);
      if (prop.stdout.trim() === "1") {
        booted = true;
        break;
      }
      await exec.sleep(2_000);
    }
    if (!booted) {
      await teardown();
      return fail("timeout", `emulator did not finish booting within ${EMULATOR_BOOT_TIMEOUT_MS}ms`);
    }
  }

  async function teardown(): Promise<void> {
    if (ctx.keepAlive) {
      ctx.emit("keep-alive: app and emulator left running");
      return;
    }
    await adb(["shell", "am", "force-stop", applicationId ?? ""], 15_000).catch(() => undefined);
    if (emulatorHandle) await emulatorHandle.killTree();
  }

  // Optional boot video: screenrecord runs on-device (180s hard cap) and
  // finalizes its mp4 on SIGINT, so stop = pkill -INT on the device, a beat
  // for the moov atom, then pull. Started right before launch so the clip
  // captures the app appearing + warmup + the Tier-1 session.
  const videoPath = join(ctx.evidenceDir, "boot.mp4");
  const REMOTE_VIDEO = "/sdcard/tanya-boot.mp4";
  let recorder: LaunchHandle | null = null;
  const stopRecording = async (): Promise<void> => {
    if (!recorder) return;
    const handle = recorder;
    recorder = null;
    await adb(["shell", "pkill", "-INT", "screenrecord"], 15_000).catch(() => undefined);
    await exec.sleep(1_500);
    await handle.killTree();
    const pulled = await adb(["pull", REMOTE_VIDEO, videoPath], 30_000);
    await adb(["shell", "rm", "-f", REMOTE_VIDEO], 15_000).catch(() => undefined);
    if (pulled.exit === 0 && exec.fileExists(videoPath)) {
      evidence.push(makeEvidence("video", { path: videoPath }));
      ctx.emit(`boot video saved: ${videoPath}`);
    } else {
      ctx.emit("boot video capture failed — recording evidence skipped");
    }
  };

  try {
    // ── install + launch ───────────────────────────────────
    ctx.emit(`adb install ${apk.path}`);
    const install = await adb(["install", "-r", apk.path]);
    if (install.exit !== 0) {
      const excerpt = logTailExcerpt(`${install.stdout}\n${install.stderr}`);
      evidence.push(makeEvidence("log", { excerpt }));
      checks.push(makeBootCheck({ id: "runtime-launch", description: "adb install", passed: false, detail: excerpt }));
      return fail("launch-failed", "adb install failed");
    }
    if (ctx.record) {
      ctx.emit("recording boot video (adb screenrecord)");
      recorder = await exec.launch({
        command: "adb",
        args: [...(serial ? ["-s", serial] : []), "shell", "screenrecord", "--time-limit", "180", REMOTE_VIDEO],
        cwd: workspace,
      });
      // Give the recorder a beat to attach before the app appears.
      await exec.sleep(1_000);
    }
    await adb(["logcat", "-b", "crash", "-c"], 15_000); // clear old crashes
    ctx.emit(`launching ${applicationId}`);
    const launch = await adb(["shell", "monkey", "-p", applicationId, "-c", "android.intent.category.LAUNCHER", "1"], 30_000);
    if (launch.exit !== 0) {
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: `launch ${applicationId}`, passed: false, detail: logTailExcerpt(`${launch.stdout}\n${launch.stderr}`) }),
      );
      return fail("launch-failed", `could not launch ${applicationId} (no LAUNCHER activity?)`);
    }
    checks.push(makeBootCheck({ id: "runtime-launch", description: `launch ${applicationId}`, passed: true }));

    // ── observe through warmup ─────────────────────────────
    await exec.sleep(ctx.warmupMs);
    const crashLog = await adb(["logcat", "-d", "-b", "crash", "-t", "200"], 15_000);
    if (crashLog.stdout.includes(applicationId)) {
      const excerpt = logTailExcerpt(crashLog.stdout);
      const crashPath = join(ctx.evidenceDir, "logcat-crash.log");
      await exec.writeFile(crashPath, crashLog.stdout).catch(() => undefined);
      evidence.push(makeEvidence("crashlog", { path: crashPath, excerpt }));
      checks.push(
        makeBootCheck({ id: "runtime-alive", description: `no crash during ${ctx.warmupMs}ms warmup`, passed: false, detail: excerpt.slice(0, 300) }),
      );
      return fail("crash", `${applicationId} crashed during the ${ctx.warmupMs}ms warmup`);
    }
    const pid = await adb(["shell", "pidof", applicationId], 15_000);
    if (!pid.stdout.trim()) {
      checks.push(
        makeBootCheck({ id: "runtime-alive", description: `process alive after ${ctx.warmupMs}ms warmup`, passed: false, detail: "pidof returned nothing" }),
      );
      return fail("no-process", `${applicationId} is not running after the ${ctx.warmupMs}ms warmup`);
    }
    checks.push(makeBootCheck({ id: "runtime-alive", description: `process alive after ${ctx.warmupMs}ms warmup`, passed: true, detail: `pid ${pid.stdout.trim()}` }));

    // ── first surface: screenshot ──────────────────────────
    const shotPath = join(ctx.evidenceDir, "first-frame.png");
    const screencap = await adb(["shell", "screencap", "-p", "/sdcard/tanya-boot.png"], 30_000);
    const pulled = screencap.exit === 0 ? await adb(["pull", "/sdcard/tanya-boot.png", shotPath], 30_000) : null;
    await adb(["shell", "rm", "-f", "/sdcard/tanya-boot.png"], 15_000).catch(() => undefined);
    if (!pulled || pulled.exit !== 0 || !exec.fileExists(shotPath)) {
      checks.push(
        makeBootCheck({ id: "runtime-surface", description: "first-frame screenshot", passed: true, skipped: true, detail: "screencap failed — screenshot evidence skipped" }),
      );
    } else {
      evidence.push(makeEvidence("screenshot", { path: shotPath }));
      const blank = await exec.isBlankImage(shotPath);
      if (blank.blank) {
        checks.push(makeBootCheck({ id: "runtime-surface", description: "first frame is not blank", passed: false, detail: blank.detail }));
        return fail("blank-first-frame", `app is running but the first frame is blank (${blank.detail})`);
      }
      checks.push(makeBootCheck({ id: "runtime-surface", description: "first frame is not blank", passed: true, detail: blank.detail }));
    }

    // ── Tier-1 agentic UI test (optional) ──────────────────
    const ui = await maybeRunTier1(ctx, "android", () => makeAndroidInteractDriver(exec, workspace, serial), checks, evidence);
    if (ui && !ui.passed) {
      return makeBootVerdict({
        status: "fail",
        platform: "android",
        reason: `UI test failed: ${ui.summary}`,
        failedCheck: "ui-assertion-failed",
        checks,
        evidence,
        ui,
      });
    }

    return makeBootVerdict({
      status: "pass",
      platform: "android",
      reason: ui
        ? `${applicationId} launched and passed the agentic UI test`
        : `${applicationId} launched, stayed alive through ${ctx.warmupMs}ms warmup with no crash`,
      checks,
      evidence,
      ...(ui !== null ? { ui } : {}),
    });
  } finally {
    await stopRecording();
    await teardown();
  }
}

function findDebugApk(exec: RuntimeExec, workspace: string): { module: string; path: string } | null {
  const candidates = ["app", ...exec.listDir(workspace).filter((name) => name !== "app")];
  for (const moduleName of candidates) {
    const apkDir = join(workspace, moduleName, "build", "outputs", "apk", "debug");
    const apk = exec
      .listDir(apkDir)
      .filter((name) => name.endsWith(".apk"))
      .sort()[0];
    if (apk) return { module: moduleName, path: join(apkDir, apk) };
  }
  return null;
}

function findApplicationId(exec: RuntimeExec, workspace: string, moduleName: string): string | null {
  for (const file of ["build.gradle.kts", "build.gradle"]) {
    const text = exec.readText(join(workspace, moduleName, file));
    const match = text ? /applicationId\s*=?\s*["']([A-Za-z0-9_.]+)["']/.exec(text) : null;
    if (match?.[1]) return match[1];
  }
  return null;
}
