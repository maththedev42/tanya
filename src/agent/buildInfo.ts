// Build identity + stale-binary detection.
//
// A `tanya serve --stdio` process is long-lived: it can resume a session for
// hours or days. npm-link swaps `dist/` under a stable path on every upgrade,
// but an already-loaded Node process never re-reads it — so a serve process
// started before an upgrade keeps executing the OLD code indefinitely, gates
// included. The morning after beta.9/10 shipped, exactly this happened. This
// module lets a running process notice it.
//
// How: tsup compiles a fresh build id + timestamp INTO the bundle at build time
// (the `__TANYA_*__` tokens, replaced via `define` in tsup.config.ts) and writes
// the same values to a sidecar `dist/BUILD_ID.json` (onSuccess). The compiled-in
// id is "what code am I running"; the sidecar, read fresh off disk, is "what
// code is on disk now". A mismatch means dist/ was rebuilt under this process.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Replaced textually by tsup's esbuild `define` at build time. Under tsx (dev)
// and vitest they are genuinely undefined; `typeof` guards avoid a
// ReferenceError and we report the dev sentinel.
declare const __TANYA_BUILD_ID__: string | undefined;
declare const __TANYA_BUILT_AT__: string | undefined;
declare const __TANYA_VERSION__: string | undefined;

export const DEV_BUILD_ID = "dev";

export const RUNNING_BUILD_ID: string =
  typeof __TANYA_BUILD_ID__ !== "undefined" ? __TANYA_BUILD_ID__ : DEV_BUILD_ID;

export const RUNNING_BUILT_AT: string | undefined =
  typeof __TANYA_BUILT_AT__ !== "undefined" ? __TANYA_BUILT_AT__ : undefined;

function readVersionFromPackage(): string {
  try {
    // Dev only (bundled builds get __TANYA_VERSION__): src/agent/buildInfo.ts
    // → ../../package.json.
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const RUNNING_VERSION: string =
  typeof __TANYA_VERSION__ !== "undefined" ? __TANYA_VERSION__ : readVersionFromPackage();

export type OnDiskBuild = { buildId?: string; builtAt?: string; version?: string };

/** The build identity written next to the compiled bundle. A serve process
 *  reads this FRESH off disk to see whether dist/ was rebuilt under it since it
 *  started. Returns null in dev (no sidecar) or on any error. */
export function readOnDiskBuild(): OnDiskBuild | null {
  try {
    // The compiled bundle (or a split chunk) lives in dist/, alongside the
    // sidecar the build wrote.
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(join(here, "BUILD_ID.json"), "utf8")) as OnDiskBuild;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Pure comparison so callers can test the staleness logic without a real
 *  build. A dev build (or a missing/id-less sidecar) is never stale — there is
 *  nothing meaningful to compare. */
export function computeStale(runningBuildId: string, onDisk: OnDiskBuild | null): boolean {
  if (runningBuildId === DEV_BUILD_ID || !onDisk || !onDisk.buildId) return false;
  return onDisk.buildId !== runningBuildId;
}

export type StaleBinaryStatus = {
  stale: boolean;
  running: { buildId: string; builtAt?: string; version: string };
  onDisk: OnDiskBuild | null;
};

/** Is this running process older than the build now on disk? */
export function detectStaleBinary(): StaleBinaryStatus {
  const onDisk = readOnDiskBuild();
  return {
    stale: computeStale(RUNNING_BUILD_ID, onDisk),
    running: {
      buildId: RUNNING_BUILD_ID,
      ...(RUNNING_BUILT_AT ? { builtAt: RUNNING_BUILT_AT } : {}),
      version: RUNNING_VERSION,
    },
    onDisk,
  };
}

/** One-line, prominent human warning for a stale serve process — or null when
 *  the process is current (dev included). */
export function staleBinaryWarning(status: StaleBinaryStatus = detectStaleBinary()): string | null {
  if (!status.stale) return null;
  const diskVersion = status.onDisk?.version ?? "unknown";
  return (
    `⚠ Tanya was upgraded on disk — this serve process still runs ${status.running.version} ` +
    `(build ${status.running.buildId}); disk has ${diskVersion} (build ${status.onDisk?.buildId ?? "unknown"}). ` +
    `Restart this session to pick up the newer code (gate fixes included).`
  );
}
