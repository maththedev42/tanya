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
  type RuntimeExec,
} from "../types";
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
import { describeExit, logTailExcerpt } from "./backend";

const SWIFT_BUILD_TIMEOUT_MS = 240_000;

function isSwiftPmOnly(exec: RuntimeExec, workspace: string): boolean {
  if (!exec.fileExists(join(workspace, "Package.swift"))) return false;
  if (exec.fileExists(join(workspace, "project.yml"))) return false;
  return !exec.listDir(workspace).some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
}

export const macosAdapter: BootAdapter = {
  platform: "macos",
  capabilityProbe: async (ctx) => {
    if (isSwiftPmOnly(ctx.exec, ctx.workspace)) {
      const swift = await ctx.exec.run(ctx.workspace, "swift", ["--version"], { timeoutMs: 30_000 });
      if (swift.binaryMissing || swift.exit !== 0) {
        return { ok: false, reason: "Swift toolchain is not installed on this host" };
      }
      return { ok: true };
    }
    const xcode = await ctx.exec.run(ctx.workspace, "xcodebuild", ["-version"], { timeoutMs: 30_000 });
    if (xcode.binaryMissing || xcode.exit !== 0) {
      return { ok: false, reason: "Xcode is not installed on this host" };
    }
    const xcodegenGap = await xcodegenCapabilityGap(ctx);
    if (xcodegenGap) return { ok: false, reason: xcodegenGap };
    return { ok: true };
  },
  boot: bootMacos,
};

async function bootMacos(ctx: RuntimeContext): Promise<BootVerdict> {
  if (isSwiftPmOnly(ctx.exec, ctx.workspace)) return bootSwiftPm(ctx);
  return bootXcodeApp(ctx);
}

// SwiftPM executables: `swift build` then `swift run --skip-build` of the
// default executable. A CLI-style tool may exit 0 quickly with output — that
// is a booted surface; nonzero exit is a crash.
async function bootSwiftPm(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "macos", reason, failedCheck, checks, evidence });

  ctx.emit("swift build");
  const build = await exec.run(workspace, "swift", ["build"], { timeoutMs: SWIFT_BUILD_TIMEOUT_MS });
  if (build.exit !== 0) {
    const excerpt = logTailExcerpt(`${build.stdout}\n${build.stderr}`);
    evidence.push(makeEvidence("log", { excerpt }));
    checks.push(makeBootCheck({ id: "runtime-provision", description: "swift build", passed: false, detail: excerpt }));
    return fail(build.timedOut ? "timeout" : "provision-failed", "swift build failed");
  }
  checks.push(makeBootCheck({ id: "runtime-provision", description: "swift build", passed: true }));

  const bootLogPath = join(ctx.evidenceDir, "boot.log");
  ctx.emit("swift run --skip-build");
  const handle = await exec.launch({
    command: "swift",
    args: ["run", "--skip-build"],
    cwd: workspace,
    logPath: bootLogPath,
  });
  try {
    const exited = await handle.waitExit(ctx.warmupMs);
    const output = handle.logTail();
    evidence.push(makeEvidence("log", { path: bootLogPath, excerpt: logTailExcerpt(output) }));
    if (exited) {
      const info = handle.exit();
      if (info?.code === 0 && output.trim().length > 0) {
        checks.push(makeBootCheck({ id: "runtime-launch", description: "swift run", passed: true }));
        checks.push(makeBootCheck({ id: "runtime-alive", description: "exited cleanly (code 0)", passed: true }));
        checks.push(makeBootCheck({ id: "runtime-surface", description: "produced non-empty output", passed: true }));
        return makeBootVerdict({
          status: "pass",
          platform: "macos",
          reason: "executable ran to completion: exit 0 with output",
          checks,
          evidence,
        });
      }
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: "swift run", passed: false, detail: describeExit(handle) }),
      );
      return fail("crash", `executable exited during the ${ctx.warmupMs}ms warmup (${describeExit(handle)})`);
    }
    checks.push(makeBootCheck({ id: "runtime-launch", description: "swift run", passed: true, detail: `pid ${handle.pid}` }));
    checks.push(makeBootCheck({ id: "runtime-alive", description: `alive after ${ctx.warmupMs}ms warmup`, passed: true }));
    return makeBootVerdict({
      status: "pass",
      platform: "macos",
      reason: `executable stayed alive through ${ctx.warmupMs}ms warmup`,
      checks,
      evidence,
    });
  } finally {
    if (ctx.keepAlive) ctx.emit(`keep-alive: executable left running (pid ${handle.pid})`);
    else await handle.killTree();
  }
}

