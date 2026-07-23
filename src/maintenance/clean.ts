import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Retention for everything Tanya writes under <workspace>/.tanya that grows
// without bound: runtime boot evidence (the heavy one — videos, screenshots,
// per-run DerivedData copies measured at ~80MB each), run logs, and chat
// sessions. Exposed two ways: the `tanya clean` command (explicit, supports
// --dry-run) and a silent best-effort sweep after runs/test-app.

export type CleanSection = "runtime" | "runs" | "sessions";

export type CleanOptions = {
  // Delete entries last touched before now - olderThanMs.
  olderThanMs: number;
  // Always keep the newest N runtime evidence dirs regardless of age.
  runtimeKeep?: number;
  // Restrict the sweep to specific sections (default: all three).
  only?: ReadonlyArray<CleanSection>;
  dryRun?: boolean;
  now?: number;
};

export type CleanedEntry = { path: string; bytes: number };

export type CleanReport = {
  runtime: CleanedEntry[];
  runs: CleanedEntry[];
  sessions: CleanedEntry[];
  freedBytes: number;
};

const DEFAULT_RUNTIME_KEEP = 3;

// Silent post-run retention defaults: aggressive on the heavy evidence dirs,
// generous on the small text records people may want to resume or audit.
export const AUTO_CLEAN_RUNTIME_MS = 14 * 24 * 60 * 60 * 1000; // 14d
export const AUTO_CLEAN_RECORDS_MS = 60 * 24 * 60 * 60 * 1000; // 60d

function entrySize(path: string): number {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return stats.size;
    let total = 0;
    for (const name of readdirSync(path)) total += entrySize(join(path, name));
    return total;
  } catch {
    return 0;
  }
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function removeEntry(tanyaRoot: string, path: string, dryRun: boolean): CleanedEntry | null {
  // Structural guard: never delete anything that does not live strictly
  // inside this workspace's .tanya directory.
  if (!resolve(path).startsWith(resolve(tanyaRoot) + sep)) return null;
  const bytes = entrySize(path);
  if (!dryRun) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      return null;
    }
  }
  return { path, bytes };
}

export function cleanTanyaDir(workspace: string, options: CleanOptions): CleanReport {
  const report: CleanReport = { runtime: [], runs: [], sessions: [], freedBytes: 0 };
  const tanyaRoot = join(workspace, ".tanya");
  if (!existsSync(tanyaRoot)) return report;
  const now = options.now ?? Date.now();
  const cutoff = now - options.olderThanMs;
  const dryRun = options.dryRun ?? false;
  const runtimeKeep = options.runtimeKeep ?? DEFAULT_RUNTIME_KEEP;
  const sections = options.only ?? ["runtime", "runs", "sessions"];

  // ── runtime evidence: boot-* dirs, newest N always kept ──
  const runtimeDir = join(tanyaRoot, "runtime");
  if (sections.includes("runtime") && existsSync(runtimeDir)) {
    const bootDirs = readdirSync(runtimeDir)
      .filter((name) => name.startsWith("boot-"))
      .map((name) => join(runtimeDir, name))
      .sort((a, b) => mtimeMs(b) - mtimeMs(a));
    for (const dir of bootDirs.slice(runtimeKeep)) {
      if (mtimeMs(dir) >= cutoff) continue;
      const cleaned = removeEntry(tanyaRoot, dir, dryRun);
      if (cleaned) report.runtime.push(cleaned);
    }
    // The shared DerivedData build cache ages out too: an actively tested
    // project rebuilds it (fresh mtime); an abandoned one reclaims the space.
    const derivedData = join(runtimeDir, "DerivedData");
    if (existsSync(derivedData) && mtimeMs(derivedData) < cutoff) {
      const cleaned = removeEntry(tanyaRoot, derivedData, dryRun);
      if (cleaned) report.runtime.push(cleaned);
    }
  }

  // ── run logs: r-*.json + their sidecar dirs ──
  const runsDir = join(tanyaRoot, "runs");
  if (sections.includes("runs") && existsSync(runsDir)) {
    for (const name of readdirSync(runsDir)) {
      const path = join(runsDir, name);
      if (mtimeMs(path) >= cutoff) continue;
      const cleaned = removeEntry(tanyaRoot, path, dryRun);
      if (cleaned) report.runs.push(cleaned);
    }
  }

  // ── chat sessions ──
  const sessionsDir = join(tanyaRoot, "sessions");
  if (sections.includes("sessions") && existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(sessionsDir, name);
      if (mtimeMs(path) >= cutoff) continue;
      const cleaned = removeEntry(tanyaRoot, path, dryRun);
      if (cleaned) report.sessions.push(cleaned);
    }
  }

  report.freedBytes = [...report.runtime, ...report.runs, ...report.sessions].reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  return report;
}

// Best-effort retention sweep after a run or test-app: heavy runtime evidence
// at 14 days (always keeping the newest 3), small text records at 60 days.
// TANYA_AUTO_CLEAN=0 disables it.
export function autoCleanTanyaDir(workspace: string, now = Date.now()): CleanReport | null {
  if (/^(0|false|off|no)$/i.test((process.env.TANYA_AUTO_CLEAN ?? "").trim())) return null;
  try {
    const heavy = cleanTanyaDir(workspace, { olderThanMs: AUTO_CLEAN_RUNTIME_MS, only: ["runtime"], now });
    const records = cleanTanyaDir(workspace, { olderThanMs: AUTO_CLEAN_RECORDS_MS, only: ["runs", "sessions"], now });
    return {
      runtime: heavy.runtime,
      runs: records.runs,
      sessions: records.sessions,
      freedBytes: heavy.freedBytes + records.freedBytes,
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
