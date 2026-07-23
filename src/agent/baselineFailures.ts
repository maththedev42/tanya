// Baseline-aware verification (Go-first).
//
// The observed stall shape: an agent ran a broad `go test ./internal/...`
// whose only failures were in a package it never touched — a pre-existing red
// test unrelated to its task (cosmohq-v3 `internal/store/apple`, broken by an
// earlier unrelated commit that never updated its test mock). The agent had no
// way to tell "this is not my fault" from "I broke something", so it ground on
// the broad command until the stall detector stopped it.
//
// This module supplies the pure analysis both the early nudge (runner.ts) and
// the finalize-time reclassification (report.ts) share: which packages failed,
// which of those the run actually touched, and whether ALL failures are
// therefore someone else's problem. Deliberately Go-only this round — other
// ecosystems are out of scope (see BETA15_TASK_RELIABILITY_PLAN.md).

// `go test` prints one `FAIL\t<import-path>\t<elapsed>` (or `FAIL\t<import-path>
// [build failed]`) line per failing package, on its own line starting exactly
// with "FAIL" followed by whitespace and the package path. The bare summary
// line "FAIL" (no trailing content, printed once per failing package's test
// block) does NOT match — it has nothing after it on the line — so it can't be
// mistaken for a package name. `--- FAIL: TestName` lines don't start with
// "FAIL" either (they start with "---"), so individual failing tests are never
// counted as packages.
// [ \t]+ (not \s+) deliberately: \s also matches the newline itself, which
// would let the bare "FAIL" summary line's match bridge across the line break
// and swallow the START of the NEXT line's "FAIL\t<pkg>" as if it were the
// captured package name.
const GO_TEST_FAIL_LINE = /^FAIL[ \t]+(\S+)/gm;

/** Failing package import paths from `go test` output (stdout+stderr combined). */
export function parseGoTestFailures(output: string): string[] {
  const packages = new Set<string>();
  for (const match of output.matchAll(GO_TEST_FAIL_LINE)) {
    const pkg = match[1];
    if (pkg) packages.add(pkg);
  }
  return [...packages];
}

/** A `go test` command whose package selector contains Go's `...` wildcard —
 *  the broad "everything under this tree" shape, as opposed to a command
 *  already scoped to specific packages. */
export function isBroadGoTestCommand(script: string): boolean {
  let s = script.trim();
  const cdPrefix = s.match(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/);
  if (cdPrefix) s = s.slice(cdPrefix[0].length).trim();
  if (!/(?:^|[\s;&|])go\s+test\b/.test(s)) return false;
  return s.includes("...");
}

/** Directories of changed `.go` files, workspace-relative (e.g.
 *  `api/internal/coding/store.go` -> `api/internal/coding`). These are matched
 *  by SUFFIX against `go test`'s full module import paths — cheaper and more
 *  robust than resolving the module prefix from go.mod. */
export function packagesTouchedByRun(changedFiles: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of changedFiles) {
    if (!file.endsWith(".go")) continue;
    const slash = file.lastIndexOf("/");
    if (slash === -1) continue; // a .go file at the workspace root has no
    // meaningful package-path suffix to match against; skip rather than guess.
    dirs.add(file.slice(0, slash));
  }
  return [...dirs];
}

function packageMatchesTouchedDir(pkg: string, dir: string): boolean {
  return pkg === dir || pkg.endsWith(`/${dir}`);
}

/** Failing packages that this run's changed files did NOT touch. */
export function untouchedFailingPackages(failing: string[], touchedDirs: string[]): string[] {
  return failing.filter((pkg) => !touchedDirs.some((dir) => packageMatchesTouchedDir(pkg, dir)));
}

/** True only when EVERY failing package is untouched by this run — the strict
 *  containment the reclassification gate requires. A single touched failure
 *  keeps the whole blocker (see BETA15 plan: "any failing package intersects
 *  the touched set" -> never reclassify). */
export function allFailingPackagesUntouched(failing: string[], touchedDirs: string[]): boolean {
  return failing.length > 0 && untouchedFailingPackages(failing, touchedDirs).length === failing.length;
}