// Xcode .app lane: build Debug for macOS, spawn the bundle executable directly
// (never `open -a` — we need the pid and stdout), watch warmup + crash reports.
async function bootXcodeApp(ctx: RuntimeContext): Promise<BootVerdict> {
  const { exec, workspace } = ctx;
  const checks: BootCheckResult[] = [];
  const evidence: BootEvidence[] = [];
  const fail = (failedCheck: BootFailureKind, reason: string): BootVerdict =>
    makeBootVerdict({ status: "fail", platform: "macos", reason, failedCheck, checks, evidence });

  const xcodegen = await runXcodegenIfNeeded(ctx);
  if (!xcodegen.ok) {
    checks.push(makeBootCheck({ id: "runtime-provision", description: "xcodegen generate", passed: false, detail: xcodegen.detail }));
    return fail("provision-failed", "xcodegen generate failed");
  }
  const container = xcodeContainerArgs(exec, workspace);
  if (!container) return fail("provision-failed", "no .xcodeproj or .xcworkspace in this workspace");
  const scheme = await firstScheme(ctx, container);
  if (!scheme) return fail("provision-failed", "could not list a build scheme (xcodebuild -list -json)");

  // Shared per-workspace build cache — same rationale as the iOS adapter.
  const derivedDataPath = join(workspace, ".tanya", "runtime", "DerivedData");
  ctx.emit(`xcodebuild -scheme ${scheme} (macOS)`);
  const build = await exec.run(
    workspace,
    "xcodebuild",
    [...container, "-scheme", scheme, "-configuration", "Debug", "-destination", "platform=macOS", "-derivedDataPath", derivedDataPath, "-quiet", "build"],
    { timeoutMs: XCODEBUILD_TIMEOUT_MS },
  );
  if (build.exit !== 0) {
    const excerpt = logTailExcerpt(`${build.stdout}\n${build.stderr}`);
    evidence.push(makeEvidence("log", { excerpt }));
    checks.push(makeBootCheck({ id: "runtime-provision", description: `xcodebuild -scheme ${scheme}`, passed: false, detail: excerpt }));
    return fail(build.timedOut ? "timeout" : "provision-failed", "xcodebuild failed");
  }
  const appBundle = findAppBundle(exec, join(derivedDataPath, "Build", "Products", "Debug"));
  if (!appBundle) return fail("provision-failed", "build succeeded but no .app bundle was produced");
  checks.push(makeBootCheck({ id: "runtime-provision", description: `xcodebuild -scheme ${scheme}`, passed: true, detail: appBundle }));

  const executableName =
    (await readPlistKey(ctx, join(appBundle, "Contents", "Info.plist"), "CFBundleExecutable")) ??
    basename(appBundle).replace(/\.app$/, "");
  const appName = basename(appBundle).replace(/\.app$/, "");
  const bootLogPath = join(ctx.evidenceDir, "boot.log");
  const launchStart = exec.now();
  ctx.emit(`launching ${appName}.app`);
  const handle = await exec.launch({
    command: join(appBundle, "Contents", "MacOS", executableName),
    args: [],
    cwd: workspace,
    logPath: bootLogPath,
  });
  try {
    const exited = await handle.waitExit(ctx.warmupMs);
    if (exited || !handle.alive()) {
      evidence.push(makeEvidence("log", { path: bootLogPath, excerpt: logTailExcerpt(handle.logTail()) }));
      checks.push(
        makeBootCheck({ id: "runtime-launch", description: `${appName}.app started`, passed: false, detail: describeExit(handle) }),
      );
      return fail("crash", `app exited during the ${ctx.warmupMs}ms warmup (${describeExit(handle)})`);
    }
    checks.push(makeBootCheck({ id: "runtime-launch", description: `${appName}.app started`, passed: true, detail: `pid ${handle.pid}` }));

    const crashes = newCrashReports(exec, appName, launchStart);
    if (crashes.length > 0) {
      const crashPath = crashes[0] as string;
      evidence.push(makeEvidence("crashlog", { path: crashPath, excerpt: (exec.readText(crashPath) ?? "").slice(0, 1_200) }));
      checks.push(
        makeBootCheck({ id: "runtime-alive", description: `no crash during ${ctx.warmupMs}ms warmup`, passed: false, detail: crashPath }),
      );
      return fail("crash", `${appName} produced a crash report during the ${ctx.warmupMs}ms warmup`);
    }
    checks.push(makeBootCheck({ id: "runtime-alive", description: `no crash during ${ctx.warmupMs}ms warmup`, passed: true }));

    // Whole-screen capture needs the Screen Recording permission and cannot be
    // attributed to the app alone — evidence only, never a gate.
    const shotPath = join(ctx.evidenceDir, "screen.png");
    const shot = await exec.run(workspace, "screencapture", ["-x", shotPath], { timeoutMs: 15_000 });
    if (shot.exit === 0 && exec.fileExists(shotPath)) {
      evidence.push(makeEvidence("screenshot", { path: shotPath, excerpt: "full-screen capture (best-effort)" }));
      checks.push(makeBootCheck({ id: "runtime-surface", description: "screen capture", passed: true, detail: "best-effort evidence" }));
    } else {
      checks.push(
        makeBootCheck({ id: "runtime-surface", description: "screen capture", passed: true, skipped: true, detail: "screencapture unavailable (Screen Recording permission?) — evidence skipped" }),
      );
    }

    return makeBootVerdict({
      status: "pass",
      platform: "macos",
      reason: `${appName}.app launched and stayed alive through ${ctx.warmupMs}ms warmup with no crash`,
      checks,
      evidence,
    });
  } finally {
    if (ctx.keepAlive) ctx.emit(`keep-alive: ${appName}.app left running (pid ${handle.pid})`);
    else await handle.killTree();
  }
}
