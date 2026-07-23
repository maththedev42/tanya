import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// System-level build hygiene. Distinct from clean.ts (which prunes <workspace>/.tanya):
// this reclaims the OS-wide build scratch that repeated iOS/Android builds pile up
// OUTSIDE the workspace — Xcode DerivedData and lingering Gradle/Kotlin daemons — the
// things that silently fill the disk to 100% across a long agent run and leave build
// daemons holding memory for hours after Tanya exits.
//
// Two behaviors:
//   • ensureBuildDiskHeadroom() — a throttled preflight before each heavy build:
//     if free space is low, reclaim SAFE regenerable caches (stale DerivedData +
//     unavailable simulators). Never wipes a DerivedData dir touched recently, so a
//     concurrent/parallel build writing it is not broken.
//   • reapBuildDaemons() — stop the Gradle + Kotlin daemons a run spawned, so they
//     don't linger (idle 2–3h by default) after Tanya finishes or is interrupted.
//
// Both are best-effort, macOS/Linux only, and each is independently opt-out via env.

const DERIVED_DATA = join(homedir(), "Library", "Developer", "Xcode", "DerivedData");
const DEFAULT_THRESHOLD_GB = 20;
// Never touch a DerivedData dir written this recently — it may belong to the build
// about to run or a sibling parallel build still writing it.
const DERIVED_STALE_MS = 20 * 60 * 1000;
// Don't re-check `df` on every verifier command; a build loop fires many per minute.
const CHECK_THROTTLE_MS = 60 * 1000;

// The daemon main-class markers, specific enough not to match unrelated JVMs.
const GRADLE_DAEMON = "org.gradle.launcher.daemon.bootstrap.GradleDaemon";
const KOTLIN_DAEMON = "org.jetbrains.kotlin.daemon.KotlinCompileDaemon";

let lastCheckAt = 0;

function envDisabled(name: string): boolean {
  return /^(0|false|off|no)$/i.test((process.env[name] ?? "").trim());
}

function note(message: string): void {
  process.stderr.write(`[tanya] ${message}\n`);
}

// Available space (GB) on the volume backing `path`. `df -Pk` is POSIX-portable
// across macOS/Linux: column 4 is available 1K-blocks. Returns null if unreadable.
export function freeDiskGb(path: string): number | null {
  if (process.platform === "win32") return null;
  try {
    const out = spawnSync("df", ["-Pk", path], { encoding: "utf8", timeout: 5_000 });
    if (out.status !== 0 || !out.stdout) return null;
    const line = out.stdout.trim().split("\n").at(-1) ?? "";
    const availKb = Number(line.split(/\s+/)[3]);
    return Number.isFinite(availKb) ? availKb / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

// A command whose run produces heavy build output worth guarding first.
export function isHeavyBuildCommand(command: string, args: readonly string[]): boolean {
  const cmd = command.toLowerCase();
  if (cmd.includes("xcodebuild")) return true;
  if (cmd.includes("gradlew") || cmd.endsWith("gradle")) return true;
  // xcrun xcodebuild …, or a gradle wrapper invoked via a shell.
  return args.some((a) => /xcodebuild|assembledebug|assemblerelease|bundle\w*|:app:/i.test(a));
}

function dirBytes(path: string): number {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return stats.size;
    let total = 0;
    for (const name of readdirSync(path)) total += dirBytes(join(path, name));
    return total;
  } catch {
    return 0;
  }
}

// Delete DerivedData subdirs not modified in the last DERIVED_STALE_MS, plus drop
// simulators on deleted runtimes. Everything here regenerates on the next build.
function reclaimSafeCaches(now: number): number {
  let freed = 0;
  if (existsSync(DERIVED_DATA)) {
    for (const name of readdirSync(DERIVED_DATA)) {
      const path = join(DERIVED_DATA, name);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime < DERIVED_STALE_MS) continue; // fresh — may be an active build
      const bytes = dirBytes(path);
      try {
        rmSync(path, { recursive: true, force: true });
        freed += bytes;
      } catch {
        // Best-effort; a locked dir just stays.
      }
    }
  }
  try {
    spawnSync("xcrun", ["simctl", "delete", "unavailable"], { timeout: 60_000, stdio: "ignore" });
  } catch {
    // simctl absent (non-Xcode host) — nothing to reclaim there.
  }
  return freed;
}

// Preflight run before a heavy build. Throttled so a build loop doesn't re-stat the
// volume every command. Only reclaims when genuinely low. Set TANYA_DISK_GUARD=0 to
// disable, TANYA_DISK_MIN_GB=<n> to change the threshold (default 20).
export function ensureBuildDiskHeadroom(workspace: string, now = Date.now()): void {
  if (envDisabled("TANYA_DISK_GUARD")) return;
  if (now - lastCheckAt < CHECK_THROTTLE_MS) return;
  lastCheckAt = now;

  const free = freeDiskGb(workspace);
  if (free === null) return;
  const thresholdRaw = Number(process.env.TANYA_DISK_MIN_GB);
  const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : DEFAULT_THRESHOLD_GB;
  if (free >= threshold) return;

  note(`disk low (${free.toFixed(1)}G free < ${threshold}G) — reclaiming stale build caches before build`);
  const freed = reclaimSafeCaches(now);
  const after = freeDiskGb(workspace);
  const freedGb = (freed / (1024 * 1024 * 1024)).toFixed(1);
  note(
    `reclaimed ~${freedGb}G of stale DerivedData/simulators` +
      (after !== null ? ` (${after.toFixed(1)}G free now)` : "") +
      ` (TANYA_DISK_GUARD=0 to disable)`,
  );
}

// Stop the Gradle + Kotlin build daemons a run spawned so they don't linger holding
// memory (and re-triggering builds) after Tanya exits. Called on the post-run hook
// and on interrupt. Best-effort; set TANYA_REAP_DAEMONS=0 to disable (e.g. if you keep
// a Gradle daemon warm for a separate Android Studio session).
export function reapBuildDaemons(): string[] {
  if (process.platform === "win32" || envDisabled("TANYA_REAP_DAEMONS")) return [];
  const reaped: string[] = [];
  // Gradle traps SIGTERM, so it needs -9; the Kotlin daemon exits on TERM.
  const targets: Array<{ label: string; pattern: string; signal: string }> = [
    { label: "GradleDaemon", pattern: GRADLE_DAEMON, signal: "-9" },
    { label: "KotlinCompileDaemon", pattern: KOTLIN_DAEMON, signal: "-15" },
  ];
  for (const { label, pattern, signal } of targets) {
    try {
      const found = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8", timeout: 5_000 });
      if (found.status === 0 && found.stdout.trim()) {
        spawnSync("pkill", [signal, "-f", pattern], { timeout: 5_000, stdio: "ignore" });
        reaped.push(label);
      }
    } catch {
      // pgrep/pkill unavailable — nothing to reap.
    }
  }
  return reaped;
}

// Post-run / on-exit hygiene: reap the daemons and report what was stopped.
export function postRunBuildHygiene(): void {
  const reaped = reapBuildDaemons();
  if (reaped.length > 0) {
    note(`stopped lingering build daemon(s): ${reaped.join(", ")} (TANYA_REAP_DAEMONS=0 to disable)`);
  }
}
