import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoCleanTanyaDir, cleanTanyaDir, formatBytes } from "../../src/maintenance/clean";

const DAY = 24 * 60 * 60 * 1000;

function touch(path: string, ageMs: number, now: number, content = "x"): void {
  writeFileSync(path, content);
  const seconds = (now - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

function makeBootDir(runtimeDir: string, name: string, ageMs: number, now: number): string {
  const dir = join(runtimeDir, name);
  mkdirSync(dir, { recursive: true });
  touch(join(dir, "boot.mp4"), ageMs, now, "video-bytes-here");
  const seconds = (now - ageMs) / 1000;
  utimesSync(dir, seconds, seconds);
  return dir;
}

function workspaceFixture(now: number): { workspace: string; runtimeDir: string; runsDir: string; sessionsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), "tanya-clean-"));
  const runtimeDir = join(workspace, ".tanya", "runtime");
  const runsDir = join(workspace, ".tanya", "runs");
  const sessionsDir = join(workspace, ".tanya", "sessions");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  // 5 boot dirs: 2 fresh, 3 old.
  makeBootDir(runtimeDir, "boot-new-1", 1 * DAY, now);
  makeBootDir(runtimeDir, "boot-new-2", 2 * DAY, now);
  makeBootDir(runtimeDir, "boot-old-1", 40 * DAY, now);
  makeBootDir(runtimeDir, "boot-old-2", 50 * DAY, now);
  makeBootDir(runtimeDir, "boot-old-3", 60 * DAY, now);
  touch(join(runsDir, "r-old.json"), 90 * DAY, now);
  touch(join(runsDir, "r-new.json"), 1 * DAY, now);
  touch(join(sessionsDir, "20260101-old.json"), 90 * DAY, now);
  touch(join(sessionsDir, "20260610-new.json"), 1 * DAY, now);
  return { workspace, runtimeDir, runsDir, sessionsDir };
}

describe("cleanTanyaDir", () => {
  const now = Date.UTC(2026, 5, 11);

  it("deletes old entries but always keeps the newest runtime dirs", () => {
    const { workspace, runtimeDir, runsDir, sessionsDir } = workspaceFixture(now);
    const report = cleanTanyaDir(workspace, { olderThanMs: 30 * DAY, runtimeKeep: 3, now });
    // 5 boot dirs, keep newest 3 → boot-old-2 and boot-old-3 deleted.
    expect(report.runtime.map((e) => e.path).sort()).toEqual([
      join(runtimeDir, "boot-old-2"),
      join(runtimeDir, "boot-old-3"),
    ]);
    expect(existsSync(join(runtimeDir, "boot-old-1"))).toBe(true); // protected by keep-3
    expect(report.runs.map((e) => e.path)).toEqual([join(runsDir, "r-old.json")]);
    expect(report.sessions.map((e) => e.path)).toEqual([join(sessionsDir, "20260101-old.json")]);
    expect(existsSync(join(runsDir, "r-new.json"))).toBe(true);
    expect(existsSync(join(sessionsDir, "20260610-new.json"))).toBe(true);
    expect(report.freedBytes).toBeGreaterThan(0);
  });

  it("dry-run reports without deleting", () => {
    const { workspace, runtimeDir } = workspaceFixture(now);
    const report = cleanTanyaDir(workspace, { olderThanMs: 30 * DAY, runtimeKeep: 3, dryRun: true, now });
    expect(report.runtime).toHaveLength(2);
    expect(existsSync(join(runtimeDir, "boot-old-3"))).toBe(true);
  });

  it("respects the section filter", () => {
    const { workspace, runtimeDir } = workspaceFixture(now);
    const report = cleanTanyaDir(workspace, { olderThanMs: 30 * DAY, runtimeKeep: 0, only: ["runs"], now });
    expect(report.runtime).toHaveLength(0);
    expect(report.sessions).toHaveLength(0);
    expect(report.runs).toHaveLength(1);
    expect(existsSync(join(runtimeDir, "boot-old-3"))).toBe(true);
  });

  it("is a no-op without a .tanya dir", () => {
    const workspace = mkdtempSync(join(tmpdir(), "tanya-clean-empty-"));
    const report = cleanTanyaDir(workspace, { olderThanMs: DAY, now });
    expect(report.freedBytes).toBe(0);
  });
});

describe("autoCleanTanyaDir", () => {
  const now = Date.UTC(2026, 5, 11);

  it("uses the tight window for runtime evidence and the loose one for records", () => {
    const { workspace, runtimeDir, runsDir } = workspaceFixture(now);
    // 20-day-old run log: older than runtime window, younger than records window.
    touch(join(runsDir, "r-mid.json"), 20 * DAY, now);
    const report = autoCleanTanyaDir(workspace, now);
    expect(report).not.toBeNull();
    // runtime window (14d, keep 3): old-2 + old-3 go.
    expect(existsSync(join(runtimeDir, "boot-old-3"))).toBe(false);
    expect(existsSync(join(runtimeDir, "boot-old-1"))).toBe(true);
    // records window (60d): the 90d log goes, the 20d one stays.
    expect(existsSync(join(runsDir, "r-old.json"))).toBe(false);
    expect(existsSync(join(runsDir, "r-mid.json"))).toBe(true);
  });

  it("TANYA_AUTO_CLEAN=0 disables the sweep", () => {
    const { workspace, runtimeDir } = workspaceFixture(now);
    process.env.TANYA_AUTO_CLEAN = "0";
    try {
      expect(autoCleanTanyaDir(workspace, now)).toBeNull();
      expect(existsSync(join(runtimeDir, "boot-old-3"))).toBe(true);
    } finally {
      delete process.env.TANYA_AUTO_CLEAN;
    }
  });
});

describe("formatBytes", () => {
  it("picks sensible units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(80 * 1024 * 1024)).toBe("80.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});
