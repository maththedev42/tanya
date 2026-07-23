import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Clean-tree build: rebuild from the COMMITTED tree, not the dirty worktree.
// The working-tree build lies — it is green because an uncommitted/untracked
// file is present locally; a fresh checkout of that commit fails to compile
// (the shipped `GettingStartedView.swift` referencing an untracked
// `GettingStartedManager.swift`). We check the honest thing: `git worktree add`
// a detached checkout of HEAD into a temp dir, run the configured build there,
// and remove it. Never touches the user's working tree (no stash), so it is
// safe to run mid-session.
//
// Opt-in per repo (.tanya/clean-tree-build.json) because a full build is
// expensive — a daily driver should not pay it on every run unless the repo
// asks for it.

export type CleanTreeConfig = { command: string; trigger?: string; timeoutMs?: number; compileTests?: boolean };
export type WorktreeCommandResult = { ran: boolean; ok: boolean; output: string };
export type CleanTreeResult = WorktreeCommandResult;

export async function loadCleanTreeConfig(workspace: string): Promise<CleanTreeConfig | null> {
  try {
    const raw = await readFile(join(workspace, ".tanya", "clean-tree-build.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.command !== "string" || !parsed.command.trim()) return null;
    const config: CleanTreeConfig = { command: parsed.command };
    if (typeof parsed.trigger === "string") config.trigger = parsed.trigger;
    if (typeof parsed.timeoutMs === "number") config.timeoutMs = parsed.timeoutMs;
    if (typeof parsed.compileTests === "boolean") config.compileTests = parsed.compileTests;
    return config;
  } catch {
    return null;
  }
}

/**
 * Upgrade a build command so it COMPILES TEST TARGETS (without running them).
 * Plain `xcodebuild … build` / `go build ./…` compile only the product, so a
 * commit whose test target no longer compiles (a library signature changed, its
 * callers in the test target were not updated) passes an honest build and ships
 * broken — the CosmoKit FIX3 escape (`SimulatorDevice.init` gained a param, 7
 * test call sites stale). Compiling tests catches it; running them is a separate,
 * heavier concern we deliberately avoid here.
 */
export function upgradeToTestCompiling(command: string): string {
  const c = command.trim();
  // Already builds-for-testing or runs tests (xcodebuild test / go test / npm test).
  if (/\bbuild-for-testing\b/.test(c) || /\btest\b/.test(c)) return c;
  // Xcode: the standalone `build` action → `build-for-testing` (\bbuild\b does not
  // match inside the word "xcodebuild").
  if (/\bxcodebuild\b/.test(c) && /\bbuild\b/.test(c)) {
    return c.replace(/\bbuild\b/, "build-for-testing");
  }
  // Go: also compile every package's tests, running none (`-run '^$'`).
  if (/\bgo\s+build\b/.test(c)) {
    return `${c} && go test -run '^$' -count=1 ./...`;
  }
  return c;
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/` -> zero-or-more path segments
          i += 2;
        } else {
          re += ".*"; // `**` -> anything
          i += 1;
        }
      } else {
        re += "[^/]*"; // `*` -> within a segment
      }
    } else if (/[.*+?^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`(?:^|/)${re}$`);
}

export function cleanTreeTriggered(config: CleanTreeConfig, changedFiles: string[]): boolean {
  if (!config.trigger) return true;
  const re = globToRegExp(config.trigger);
  return changedFiles.some((f) => re.test(f));
}

/**
 * Run `command` against a throwaway DETACHED checkout of `head` (a fresh
 * `git worktree add`), returning what it printed. `ran: false` means the
 * worktree itself could not be created (git missing / bad head / bad sha) —
 * an INCONCLUSIVE environment failure, never a build/test result; callers must
 * treat that as "couldn't verify" rather than as either a pass or a fail, so a
 * broken environment never false-fails (or false-clears) a run. Always cleans
 * up the worktree, even on error. Shared by runCleanTreeBuild below and by the
 * baseline-aware verification finalize check (report.ts), which needed the
 * exact same "run a command at a historical commit without touching the live
 * working tree" primitive.
 */
export async function runCommandInDetachedWorktree(
  workspace: string,
  head: string,
  command: string,
  timeoutMs = 300_000,
): Promise<WorktreeCommandResult> {
  let worktreePath: string | null = null;
  try {
    const base = await mkdtemp(join(tmpdir(), "tanya-worktree-"));
    worktreePath = join(base, "wt");
    await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, head], {
      cwd: workspace,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    if (worktreePath) await cleanupWorktree(workspace, worktreePath);
    return { ran: false, ok: false, output: "" };
  }
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], {
      cwd: worktreePath,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ran: true, ok: true, output: tail(`${stdout}${stderr}`) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ran: true, ok: false, output: tail(`${err.stdout ?? ""}${err.stderr ?? ""}${err.stdout || err.stderr ? "" : err.message ?? ""}`) };
  } finally {
    await cleanupWorktree(workspace, worktreePath);
  }
}

/**
 * Build a detached checkout of `head` in a throwaway worktree. Returns
 * `{ ran, ok, output }`; the worktree is always cleaned up. `ran` is false if we
 * could not even create the worktree (git missing / bad head) — treated as
 * inconclusive, not a failure, so a broken environment never false-fails a run.
 */
export async function runCleanTreeBuild(workspace: string, head: string, config: CleanTreeConfig): Promise<CleanTreeResult> {
  // Compile test targets too (unless the repo opts out) — a build that skips
  // them is honest-but-blind to a test target that no longer compiles.
  const command = config.compileTests === false ? config.command : upgradeToTestCompiling(config.command);
  return runCommandInDetachedWorktree(workspace, head, command, config.timeoutMs ?? 300_000);
}

async function cleanupWorktree(workspace: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: workspace, timeout: 30_000 });
  } catch {
    // Fall back to a raw delete + prune if git refuses (e.g. the dir moved).
    try {
      await rm(worktreePath, { recursive: true, force: true });
      await execFileAsync("git", ["worktree", "prune"], { cwd: workspace, timeout: 15_000 });
    } catch {
      // Best effort; a stale worktree registration is harmless.
    }
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 2000 ? `…${trimmed.slice(-2000)}` : trimmed;
}
